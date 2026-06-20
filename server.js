require('dotenv').config();
const express   = require('express');
const twilio    = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const WebSocket        = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios     = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Validación de variables de entorno ──────────────────────────────────────
const REQUIRED_ENV = ['TWILIO_SID','TWILIO_TOKEN','GEMINI_API_KEY','SUPABASE_URL','SUPABASE_KEY'];
const _missingEnv  = REQUIRED_ENV.filter(k => !process.env[k]);
if (_missingEnv.length) {
  console.error('[FATAL] Missing env vars:', _missingEnv.join(', '));
  process.exit(1);
}

// ── Clientes ────────────────────────────────────────────────────────────────
const sb        = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: WebSocket }
});
const anthropic = process.env.ANTHROPIC_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }) : null;
const gemini    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const twl       = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const WA_FROM   = process.env.TWILIO_WHATSAPP_FROM;

// ── Helper: reintentar llamadas Gemini ante errores 503/429 ─────────────────
async function geminiWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message || '';
      const isRetryable = msg.includes('503') || msg.includes('429') ||
                          msg.includes('Service Unavailable') || msg.includes('overloaded');
      if (isRetryable && attempt < maxRetries) {
        // On 429, honor Gemini's suggested retryDelay (token bucket refill)
        // instead of the default exponential backoff which is too short
        let delay = (attempt + 1) * 2000;
        if (msg.includes('429')) {
          try {
            const retryInfo = (err.errorDetails || []).find(
              d => typeof d['@type'] === 'string' && d['@type'].includes('RetryInfo')
            );
            if (retryInfo?.retryDelay) {
              const secs = parseFloat(retryInfo.retryDelay);
              if (secs > 0) delay = Math.min((secs + 5) * 1000, 90_000);
            }
          } catch {}
        }
        console.warn(`[Gemini] ${err.message.slice(0,80)} — reintento ${attempt + 1}/${maxRetries} en ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ── Helper: enviar WhatsApp ──────────────────────────────────────────────────
async function enviarWhatsApp(to, body) {
  try {
    await twl.messages.create({ from: WA_FROM, to, body });
  } catch (e) {
    console.error('Error enviando WA:', e.message);
  }
}

// ── Helpers: formato y fechas ────────────────────────────────────────────────
const fmt       = n => '$' + Math.round(Math.abs(+n || 0)).toLocaleString('es-MX');
const hoy       = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const mesActual = () => hoy().slice(0, 7);

function getQuincena(fecha) {
  const d   = (fecha instanceof Date) ? fecha : new Date(fecha + 'T12:00:00');
  const day = d.getDate();
  const y   = d.getFullYear();
  const m   = d.getMonth(); // 0-indexed
  if (day >= 10 && day <= 24) {
    const mm = String(m + 1).padStart(2, '0');
    return { key: `${y}-${mm}-A`, inicio: `${y}-${mm}-10`, fin: `${y}-${mm}-24` };
  }
  if (day >= 25) {
    const mm  = String(m + 1).padStart(2, '0');
    const nm  = m === 11 ? 0 : m + 1;
    const ny  = m === 11 ? y + 1 : y;
    const nmm = String(nm + 1).padStart(2, '0');
    return { key: `${y}-${mm}-B`, inicio: `${y}-${mm}-25`, fin: `${ny}-${nmm}-09` };
  }
  // day 01-09 → quincena B del mes anterior
  const pm  = m === 0 ? 11 : m - 1;
  const py  = m === 0 ? y - 1 : y;
  const pmm = String(pm + 1).padStart(2, '0');
  const mm  = String(m + 1).padStart(2, '0');
  return { key: `${py}-${pmm}-B`, inicio: `${py}-${pmm}-25`, fin: `${y}-${mm}-09` };
}
const getQuincenaActual = () => getQuincena(hoy());

// Asserts de quincena — lanzan en startup si hay regresión
;[
  ['2026-06-15', '2026-06-A'], ['2026-06-10', '2026-06-A'], ['2026-06-24', '2026-06-A'],
  ['2026-06-05', '2026-05-B'], ['2026-01-03', '2025-12-B'],
  ['2026-06-25', '2026-06-B'], ['2026-06-30', '2026-06-B'],
].forEach(([f, k]) => {
  const got = getQuincena(f).key;
  if (got !== k) throw new Error(`getQuincena assert: ${f} → ${got} (esperado ${k})`);
});

// ── Compatibilidad con código existente ──────────────────────────────────────
const path    = require('path');
// Timestamp único por despliegue — cambia el nombre del caché del SW en cada Railway deploy
const DEPLOY_TS = Date.now().toString(36);

// sw.js con DEPLOY_TS inyectado — debe ir ANTES de express.static
// Esto garantiza que el browser detecte un SW nuevo en cada deploy y limpie el caché viejo
app.get('/sw.js', (_req, res) => {
  const fs = require('fs');
  const sw = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8')
               .replace(/DEPLOY_TS/g, DEPLOY_TS);
  res.set({
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Service-Worker-Allowed': '/',
  });
  res.send(sw);
});

// Versión actual — el cliente puede consultar esto para saber si hay actualización
app.get('/api/version', (_req, res) => {
  res.json({ v: DEPLOY_TS, ts: Date.now() });
});

// index.html sin caché (debe ir ANTES del static middleware)
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
const genAI   = gemini;      // alias — código legacy usa genAI
const mes     = mesActual;   // alias — código legacy usa mes()
const CATEGORIAS  = ['Hogar','Comida','TDC','Despensa','Hormiga','Ocio','Personales','Platina','Transporte','OTROS'];
const MEDIOS_PAGO = ['efectivo','TDC BBVA','TDC HEY','TDC Liverpool','TDC AMEX','TDC NU','TDC Rappi','TDC Palacio','transferencia','débito'];

// Corre `promise` pero si tarda más de `ms` devuelve `fallback` en lugar de colgar.
const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);

// ── Identificar usuario por número de teléfono ──────────────────────────────
async function identificarUsuario(phoneFrom) {
  let { data: usuario } = await sb
    .from('usuarios')
    .select('*')
    .eq('telefono', phoneFrom)
    .single();

  if (!usuario) {
    const esAngel = phoneFrom.includes(process.env.PHONE_ANGEL || 'XXXXX');
    const nuevoUsuario = {
      telefono:      phoneFrom,
      nombre:        esAngel ? 'Angel' : 'Usuario',
      role:          esAngel ? 'ADMIN_A' : 'USER_B',
      ai_preference: 'GEMINI',
      ai_model:      'gemini-2.5-flash',
    };
    const { data } = await sb.from('usuarios').insert(nuevoUsuario).select().single();
    return data || nuevoUsuario;
  }
  return usuario;
}

// ── Cargar contexto financiero completo del usuario ──────────────────────────
async function cargarContexto(userPhone, role) {
  const esAngel = role === 'ADMIN_A';
  const inicio  = mesActual() + '-01';

  const [
    { data: movs },
    { data: tdcs },
    { data: metasInd },
    { data: metasNidito },
    { data: presupuesto },
    { data: patrones },
  ] = await Promise.all([
    sb.from('movimientos').select('*').eq('user_phone', userPhone).gte('fecha', inicio).is('deleted_at', null).order('fecha', { ascending: false }).limit(30),
    esAngel ? sb.from('tdc').select('*').order('prioridad') : Promise.resolve({ data: [] }),
    sb.from('metas').select('*').eq('user_phone', userPhone).eq('tipo_meta', 'individual').is('deleted_at', null),
    sb.from('metas').select('*').eq('tipo_meta', 'nidito').is('deleted_at', null),
    sb.from('presupuesto').select('*').eq('user_phone', userPhone).eq('mes', mesActual()),
    sb.from('patrones_ia').select('*').eq('user_phone', userPhone).order('contador', { ascending: false }).limit(10),
  ]);

  return {
    movs:         movs || [],
    tdcs:         tdcs || [],
    metasInd:     metasInd || [],
    metasNidito:  metasNidito || [],
    presupuesto:  presupuesto || [],
    patrones:     patrones || [],
    gastosMes:    (movs || []).filter(m => m.tipo === 'GASTO').reduce((a, m) => a + (m.monto || 0), 0),
    ingresosMes:  (movs || []).filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + (m.monto || 0), 0),
  };
}

// ── Historial de conversación persistente en Supabase ───────────────────────
async function cargarHistorial(userPhone, limite = 20) {
  const { data } = await sb.from('historial_chat')
    .select('role, content')
    .eq('user_phone', userPhone)
    .order('created_at', { ascending: false })
    .limit(limite);
  return (data || []).reverse(); // orden cronológico ascendente
}

async function guardarMensaje(userPhone, role, content) {
  await sb.from('historial_chat').insert({ user_phone: userPhone, role, content });

  // Mantener solo los últimos 50 mensajes por usuario (limpieza automática)
  const { data: todos } = await sb.from('historial_chat')
    .select('id')
    .eq('user_phone', userPhone)
    .order('created_at', { ascending: true });

  if (todos && todos.length > 50) {
    const idsViejos = todos.slice(0, todos.length - 50).map(r => r.id);
    await sb.from('historial_chat').delete().in('id', idsViejos);
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────
async function writeAuditLog(phone, tabla, accion, registroId, datosBefore, datosAfter, origen = 'whatsapp', texto_original = null) {
  try {
    await sb.from('audit_log').insert({
      user_phone:    phone,
      tabla,
      accion,
      registro_id:   registroId != null ? String(registroId) : null,
      datos_antes:   datosBefore  || null,
      datos_despues: datosAfter   || null,
      origen,
      texto_original,
    });
  } catch (e) { console.error('audit_log write error:', e.message); }
}

// ── USAGE LOGGING ─────────────────────────────────────────────────────────────
const PRECIOS_IA = {
  'claude-haiku-4-5-20251001': { input: 1.00,  output:  5.00, cacheRead: 0.10 },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00, cacheRead: 0.30 },
  'gemini-2.5-flash':          { input: 0.15,  output:  0.60, cacheRead: 0    },
  'gemini-1.5-flash':          { input: 0.075, output:  0.30, cacheRead: 0    },
};

function logUsage(phone, modelo, usage, etapa) {
  if (!usage || !phone) return;
  const input_tokens       = usage.input_tokens       || usage.promptTokenCount           || 0;
  const output_tokens      = usage.output_tokens      || usage.candidatesTokenCount       || 0;
  const cache_read_tokens  = usage.cache_read_input_tokens || usage.cache_read_tokens     || 0;
  sb.from('usage_log').insert({ user_phone: phone, modelo, input_tokens, output_tokens, cache_read_tokens, etapa })
    .then(() => {}).catch(e => console.error('logUsage:', e.message));
}

// ── Acciones pendientes helpers ───────────────────────────────────────────────
async function getLastPendingAction(phone, estado = 'pending') {
  const { data } = await sb.from('acciones_pendientes')
    .select('*')
    .eq('user_phone', phone)
    .eq('estado', estado)
    .gt('expira_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function undoLastAction(phone) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: entry } = await sb.from('audit_log')
    .select('*')
    .eq('user_phone', phone)
    .neq('accion', 'undo')
    .gt('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!entry) return '❌ No hay acción reciente para deshacer (límite: 24h).';

  const now = new Date().toISOString();
  if (entry.accion === 'crear') {
    await sb.from(entry.tabla).update({ deleted_at: now }).eq('id', entry.registro_id);
    await writeAuditLog(phone, entry.tabla, 'undo', entry.registro_id, entry.datos_despues, null, 'undo');
  } else if (entry.accion === 'editar') {
    await sb.from(entry.tabla).update(entry.datos_antes).eq('id', entry.registro_id);
    await writeAuditLog(phone, entry.tabla, 'undo', entry.registro_id, entry.datos_despues, entry.datos_antes, 'undo');
  } else if (entry.accion === 'eliminar') {
    await sb.from(entry.tabla).update({ deleted_at: null }).eq('id', entry.registro_id);
    await writeAuditLog(phone, entry.tabla, 'undo', entry.registro_id, entry.datos_antes, null, 'undo');
  }
  return '↩️ Deshecho. El registro fue revertido.';
}

// ── BORRADO DE DATOS ─────────────────────────────────────────────────────────
async function ejecutarBorradoDatos(phone) {
  const now = new Date().toISOString();
  const purgeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  // Soft-delete tablas operativas
  await Promise.all([
    sb.from('movimientos').update({ deleted_at: now }).eq('user_phone', phone).is('deleted_at', null),
    sb.from('metas').update({ deleted_at: now }).eq('user_phone', phone).is('deleted_at', null),
    sb.from('calendario').update({ deleted_at: now }).eq('user_phone', phone).is('deleted_at', null),
    sb.from('nidito').update({ deleted_at: now }).eq('created_by', phone).is('deleted_at', null),
  ]);
  // Hard-delete tablas sin soft-delete
  await Promise.all([
    sb.from('tdc').delete().eq('user_phone', phone),
    sb.from('presupuesto').delete().eq('user_phone', phone),
    sb.from('patrones_ia').delete().eq('user_phone', phone),
    sb.from('despensa').delete().eq('user_phone', phone),
    sb.from('acciones_pendientes').update({ estado: 'cancelled' }).eq('user_phone', phone).eq('estado', 'pending'),
  ]);
  // Marcar usuario para purga en 30 días
  const { data: cur } = await sb.from('usuarios').select('external_refs').eq('telefono', phone).single();
  const refs = { ...(cur?.external_refs || {}), borrar_definitivo_at: purgeAt };
  await sb.from('usuarios').update({ external_refs: refs }).eq('telefono', phone);
  await writeAuditLog(phone, 'usuarios', 'eliminar', phone, cur?.external_refs, { borrar_definitivo_at: purgeAt }, 'whatsapp');
  return `🗑 Datos eliminados.\nPurga definitiva programada: *${purgeAt.split('T')[0]}*.\nEscribe *deshacer* en las próximas 24h si fue un error.`;
}

async function purgarDatosVencidos() {
  try {
    const now = new Date().toISOString();
    const { data: users } = await sb.from('usuarios').select('telefono, external_refs');
    for (const u of (users || [])) {
      const purgeAt = u.external_refs?.borrar_definitivo_at;
      if (!purgeAt || purgeAt > now) continue;
      const p = u.telefono;
      await Promise.all([
        sb.from('movimientos').delete().eq('user_phone', p).not('deleted_at', 'is', null),
        sb.from('metas').delete().eq('user_phone', p).not('deleted_at', 'is', null),
        sb.from('calendario').delete().eq('user_phone', p).not('deleted_at', 'is', null),
        sb.from('nidito').delete().eq('created_by', p).not('deleted_at', 'is', null),
        sb.from('acciones_pendientes').delete().eq('user_phone', p),
        sb.from('audit_log').delete().eq('user_phone', p),
      ]);
      const refs = { ...(u.external_refs || {}) };
      delete refs.borrar_definitivo_at;
      refs.borrado_definitivo_at = now;
      await sb.from('usuarios').update({ external_refs: refs }).eq('telefono', p);
      console.log(`[PURGA] ${p} purgado definitivamente.`);
    }
  } catch (e) { console.error('Error en purga:', e.message); }
}
setInterval(purgarDatosVencidos, 24 * 60 * 60 * 1000);
purgarDatosVencidos().catch(() => {});

async function expirarAccionesPendientes() {
  try {
    const { count } = await sb.from('acciones_pendientes')
      .update({ estado: 'expirada' })
      .in('estado', ['pending', 'editing'])
      .lt('expira_at', new Date().toISOString())
      .select('id', { count: 'exact', head: true });
    if (count > 0) console.log(`[EXPIRY] ${count} acción(es) expiradas.`);
  } catch (e) { console.error('expirarAccionesPendientes:', e.message); }
}
setInterval(expirarAccionesPendientes, 15 * 60 * 1000);
expirarAccionesPendientes().catch(() => {});

// Parsea "mejor 450", "categoría comida", etc. y los fusiona con los datos existentes
function mergeEditIntent(datosActuales, editText) {
  const d = { ...datosActuales };

  const montoM = editText.match(/(?:mejor|monto|son|cuesta|fue|costó|pagué)\s*\$?\s*([\d,]+(?:\.\d+)?)/i)
               || editText.match(/^\$?\s*([\d,]+(?:\.\d+)?)$/);
  if (montoM) d.monto = parseFloat(montoM[1].replace(/,/g, ''));

  const catM = editText.match(/(?:categoría|categoria|cat)\s+(\w+)/i);
  if (catM) {
    const ci = catM[1].toLowerCase();
    const match = CATEGORIAS.find(c => c.toLowerCase().startsWith(ci));
    if (match) d.categoria = match;
  }

  const conceptoM = editText.match(/(?:concepto|fue en|en el|en la|en)\s+(.+)/i);
  if (conceptoM) d.concepto = conceptoM[1].trim();

  const medioM = editText.match(/(?:con|medio|pago con|pagué con)\s+(.+)/i);
  if (medioM) {
    const mi = medioM[1].toLowerCase();
    const match = MEDIOS_PAGO.find(m => m.toLowerCase().includes(mi));
    if (match) d.medio_pago = match;
  }
  return d;
}

// Intercept para comandos de confirmación/cancelación ANTES de llamar a la IA
async function handlePendingCommand(phone, lower) {
  const isConfirm = /^(1|si|sí|ok|✓|confirmo)$/i.test(lower);
  const isCancel  = /^(3|no|cancela|cancelar)$/i.test(lower);
  const isEdit    = /^(2|editar)$/i.test(lower);
  const isUndo    = /^deshacer$/i.test(lower);

  if (!isConfirm && !isCancel && !isEdit && !isUndo) return null;

  if (isUndo) return undoLastAction(phone);

  const pending = await getLastPendingAction(phone);

  if (isEdit) {
    if (!pending) return '⚠️ No hay acción pendiente para editar.';
    await sb.from('acciones_pendientes').update({ estado: 'editing' }).eq('id', pending.id);
    return 'Dime qué cambio (ej: *"mejor 450"* o *"categoría transporte"*)';
  }
  if (isConfirm) {
    if (!pending) return '⚠️ No hay acción pendiente por confirmar.';
    // Doble confirmación para borrar datos
    if (pending.datos?.accion === 'borrar_datos') {
      await sb.from('acciones_pendientes').update({ estado: 'done' }).eq('id', pending.id);
      if (pending.datos.paso === 1) {
        await sb.from('acciones_pendientes').insert({
          user_phone: phone, tipo: 'db_action',
          datos: { accion: 'borrar_datos', paso: 2 },
          estado: 'pending',
          expira_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        });
        return `⚠️ *ÚLTIMA CONFIRMACIÓN*\n\nSe eliminarán: movimientos, metas, TDC, calendario, presupuesto y patrones. Los datos con soft-delete se purgarán definitivamente en 30 días.\n\n¿Confirmas?\n*1* Sí, borrar todo · *3* Cancelar`;
      }
      if (pending.datos.paso === 2) {
        return await ejecutarBorradoDatos(phone);
      }
    }
    const dbRes = await executeDbAction(phone, pending.datos, 'whatsapp');
    await sb.from('acciones_pendientes').update({ estado: 'done' }).eq('id', pending.id);
    return `✓ Hecho. ${dbRes.startsWith('✅') ? '' : dbRes}`.trim();
  }
  if (isCancel) {
    if (!pending) return '⚠️ No hay acción pendiente por cancelar.';
    await sb.from('acciones_pendientes').update({ estado: 'cancelled' }).eq('id', pending.id);
    return '✗ Cancelado.';
  }
  return null;
}

// ── Verificar y alertar límite de presupuesto ────────────────────────────────
async function verificarLimitePresupuesto(userPhone, categoria, mes) {
  const { data: pres } = await sb.from('presupuesto')
    .select('limite').eq('user_phone', userPhone)
    .eq('categoria', categoria).eq('mes', mes).maybeSingle();
  if (!pres || pres.limite <= 0) return;

  const inicio = mes + '-01';
  const { data: movs } = await sb.from('movimientos').select('monto')
    .eq('user_phone', userPhone).eq('categoria', categoria)
    .eq('tipo', 'GASTO').gte('fecha', inicio).is('deleted_at', null);
  const total = (movs || []).reduce((a, m) => a + (m.monto || 0), 0);
  const pct   = Math.round(total / pres.limite * 100);

  const umbral = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
  if (!umbral) return;

  const ref = `limite-${categoria}-${mes}-${umbral}`;
  const { data: ya } = await sb.from('notificaciones_log')
    .select('id').eq('user_phone', userPhone).eq('referencia', ref).maybeSingle();
  if (ya) return;

  const icon = umbral >= 100 ? '🔴' : '🟡';
  const msg  = umbral >= 100
    ? `${icon} *¡Límite alcanzado en ${categoria}!*\n${fmt(total)} gastados de ${fmt(pres.limite)}. ¿Lo ajustamos?`
    : `${icon} *${categoria} al ${pct}%* de tu presupuesto (${fmt(total)} / ${fmt(pres.limite)})`;

  await enviarWhatsApp(userPhone, msg);
  await sb.from('notificaciones_log').insert({ user_phone: userPhone, tipo: 'limite', referencia: ref });
}

// ── Endpoints de cron jobs ────────────────────────────────────────────────────
app.post('/cron/:tipo', async (req, res) => {
  if (req.headers['x-cron-token'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  res.status(200).json({ ok: true });

  const tipo = req.params.tipo;
  const { data: usuarios } = await sb.from('usuarios').select('*');

  for (const u of (usuarios || [])) {
    try {
      if (tipo === 'resumen-diario') {
        const ctx = await cargarContexto(u.telefono, u.role);
        const neto = ctx.ingresosMes - ctx.gastosMes;
        const tdcPend = ctx.tdcs.reduce((a, t) => a + Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)), 0);
        let msg = `🌙 *Resumen de hoy, ${u.nombre}*\n\n`;
        msg += `💸 Gastado hoy: ${fmt(ctx.movs.filter(m => m.fecha === hoy() && m.tipo === 'GASTO').reduce((a,m)=>a+m.monto,0))}\n`;
        msg += `📊 Neto del mes: ${fmt(neto)}\n`;
        if (u.role === 'ADMIN_A' && tdcPend > 0) {
          msg += `💳 TDC pendiente: ${fmt(tdcPend)}\n`;
        }
        if (ctx.metasNidito.length) {
          msg += `\n🏠 *Nidito:* ${ctx.metasNidito.map(m => {
            const pct = m.meta > 0 ? Math.round((m.actual||0)/m.meta*100) : 0;
            return `${m.nombre} ${pct}%`;
          }).join(' · ')}`;
        }
        await enviarWhatsApp(u.telefono, msg);

      } else if (tipo === 'recordatorio-tdc' && u.role === 'ADMIN_A') {
        const { data: amex } = await sb.from('tdc').select('*').eq('nombre', 'AMEX').single();
        if (amex) {
          const msg = `💳 *Recordatorio AMEX, ${u.nombre}*\n\nCuota mensual: ${fmt(904)}\nSaldo restante: ${fmt(Math.max(0,(amex.a_pagar||0)-(amex.pagado||0)))}\n\nRecuerda hacer la transferencia antes del día 30.`;
          await enviarWhatsApp(u.telefono, msg);
        }

      } else if (tipo === 'recordatorio-vales' && u.role === 'ADMIN_A') {
        const msg = `🛒 *¡Hoy llegan tus vales, ${u.nombre}!*\n\n${fmt(3566)} de despensa disponibles.\nRecuerda registrar cuando los uses: *"gasté X en despensa"*`;
        await enviarWhatsApp(u.telefono, msg);
      }
    } catch (e) {
      console.error(`Error en cron ${tipo} para ${u.telefono}:`, e.message);
    }
  }
});

// ── USER ───────────────────────────────────────────────────────────────────
async function getOrCreateUser(phone) {
  let { data: u } = await sb.from('usuarios').select('*').eq('telefono', phone).single();
  if (!u) {
    const { data: n } = await sb.from('usuarios').insert([{ telefono: phone, role: 'USER_B', ai_preference: 'GEMINI' }]).select().single();
    u = n;
  }
  return u;
}

// ── PATTERN LEARNING ───────────────────────────────────────────────────────
async function learnPattern(phone, mov) {
  if (!mov.concepto || mov.tipo !== 'GASTO') return;
  const key = mov.concepto.toLowerCase().trim();
  const { data: ex } = await sb.from('patrones_ia').select('*').eq('user_phone', phone).eq('concepto_clave', key).single();
  if (ex) {
    const n = (ex.contador || 1) + 1;
    const avg = ((ex.monto_promedio * (n - 1)) + (mov.monto || 0)) / n;
    await sb.from('patrones_ia').update({
      contador: n, monto_promedio: Math.round(avg * 100) / 100,
      medio_pago_usual: mov.medio_pago || ex.medio_pago_usual,
      categoria: mov.categoria || ex.categoria,
      ultima_vez: mov.fecha || hoy(), updated_at: new Date().toISOString()
    }).eq('id', ex.id);
  } else {
    await sb.from('patrones_ia').insert([{
      user_phone: phone, concepto_clave: key,
      categoria: mov.categoria, medio_pago_usual: mov.medio_pago || 'efectivo',
      monto_promedio: mov.monto, ultima_vez: mov.fecha || hoy()
    }]);
  }
}

// ── AUDIO TRANSCRIPTION (Gemini multimodal) ───────────────────────────────
async function transcribeAudio(mediaBuf, contentType, phone = '') {
  try {
    const base64 = mediaBuf.toString('base64');
    const mime   = contentType || 'audio/ogg';
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await geminiWithRetry(() => model.generateContent([
      { inlineData: { mimeType: mime, data: base64 } },
      'Transcribe exactamente este audio en español. Devuelve solo el texto transcrito, sin comentarios adicionales.'
    ]));
    logUsage(phone, 'gemini-2.5-flash', result.response.usageMetadata, 'vision');
    return result.response.text().trim();
  } catch (e) {
    console.error('Audio transcription error:', e.message);
    return null;
  }
}

// ── PROACTIVE REMINDERS ────────────────────────────────────────────────────
async function checkAndSendReminders(phone) {
  const _tm = new Date(hoy() + 'T12:00:00'); _tm.setDate(_tm.getDate() + 1);
  const tStr = _tm.toISOString().split('T')[0];
  const { data: evs } = await sb.from('calendario').select('*')
    .eq('user_phone', phone).eq('fecha', tStr).eq('notificado', false);
  for (const ev of (evs || [])) {
    try {
      await twl.messages.create({
        from: WA_FROM, to: phone,
        body: `🔔 *OnlyUs — Recordatorio*\nMañana: *${ev.titulo}*\n📅 ${ev.fecha}${ev.hora ? ' a las ' + ev.hora : ''}\n${ev.descripcion || ''}`
      });
      await sb.from('calendario').update({ notificado: true }).eq('id', ev.id);
    } catch (e) { console.error('reminder err:', e.message); }
  }
}

// ── DB ACTION EXECUTOR ─────────────────────────────────────────────────────
const TABLAS_VALIDAS = ['movimientos','metas','calendario','tdc','presupuesto','nidito','usuarios'];
const TABLAS_SOFT_DELETE = ['movimientos','metas','calendario','nidito'];

// ── GASTOS PROGRAMADOS → PRESUPUESTO (no movimientos) ────────────────────────
// Un gasto futuro o explícitamente "programado" NO es un movimiento ya hecho:
// se guarda en external_refs.budget_q[quincena].gastos para que aparezca en
// "Presupuesto y Metas" en la quincena correspondiente, hasta que el usuario lo
// registre como gasto realizado (chat IA o manual) en su debido momento.
function medioToFormaPago(medio) {
  const m = (medio || '').toLowerCase();
  if (m === 'efectivo') return 'efectivo';
  if (m.includes('débito') || m.includes('debito')) return 'tarjeta_debito';
  return ''; // TDC / transferencia → no afecta el cálculo de retiro de efectivo
}

// Detecta si un GASTO debe tratarse como programado (presupuesto) y no como movimiento real.
function esGastoProgramado(datos, today) {
  if (!datos || datos.tipo !== 'GASTO') return false;
  if (datos.programado === true) return true;
  // Un gasto con fecha futura no puede ser un movimiento "ya hecho".
  if (datos.fecha && datos.fecha > today) return true;
  return false;
}

// Reglas DETERMINISTAS de categorización por palabra clave (chat IA web + WhatsApp).
// Se aplican a GASTOS sin importar lo que devuelva Gemini, para garantizar consistencia.
// Mutan `datos` en sitio. Precedencia: transporte (concreto) > Platina > Alicia/golosinas.
function aplicarReglasCategoria(datos, textoOriginal = '') {
  if (!datos || datos.tipo !== 'GASTO') return datos;
  const norm = s => String(s || '').toLowerCase()
    .replace(/[áàä]/g,'a').replace(/[éèë]/g,'e').replace(/[íìï]/g,'i')
    .replace(/[óòö]/g,'o').replace(/[úùü]/g,'u');   // minúsculas + sin acentos
  const blob = norm(`${datos.concepto || ''} ${datos.comentarios || ''} ${textoOriginal || ''}`);
  const has  = re => re.test(blob);

  // 1) Transporte público — define categoría Y medio de pago
  if (has(/\b(camion|micro|combi)\b/)) {
    datos.categoria  = 'Transporte';
    datos.medio_pago = 'efectivo';
  } else if (has(/\b(metro|metrobus)\b/)) {
    datos.categoria  = 'Transporte';
    datos.medio_pago = 'débito';
  }

  // 2) Alicia / golosinas → Ocio (salvo gasto de la Platina o ya marcado Transporte)
  if (has(/\b(alicia|golosina|golosinas)\b/) &&
      datos.categoria !== 'Platina' && datos.categoria !== 'Transporte') {
    datos.categoria = 'Ocio';
  }
  // "alicia" siempre deja rastro en comentarios (contexto pareja)
  if (has(/\balicia\b/) && !datos.comentarios) datos.comentarios = 'Alicia';

  // 3) "transferencia" → siempre se guarda como pagado con tarjeta de débito
  if (has(/\btransfer(?:encia|i)\b/)) datos.medio_pago = 'débito';

  return datos;
}

// Etiqueta legible de quincena: "2026-06-B" → "2ª quincena de junio"
function labelQuincena(qKey) {
  const m = String(qKey || '').match(/^(\d{4})-(\d{2})-([AB])$/);
  if (!m) return qKey;
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const nom = meses[parseInt(m[2], 10) - 1] || m[2];
  return (m[3] === 'A' ? '1ª' : '2ª') + ` quincena de ${nom}`;
}

async function addGastoProgramado(phone, datos, origen, texto_original) {
  const fecha = datos.fecha || hoy();
  const qKey  = getQuincena(fecha).key;
  const { data: cur } = await sb.from('usuarios').select('external_refs').eq('telefono', phone).single();
  const refs = { ...(cur?.external_refs || {}) };
  if (!refs.budget_q) refs.budget_q = {};
  if (!refs.budget_q[qKey]) refs.budget_q[qKey] = { gastos: [], ingresos: [] };
  if (!Array.isArray(refs.budget_q[qKey].gastos)) refs.budget_q[qKey].gastos = [];
  const item = {
    _id: 'pg-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    descripcion: datos.concepto || datos.descripcion || 'Gasto programado',
    monto: Number(datos.monto) || 0,
  };
  const fp = medioToFormaPago(datos.medio_pago);
  if (fp) item.forma_pago = fp;
  refs.budget_q[qKey].gastos.push(item);
  const { error } = await sb.from('usuarios').update({ external_refs: refs }).eq('telefono', phone);
  if (error) return { error: error.message };
  await writeAuditLog(phone, 'usuarios', 'gasto_programado', phone, null, { qKey, item }, origen, texto_original);
  return { qKey, item, fecha };
}

async function executeDbAction(phone, arg, origen = 'whatsapp') {
  const { tabla, accion, id, datos, texto_original } = arg;
  try {
    if (!TABLAS_VALIDAS.includes(tabla)) {
      return `❌ Tabla '${tabla}' no existe. Tablas válidas: ${TABLAS_VALIDAS.join(', ')}`;
    }

    // Snapshot previo para editar/eliminar
    let snapshotBefore = null;
    if ((accion === 'editar' || accion === 'eliminar') && id) {
      const { data } = await sb.from(tabla).select('*').eq('id', id).maybeSingle();
      snapshotBefore = data;
    }

    // ── nidito — tabla compartida sin user_phone ─────────────────────────────
    if (tabla === 'nidito') {
      if (accion === 'crear') {
        const { data, error } = await sb.from('nidito').insert({ ...datos, created_by: phone }).select().single();
        if (error) return `❌ Error: ${error.message}`;
        await writeAuditLog(phone, tabla, accion, data?.id, null, data, origen, texto_original);
        return `✅ Agregado al Nidito ✓ ID: ${data?.id}`;
      }
      if (accion === 'editar') {
        const { data, error } = await sb.from('nidito').update({ ...datos, updated_at: new Date().toISOString() }).eq('id', id).select().single();
        if (error) return `❌ Error: ${error.message}`;
        await writeAuditLog(phone, tabla, accion, id, snapshotBefore, data, origen, texto_original);
        return `✅ Nidito #${id} actualizado.`;
      }
      if (accion === 'eliminar') {
        const { error } = await sb.from('nidito').update({ deleted_at: new Date().toISOString() }).eq('id', id);
        if (error) return `❌ Error: ${error.message}`;
        await writeAuditLog(phone, tabla, accion, id, snapshotBefore, null, origen, texto_original);
        return `🗑️ Eliminado del Nidito #${id}.`;
      }
    }

    // ── usuarios — merge en external_refs ────────────────────────────────────
    if (tabla === 'usuarios') {
      const { data: cur } = await sb.from('usuarios').select('external_refs').eq('telefono', phone).single();
      const refs = { ...(cur?.external_refs || {}), ...datos };
      const { error } = await sb.from('usuarios').update({ external_refs: refs }).eq('telefono', phone);
      if (error) return `❌ Error: ${error.message}`;
      await writeAuditLog(phone, tabla, 'editar', phone, cur?.external_refs, refs, origen, texto_original);
      return `✅ Perfil personal actualizado.`;
    }

    if (accion === 'crear') {
      // ── Reglas deterministas de categorización (palabras clave) ────────────
      if (tabla === 'movimientos') aplicarReglasCategoria(datos, texto_original);
      // ── Gasto programado/futuro → Presupuesto, NO movimiento real ──────────
      if (tabla === 'movimientos' && esGastoProgramado(datos, hoy())) {
        const r = await addGastoProgramado(phone, datos, origen, texto_original);
        if (r.error) return `❌ Error: ${r.error}`;
        arg._programado = true; arg._qKey = r.qKey;   // marca para el resumen del chat
        return `✅📅 Gasto programado en Presupuesto: ${datos.concepto || ''} · ${fmt(datos.monto || 0)} → ${labelQuincena(r.qKey)}`;
      }
      const { programado, ...cleanDatos } = datos || {};   // 'programado' no es columna de la tabla
      const { data, error } = await sb.from(tabla).insert({ ...cleanDatos, user_phone: phone }).select().single();
      if (error) return `❌ Error: ${error.message}`;
      if (tabla === 'movimientos' && cleanDatos?.tipo === 'GASTO') {
        await learnPattern(phone, cleanDatos);
        await verificarLimitePresupuesto(phone, cleanDatos.categoria, mesActual()).catch(() => null);
      }
      await writeAuditLog(phone, tabla, accion, data?.id, null, data, origen, texto_original);
      return `✅ ${tabla === 'calendario' ? 'Evento agendado' : 'Registrado'} ✓ ID: ${data?.id}`;
    }
    if (accion === 'editar') {
      const { data, error } = await sb.from(tabla).update(datos).eq('id', id).eq('user_phone', phone).select().single();
      if (error) return `❌ Error: ${error.message}`;
      await writeAuditLog(phone, tabla, accion, id, snapshotBefore, data, origen, texto_original);
      return `✅ Registro ${id} actualizado.`;
    }
    if (accion === 'eliminar') {
      if (TABLAS_SOFT_DELETE.includes(tabla)) {
        const { error } = await sb.from(tabla).update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_phone', phone);
        if (error) return `❌ Error: ${error.message}`;
      } else {
        const { error } = await sb.from(tabla).delete().eq('id', id).eq('user_phone', phone);
        if (error) return `❌ Error: ${error.message}`;
      }
      await writeAuditLog(phone, tabla, accion, id, snapshotBefore, null, origen, texto_original);
      return `🗑️ Registro ${id} eliminado.`;
    }
    return '❌ Acción no reconocida.';
  } catch (e) { return `❌ DB error: ${e.message}`; }
}

// ── INTENT EXTRACTION (Gemini Flash — todos los usuarios) ────────────────────
// extractIntent usa siempre Gemini con JSON estructurado, sin depender de Anthropic.
// Solo la CONVERSACIÓN (CONSULTA/CHARLA) respeta ai_preference del usuario.
const _extractIntentStaticPrompt = `Eres un extractor de intents para una app de finanzas personales de una pareja mexicana (Ángel y Alicia).
Analiza el mensaje del usuario y responde ÚNICAMENTE con JSON válido (sin texto adicional).

FECHA ACTUAL: FECHA_HOY (año FECHA_YEAR)
- "hoy" o sin fecha → FECHA_HOY
- Fechas sin año ("25 de julio") → usa año FECHA_YEAR

VOCABULARIO COLOQUIAL MX:
- "varo/lana/feria/bil/billete" → dinero/monto
- "hay que sacar/le saqué/le metí/le di" → gasto
- "me cayeron/me cayó" → ingreso
- "agarré la BBVA/cargué a la AMEX" → medio de pago
- Tolerar errores ortográficos: "gaste/pague" sin acento = equivalente

CONTEXTO DE PAREJA:
- "Alicia/ella/mi novia/nosotros/fuimos/fueron" → comentarios:"Alicia" + categoria:"Ocio" automático
- "Platina" → coche de la pareja → categoria:"Platina" (tiene prioridad sobre Ocio)
- Alicia/Ángel/Angel como (paréntesis) → NO son medios de pago

REGLAS FIJAS POR PALABRA (obligatorias):
- "alicia" o "golosinas" → categoria:"Ocio"
- "camión/camion", "micro" o "combi" → categoria:"Transporte" + medio_pago:"efectivo"
- "metro" o "metrobús" → categoria:"Transporte" + medio_pago:"débito"
- "transferencia" (en un gasto) → medio_pago:"débito"

CATEGORIZACIÓN:
Transporte: Uber, DiDi, Beat, Lyft, metro, metrobús, combi, taxi, caseta
Platina:    gasolina, aceite, afinación, suspensión, verificación, tenencia, seguro coche, llanta, refacción auto
Comida:     tacos, taquería, restaurante, fonda, torta, burger, sushi, pizza, café, McDonald's, KFC, Starbucks, antojitos, alitas
Despensa:   Walmart/Wally, Chedraui, Soriana, Costco, Oxxo, 7-Eleven, mercado, abarrotes, súper, frutas, verduras
Hogar:      renta, luz, agua, gas hogar, internet, cable, predial, mueble, electrodoméstico
Ocio:       Netflix, Spotify, Disney+, HBO, cine, teatro, concierto, bar, antro, videojuego, Steam
Personales: doctor, farmacia, medicina, gym, spa, peluquería, barbería, cosméticos, ropa, zapatos
TDC:        pago mínimo tarjeta, abono TDC
Hormiga:    Amazon, Mercado Libre, Shein, suscripción, app, compra online pequeña

INTENTS disponibles:
- REGISTRO   → el usuario reporta un gasto, ingreso u operación con monto explícito
- EDICION    → quiere corregir/modificar un registro existente (menciona ID o "el último")
- ELIMINACION→ quiere borrar un registro específico
- CONSULTA   → pregunta por sus finanzas, pide análisis o resúmenes
- CHARLA     → saludo, agradecimiento, conversación casual
- COMANDO    → palabras clave: resumen, deudas, metas, historial, presupuesto, calendario, ayuda, nidito

Para REGISTRO/EDICION/ELIMINACION con datos suficientes: incluye tabla, accion, datos (y id si aplica).
Si faltan datos críticos (ej: "gasté en el súper" sin monto) → {"intent":"CONSULTA"}.

TABLAS: movimientos | metas | calendario | tdc | presupuesto | nidito
ACCIONES: crear | editar | eliminar
CATEGORÍAS: Hogar, Comida, TDC, Despensa, Hormiga, Ocio, Personales, Platina, Transporte, OTROS
MEDIOS PAGO: efectivo, TDC BBVA, TDC HEY, TDC Liverpool, TDC AMEX, TDC NU, TDC Rappi, TDC Palacio, transferencia, débito
Tipo GASTO requiere: tipo="GASTO", categoria, concepto, monto, comentarios (opcional, ej "Alicia"), medio_pago (default "efectivo"), fecha (YYYY-MM-DD)
Tipo INGRESO: tipo="INGRESO", categoria="OTROS", concepto, monto, fecha

GASTO PROGRAMADO vs GASTO HECHO (¡MUY IMPORTANTE!):
- Gasto YA HECHO (pasado/hoy): "gasté/pagué/compré 200 en tacos" → registro normal de movimiento.
- Gasto PROGRAMADO/FUTURO: el usuario PLANEA un gasto que aún NO ocurre. Señales: "voy a / planeo / programa / presupuesta / agenda / para la quincena del X / el 25 de junio pago / próximo mes / en julio", o cualquier fecha FUTURA (posterior a FECHA_HOY).
  → Agrega "programado":true en datos. NO es un movimiento ya hecho; el sistema lo guarda en el Presupuesto de la quincena correspondiente a su fecha.
  → Usa la fecha del gasto. "quincena del 25 de junio" → fecha "FECHA_YEAR-06-25". "quincena del 10 de julio" → "FECHA_YEAR-07-10".

EJEMPLOS:
"50 tacos" → {"intent":"REGISTRO","tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Comida","concepto":"tacos","monto":50,"medio_pago":"efectivo","fecha":"FECHA_HOY"}}
"programa airbnb 8000 para la quincena del 25 de junio" → {"intent":"REGISTRO","tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Ocio","concepto":"AIRBNB / HOTEL","monto":8000,"programado":true,"fecha":"FECHA_YEAR-06-25"}}
"voy a pagar 2500 de afinación de la platina el 25 de junio en efectivo" → {"intent":"REGISTRO","tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Platina","concepto":"Afinacion platina","monto":2500,"medio_pago":"efectivo","programado":true,"fecha":"FECHA_YEAR-06-25"}}
"gasté 350 uber con TDC BBVA" → {"intent":"REGISTRO","tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Transporte","concepto":"uber","monto":350,"medio_pago":"TDC BBVA","fecha":"FECHA_HOY"}}
"350 de gasolina" → {"intent":"REGISTRO","tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Platina","concepto":"gasolina","monto":350,"medio_pago":"efectivo","fecha":"FECHA_HOY"}}
"fuimos al cine con alicia 280" → {"intent":"REGISTRO","tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Ocio","concepto":"cine","monto":280,"medio_pago":"efectivo","comentarios":"Alicia","fecha":"FECHA_HOY"}}
"recibí mi sueldo $14,000" → {"intent":"REGISTRO","tabla":"movimientos","accion":"crear","datos":{"tipo":"INGRESO","categoria":"OTROS","concepto":"Sueldo","monto":14000,"fecha":"FECHA_HOY"}}
"cuánto gasté este mes" → {"intent":"CONSULTA"}
"hola cómo estás" → {"intent":"CHARLA"}`;

async function extractIntent(text, phone = '') {
  const today = hoy();

  // Fast path: handle unambiguous simple patterns without calling Gemini (avoids rate limits)
  const t = text.trim();
  const SPEND_CON = /^(?:gasté|gaste|pagué|pague)\s+(\d+(?:\.\d+)?)\s+(?:en|de)\s+(.+?)\s+con\s+(.+)$/i;
  const SPEND     = /^(?:gasté|gaste|pagué|pague)\s+(\d+(?:\.\d+)?)\s+(?:en|de)\s+(.+)$/i;
  const DEL_MOV   = /^borrar\s+(?:el\s+)?movimiento\s+(\S+)\s*$/i;
  let m;
  if ((m = t.match(SPEND_CON))) {
    return { intent: 'REGISTRO', toolArgs: { tabla: 'movimientos', accion: 'crear', datos: { tipo: 'GASTO', categoria: 'OTROS', concepto: m[2].trim(), monto: parseFloat(m[1]), medio_pago: m[3].trim(), fecha: today } } };
  }
  if ((m = t.match(SPEND))) {
    return { intent: 'REGISTRO', toolArgs: { tabla: 'movimientos', accion: 'crear', datos: { tipo: 'GASTO', categoria: 'OTROS', concepto: m[2].trim(), monto: parseFloat(m[1]), medio_pago: 'efectivo', fecha: today } } };
  }
  if ((m = t.match(DEL_MOV))) {
    return { intent: 'ELIMINACION', toolArgs: { tabla: 'movimientos', accion: 'eliminar', id: m[1], datos: {} } };
  }

  try {
    const model = genAI.getGenerativeModel({
      model:            'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      systemInstruction: _extractIntentStaticPrompt
        .replace(/FECHA_HOY/g, today)
        .replace(/FECHA_YEAR/g, today.slice(0, 4)),
    });
    const result = await geminiWithRetry(() => model.generateContent(text));
    logUsage(phone, 'gemini-2.5-flash', result.response.usageMetadata, 'extractor');

    const json    = JSON.parse(result.response.text());
    const intent  = (json.intent || 'CONSULTA').toUpperCase();
    let toolArgs  = null;

    if (['REGISTRO','EDICION','ELIMINACION'].includes(intent) && json.tabla && json.accion) {
      const datos = { ...(json.datos || {}) };
      if (!datos.fecha) {
        datos.fecha = today;
      } else if (json.accion === 'crear' && json.tabla === 'movimientos') {
        const itemYear = parseInt(datos.fecha.slice(0, 4), 10);
        if (itemYear < parseInt(today.slice(0, 4), 10)) {
          datos.fecha = today.slice(0, 4) + datos.fecha.slice(4);
        }
      }
      toolArgs = { tabla: json.tabla, accion: json.accion, id: json.id || undefined, datos };
    }

    return { intent, toolArgs };
  } catch (e) {
    console.error('extractIntent error:', e.message);
    return { intent: 'CONSULTA', toolArgs: null };
  }
}

// ── BATCH INTENT EXTRACTION (web chat — extrae TODAS las operaciones de un mensaje) ──
const _batchIntentPrompt = `Eres un extractor de intents para una app de finanzas personales de una pareja mexicana (Ángel y Alicia).
Analiza el mensaje y extrae TODAS las operaciones mencionadas.
Responde ÚNICAMENTE con JSON válido (sin texto adicional).

FECHA ACTUAL: FECHA_HOY (año FECHA_YEAR)
- "hoy" o sin fecha especificada → FECHA_HOY
- "ayer" → FECHA_AYER
- Fechas sin año ("25 de julio", "quincena 10 de agosto") → usa año FECHA_YEAR
- Fechas futuras ("quincena 10 de julio siguiente") → FECHA_YEAR si el mes aún no pasó, FECHA_YEAR+1 si ya pasó

VOCABULARIO COLOQUIAL MX:
- "varo/lana/feria/bil/billete/biyuyo" → dinero; interpreta como monto en contexto
- "hay que sacar/le saqué/le metí/le di/le eché" → gasto
- "me cayeron/me cayó/me entraron" → ingreso
- "agarré la BBVA/cargué a la AMEX/lo puse en la NU" → medio de pago específico
- "del súper/del Wally/del Oxxo" → Despensa
- Tolerar errores ortográficos: "gaste/pague/compre" sin acento = equivalente con acento

CONTEXTO DE PAREJA:
- "Alicia/ella/mi novia/nosotros/fuimos/fueron" → comentarios:"Alicia" + categoria:"Ocio" automático
- "le presté/le di a Alicia" → comentarios:"Alicia", categoria "Ocio" (o la más apropiada si es obvia)
- "Platina" → coche de la pareja → categoria:"Platina" siempre (tiene prioridad sobre Ocio)
- Nombres propios (Alicia, Ángel, Angel) como (paréntesis) → NO son medios de pago, ignorarlos

REGLAS FIJAS POR PALABRA (obligatorias, anulan otra categorización salvo Platina):
- "alicia" o "golosinas" → categoria:"Ocio"
- "camión/camion", "micro" o "combi" → categoria:"Transporte" + medio_pago:"efectivo"
- "metro" o "metrobús" → categoria:"Transporte" + medio_pago:"débito"
- "transferencia" (en un gasto) → medio_pago:"débito"

CATEGORIZACIÓN AUTOMÁTICA:
Transporte:  Uber, DiDi, Beat, Lyft, Cabify, Rappi traslado, metro, metrobús, tren suburbano, combi, camión, taxi, caseta (sin Platina)
Platina:     gasolina, aceite, afinación, suspensión, verificación, tenencia, seguro auto, llanta, frenos, batería, refacción carro
Comida:      tacos, taquería, restaurante, fonda, comida corrida, torta, burger, hamburguesa, sushi, pizza, café, Starbucks, McDonald's, KFC, Domino's, Subway, antojitos, alitas, helado, nieve, panadería, VIPS, El Portón, Wings
Despensa:    Walmart/Wally, Chedraui, Soriana, Costco, Sam's, Bodega Aurrera, La Comer, City Market, Oxxo, 7-Eleven, Circle K, mercado, tianguis, abarrotes, súper, frutas, verduras, papel de baño, limpieza
Hogar:       renta, luz, agua, gas (hogar), internet, cable, teléfono fijo, predial, mantenimiento depto, mueble, electrodoméstico, HomeDepot, Sodimac, IKEA
Ocio:        Netflix, Spotify, Disney+, HBO, Prime Video, Apple TV, YouTube Premium, Paramount+, cine, teatro, concierto, bar, antro, botanero, cover, videojuego, Steam, PlayStation, Xbox, viaje, hotel, Airbnb, parque, excursión, regalo, flores
Personales:  doctor, dentista, psicólogo/psico, farmacia, medicina, pastilla, gym, gimnasio, spa, peluquería, barbería, cosméticos, ropa, zapatos, lentes, Farmacias del Ahorro, Simi, Benavides
TDC:         pago mínimo tarjeta, abono TDC, pago [banco] tarjeta, corte
Hormiga:     Amazon, Mercado Libre, Shein, AliExpress, suscripción, app, dominio, compra online pequeña

INTENTS:
- REGISTRO    → el usuario reporta uno o MÁS gastos/ingresos con monto explícito
- EDICION     → quiere corregir un registro existente
- ELIMINACION → quiere borrar un registro específico
- CONSULTA    → pregunta por sus finanzas, pide análisis o resúmenes
- CHARLA      → saludo, agradecimiento, conversación casual

Si el intent es REGISTRO/EDICION/ELIMINACION incluye un array "items" con CADA operación por separado.
Si es CONSULTA o CHARLA devuelve solo {"intent":"CONSULTA"} o {"intent":"CHARLA"}.
Si faltan datos críticos (ej: "gasté en el súper" sin monto) → {"intent":"CONSULTA"}.

TABLAS: movimientos | metas | calendario | tdc | presupuesto | nidito
ACCIONES: crear | editar | eliminar
CATEGORÍAS: Hogar, Comida, TDC, Despensa, Hormiga, Ocio, Personales, Platina, Transporte, OTROS
MEDIOS PAGO: efectivo, TDC BBVA, TDC HEY, TDC Liverpool, TDC AMEX, TDC NU, TDC Rappi, TDC Palacio, transferencia, débito
Tipo GASTO: tipo="GASTO", categoria, concepto, monto, comentarios (opcional, ej: "Alicia"), medio_pago (default "efectivo"), fecha (YYYY-MM-DD)
Tipo INGRESO: tipo="INGRESO", categoria="OTROS", concepto, monto, fecha

GASTO PROGRAMADO vs GASTO HECHO (¡CRÍTICO — no confundir!):
- Gasto YA HECHO (pasado/hoy): "gasté/pagué/compré/le saqué" → movimiento normal.
- Gasto PROGRAMADO/FUTURO: el usuario PLANEA o PRESUPUESTA un gasto que aún NO ocurre. Señales: "programa(dos)/voy a/planeo/presupuesta/agenda/para la quincena del X/el 25 de junio pago/próximo mes/en julio", encabezados como "Gastos PROGRAMADOS:", o CUALQUIER fecha posterior a FECHA_HOY.
  → Añade "programado":true en datos de ese item. NO es un movimiento ya hecho.
  → El sistema lo guarda en el Presupuesto de la quincena correspondiente a su fecha (hasta que el usuario lo registre como gasto realizado).
  → Mapea la fecha al día indicado: "quincena 25 de junio" → "FECHA_YEAR-06-25"; "quincena 10 de julio" → "FECHA_YEAR-07-10"; "quincena 10 de agosto" → "FECHA_YEAR-08-10".
  → forma de pago entre paréntesis ("(efectivo)", "(tarjeta débito)") → medio_pago correspondiente.

EJEMPLOS:
"Ayer gasté 50 en tacos y 80 en uber con TDC BBVA" →
{"intent":"REGISTRO","items":[
  {"tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Comida","concepto":"tacos","monto":50,"medio_pago":"efectivo","fecha":"FECHA_AYER"}},
  {"tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Transporte","concepto":"uber","monto":80,"medio_pago":"TDC BBVA","fecha":"FECHA_AYER"}}
]}
"Gastos PROGRAMADOS:\nAIRBNB 8000 (quincena 25 de junio)\nAfinacion platina 2500 (quincena 25 de junio) (efectivo)\nEscritorio 6100 (quincena 10 de septiembre) (tarjeta débito)" →
{"intent":"REGISTRO","items":[
  {"tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Ocio","concepto":"AIRBNB / HOTEL","monto":8000,"programado":true,"fecha":"FECHA_YEAR-06-25"}},
  {"tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Platina","concepto":"Afinacion platina","monto":2500,"medio_pago":"efectivo","programado":true,"fecha":"FECHA_YEAR-06-25"}},
  {"tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Hogar","concepto":"Escritorio","monto":6100,"medio_pago":"débito","programado":true,"fecha":"FECHA_YEAR-09-10"}}
]}
"350 de gasolina para el carro" →
{"intent":"REGISTRO","items":[
  {"tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Platina","concepto":"gasolina","monto":350,"medio_pago":"efectivo","fecha":"FECHA_HOY"}}
]}
"fuimos al cine con alicia 280 pesos" →
{"intent":"REGISTRO","items":[
  {"tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Ocio","concepto":"cine","monto":280,"medio_pago":"efectivo","comentarios":"Alicia","fecha":"FECHA_HOY"}}
]}
"50 tacos" →
{"intent":"REGISTRO","items":[
  {"tabla":"movimientos","accion":"crear","datos":{"tipo":"GASTO","categoria":"Comida","concepto":"tacos","monto":50,"medio_pago":"efectivo","fecha":"FECHA_HOY"}}
]}
"cuánto gasté este mes" → {"intent":"CONSULTA"}
"hola cómo estás" → {"intent":"CHARLA"}`;

// Fast path for multi-line gasto lists:  "-112 helados con alicia (débito)\n-216 tacos (efectivo)"
function tryParseBatch(text, today) {
  const MESES_NUM = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
    julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
  const CATS_KNOWN = ['Hogar','Comida','TDC','Despensa','Hormiga','Ocio','Personales','Platina','Transporte'];

  function normMedio(s) {
    const r = s.toLowerCase().trim();
    if (/tarjeta\s+d[eé]bito|t\.?\s*d[eé]bito|d[eé]bito/.test(r)) return 'débito';
    if (/efectivo/.test(r))      return 'efectivo';
    if (/transferencia/.test(r)) return 'transferencia';
    if (/bbva/.test(r))          return 'TDC BBVA';
    if (/\bhey\b/.test(r))       return 'TDC HEY';
    if (/liverpool/.test(r))     return 'TDC Liverpool';
    if (/amex/.test(r))          return 'TDC AMEX';
    if (/\bnu\b/.test(r))        return 'TDC NU';
    if (/rappi/.test(r))         return 'TDC Rappi';
    if (/palacio/.test(r))       return 'TDC Palacio';
    if (/tarjeta/.test(r))       return 'débito';
    return s.trim();
  }

  function normCat(s) {
    const r = s.toLowerCase().trim();
    return CATS_KNOWN.find(c => c.toLowerCase() === r) || 'OTROS';
  }

  function inferCatFromText(text) {
    const t = text.toLowerCase();
    if (/\b(gasolina|aceite|afina|suspensi|verificaci|tenencia|seguro.?coche|seguro.?auto|llanta|freno|bater[ií]a|refacci|platina)\b/.test(t)) return 'Platina';
    if (/\b(uber|didi|beat|lyft|cabify|metro\b|metrobus|metrobús|tren\b|combi\b|cami[oó]n\b|taxi\b|caseta)\b/.test(t)) return 'Transporte';
    if (/\b(taco|taqueria|taquería|restaur|fonda|torta|burger|hambur|sushi|pizza|café|cafe\b|starbucks|mc|kfc|domin|subway|antojito|alita|helado|nieve|pastor|carnitas|birria)\b/.test(t)) return 'Comida';
    if (/\b(walmart|wally|walties|chedraui|soriana|costco|sam.?s|bodega aurrera|la comer|city market|oxxo|7.?eleven|circle.?k|mercado\b|tianguis|abarrotes|super\b|súper\b|frutas|verduras|papel\b|jabón|jab[oó]n)\b/.test(t)) return 'Despensa';
    if (/\b(netflix|spotify|disney|hbo|prime.?video|apple.?tv|youtube.?premium|cine\b|teatro\b|concierto|bar\b|antro\b|botanero|cover\b|videojuego|steam\b|playstation|xbox|viaje\b|hotel\b|airbnb|regalo\b|flores\b)\b/.test(t)) return 'Ocio';
    if (/\b(doctor|dentista|psico|farmacia|medicina|pastilla|gym\b|gimnasio|spa\b|peluquer|barber|cosm[eé]tico|ropa\b|zapato|lentes\b|farmacias.?del.?ahorro|simi\b)\b/.test(t)) return 'Personales';
    if (/\b(renta\b|luz\b|agua\b|gas\b|internet\b|cable\b|predial|mantenimiento|home.?depot|ikea\b)\b/.test(t)) return 'Hogar';
    if (/\b(amazon\b|mercado.?libre|shein\b|aliexpress|suscripci[oó]n|app\b|dominio)\b/.test(t)) return 'Hormiga';
    if (/\b(m[ií]nimo|abono.?tdc|pago.?tarjeta|corte\b|adeudo)\b/.test(t)) return 'TDC';
    return 'OTROS';
  }

  function parseMonto(s) {
    // "3,458.10" → remove thousands comma → "3458.10"
    let c = s.replace(/,(\d{3}(?:[.,]|$))/g, '$1');
    // leftover decimal comma "3,45" → "3.45"
    c = c.replace(',', '.');
    return parseFloat(c);
  }

  // Reconoce una fecha dentro de un texto: "quincena 25 de junio", "10 de agosto", "10 agosto 2026"
  function parseFechaEnTexto(s) {
    const m = s.match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)(?:\s+(\d{4}))?/i);
    if (!m) return null;
    const mes = MESES_NUM[m[2].toLowerCase()];
    if (!mes) return null;
    const y = m[3] || today.slice(0, 4);
    return `${y}-${String(mes).padStart(2,'0')}-${String(parseInt(m[1])).padStart(2,'0')}`;
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // Detect any list line: "N.-" prefix or leading "-"
  if (!lines.some(l => /^(?:\d+\.-?\s+|-\s*)\d/.test(l))) return null;

  // ¿El bloque completo habla de gastos programados/presupuestados?
  const programadoCtx = /\bprogramad|\bpresupuest|\bplaneado|\bagendad|\bpr[oó]xim/i.test(text);

  const items = [];
  let currentDate = today;

  for (const line of lines) {
    // Date header: "11 de junio 2026", "13 junio 2026", "13 junio"
    const dateM = line.match(/^(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)(?:\s+(\d{4}))?$/i);
    if (dateM) {
      const m = MESES_NUM[dateM[2].toLowerCase()];
      if (m) {
        const y = dateM[3] || today.slice(0, 4);
        currentDate = `${y}-${String(m).padStart(2,'0')}-${String(parseInt(dateM[1])).padStart(2,'0')}`;
        continue;
      }
    }

    // List line: "N.- MONTO rest" or "- MONTO rest"
    const lineM = line.match(/^(?:\d+\.-?\s+|-\s*)(\d[\d.,]*)\s+(.+)$/);
    if (!lineM) continue;

    const monto = parseMonto(lineM[1]);
    if (isNaN(monto) || monto <= 0) continue;

    let rest = lineM[2].trim();
    let categoria = 'OTROS';
    let medio_pago = 'efectivo';

    // Extract all (...) groups
    const parens = [];
    rest = rest.replace(/\(([^)]+)\)/g, (_, inner) => { parens.push(inner.trim()); return ''; }).trim();

    // Strip trailing "Categoria WORD" or "categoria WORD"
    const catTrail = rest.match(/\s+[Cc]ategor[ií]a\s+(\w+)$/);
    if (catTrail) {
      const c = normCat(catTrail[1]);
      if (c !== 'OTROS') categoria = c;
      rest = rest.slice(0, -catTrail[0].length).trim();
    } else {
      // Trailing standalone word that matches a category (e.g. "… Ocio", "… PLATINA")
      const trailCap = rest.match(/\s+([A-ZÁÉÍÓÚa-záéíóú]{3,})$/);
      if (trailCap) {
        const c = normCat(trailCap[1]);
        if (c !== 'OTROS') { categoria = c; rest = rest.slice(0, -trailCap[0].length).trim(); }
      }
    }

    // Track Alicia mention for couple context
    let conAlicia = false;
    let itemDate = currentDate;   // fecha específica de este renglón (puede venir en paréntesis)

    // Classify each parenthesised group as medio, categoria o fecha
    for (const p of parens) {
      if (/^(alicia)$/i.test(p)) { conAlicia = true; continue; }
      if (/^(angel|ángel)$/i.test(p)) continue;
      const pLow = p.toLowerCase();
      // Fecha en paréntesis: "(quincena 25 de junio)", "(10 de agosto)"
      const fp = parseFechaEnTexto(p);
      if (fp && /quincena|\d{1,2}\s+(?:de\s+)?[a-záéíóú]+/i.test(pLow)) { itemDate = fp; continue; }
      if (/efectivo|d[eé]bito|transferencia|tdc|tarjeta|bbva|liverpool|amex|\bnu\b|rappi|palacio|\bhey\b/.test(pLow)) {
        medio_pago = normMedio(p);
      } else {
        const c = normCat(p);
        if (c !== 'OTROS') categoria = c;
      }
    }

    // Infer category from concepto when still unknown
    if (categoria === 'OTROS') {
      const fw = rest.split(/\s+/)[0];
      const c = normCat(fw);
      if (c !== 'OTROS') categoria = c;
      else categoria = inferCatFromText(rest);
    }

    // Clean concepto: strip trailing "con alicia/angel" and detect Alicia mention
    if (/\b(alicia|con\s+alicia|nosotros|fuimos|fueron)\b/i.test(rest)) conAlicia = true;
    const concepto = rest.replace(/\s+con\s+(alicia|angel|ángel)\s*$/i, '').trim() || 'Gasto';

    // Alicia → Ocio (Platina keeps priority if already set)
    if (conAlicia && categoria !== 'Platina') categoria = 'Ocio';

    const datos = { tipo:'GASTO', categoria, concepto, monto, medio_pago, fecha: itemDate };
    if (conAlicia) datos.comentarios = 'Alicia';
    // Gasto programado: contexto explícito o fecha futura → va al Presupuesto, no a movimientos
    if (programadoCtx || itemDate > today) datos.programado = true;
    items.push({ tabla:'movimientos', accion:'crear', datos });
  }

  return items.length ? { intent:'REGISTRO', items } : null;
}

async function extractIntentBatch(text, phone = '') {
  const today     = hoy();
  const _yd = new Date(today + 'T12:00:00'); _yd.setDate(_yd.getDate() - 1);
  const yesterday = _yd.toISOString().split('T')[0];

  // Fast path: list of gastos — no Gemini needed
  const fastBatch = tryParseBatch(text, today);
  if (fastBatch) return fastBatch;

  // Fast path: single gasté / borrar — regex only, no Gemini
  const t = text.trim();
  const SPEND_CON = /^(?:gasté|gaste|pagué|pague)\s+(\d+(?:\.\d+)?)\s+(?:en|de)\s+(.+?)\s+con\s+(.+)$/i;
  const SPEND     = /^(?:gasté|gaste|pagué|pague)\s+(\d+(?:\.\d+)?)\s+(?:en|de)\s+(.+)$/i;
  const DEL_MOV   = /^borrar\s+(?:el\s+)?movimiento\s+(\S+)\s*$/i;
  let mm;
  if ((mm = t.match(SPEND_CON))) return { intent:'REGISTRO', items:[{ tabla:'movimientos', accion:'crear', datos:{ tipo:'GASTO', categoria:'OTROS', concepto:mm[2].trim(), monto:parseFloat(mm[1]), medio_pago:mm[3].trim(), fecha:today } }] };
  if ((mm = t.match(SPEND)))     return { intent:'REGISTRO', items:[{ tabla:'movimientos', accion:'crear', datos:{ tipo:'GASTO', categoria:'OTROS', concepto:mm[2].trim(), monto:parseFloat(mm[1]), medio_pago:'efectivo', fecha:today } }] };
  if ((mm = t.match(DEL_MOV)))   return { intent:'ELIMINACION', items:[{ tabla:'movimientos', accion:'eliminar', id:mm[1], datos:{} }] };

  const currentYear = today.slice(0, 4);

  try {
    const model = genAI.getGenerativeModel({
      model:            'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      systemInstruction: _batchIntentPrompt
        .replace(/FECHA_HOY/g, today)
        .replace(/FECHA_AYER/g, yesterday)
        .replace(/FECHA_YEAR/g, currentYear),
    });
    const result = await geminiWithRetry(() => model.generateContent(text));
    logUsage(phone, 'gemini-2.5-flash', result.response.usageMetadata, 'batch-extractor');

    const json   = JSON.parse(result.response.text());
    const intent = (json.intent || 'CONSULTA').toUpperCase();
    let items    = [];

    if (['REGISTRO','EDICION','ELIMINACION'].includes(intent) && Array.isArray(json.items)) {
      items = json.items
        .filter(it => it.tabla && it.accion)
        .map(it => {
          const datos = { ...(it.datos || {}) };
          // Fallback: si no tiene fecha, usar hoy
          if (!datos.fecha) datos.fecha = today;
          // Corrección de año: si Gemini devuelve un año anterior al actual en un mov nuevo, corregir
          else if (datos.fecha && it.accion === 'crear' && it.tabla === 'movimientos') {
            const itemYear = parseInt(datos.fecha.slice(0, 4), 10);
            if (itemYear < parseInt(currentYear, 10)) {
              datos.fecha = currentYear + datos.fecha.slice(4);
            }
          }
          return { tabla: it.tabla, accion: it.accion, id: it.id || undefined, datos };
        });
    }

    return { intent, items };
  } catch (e) {
    console.error('extractIntentBatch error:', e.message);
    return { intent: 'CONSULTA', items: [] };
  }
}

function buildWebChatReply(execs) {
  const ok  = execs.filter(e => !e.result.startsWith('❌'));
  const err = execs.filter(e => e.result.startsWith('❌'));

  if (ok.length === 0) return err.map(e => e.result).join('\n');

  // Gastos programados (van a Presupuesto, no a movimientos)
  const prog = ok.filter(e => e.item._programado);
  // Movimientos reales (ya hechos)
  const movs = ok.filter(e => e.item.tabla === 'movimientos' && e.item.accion === 'crear' && !e.item._programado);

  const sections = [];

  if (movs.length === 1) {
    const d      = movs[0].item.datos;
    const icon   = d.tipo === 'INGRESO' ? '💰' : '💸';
    const cuando = d.fecha === hoy() ? 'hoy' : (d.fecha || 'hoy');
    sections.push(`Listo, registré: ${icon} ${fmt(d.monto)} · ${d.categoria} · ${d.concepto} · ${d.medio_pago || 'efectivo'} (${cuando}).`);
  } else if (movs.length > 1) {
    const lines = [`Listo, registré ${movs.length} movimientos:`];
    movs.forEach(e => {
      const d    = e.item.datos;
      const icon = d.tipo === 'INGRESO' ? '💰' : '💸';
      const cuando = d.fecha === hoy() ? 'hoy' : (d.fecha || 'hoy');
      lines.push(`  ${icon} ${fmt(d.monto)} · ${d.categoria} · ${d.concepto} · ${d.medio_pago || 'efectivo'} (${cuando})`);
    });
    sections.push(lines.join('\n'));
  }

  if (prog.length === 1) {
    const d = prog[0].item.datos;
    sections.push(`📅 Programé en tu Presupuesto: ${fmt(d.monto)} · ${d.concepto} → ${labelQuincena(prog[0].item._qKey)}.\n_Aún no cuenta como gasto hecho; cuando lo pagues, dímelo y lo registro._`);
  } else if (prog.length > 1) {
    const lines = [`📅 Programé ${prog.length} gastos en tu Presupuesto:`];
    prog.forEach(e => {
      const d = e.item.datos;
      lines.push(`  ${fmt(d.monto)} · ${d.concepto} → ${labelQuincena(e.item._qKey)}`);
    });
    lines.push('_Aún no cuentan como gastos hechos; cuando los pagues, dímelo y los registro._');
    sections.push(lines.join('\n'));
  }

  // Otras operaciones (metas, calendario, nidito, ediciones, etc.) sin resumen específico
  if (!movs.length && !prog.length) sections.push(ok.map(e => e.result).join('\n'));

  let reply = sections.join('\n\n');
  if (err.length) reply += `\n\n⚠️ No pude procesar ${err.length} operación(es): ${err.map(e => e.result).join(', ')}`;
  return reply;
}

// ── PROPOSE → CONFIRM ─────────────────────────────────────────────────────
async function proposeDbAction(phone, arg, textoOriginal) {
  // Si el texto menciona "Alicia" y es un gasto nuevo, anotarlo en comentarios
  if (
    arg.tabla === 'movimientos' && arg.accion === 'crear' &&
    /alicia/i.test(textoOriginal || '')
  ) {
    arg = { ...arg, datos: { ...arg.datos, comentarios: 'Alicia' } };
  }

  const { tabla, accion, datos } = arg;

  const programado = accion === 'crear' && tabla === 'movimientos' && esGastoProgramado(datos, hoy());

  // Auto-confirm: crear movimiento con patrón conocido (contador≥5, diff≤30%, monto<5000)
  // Nunca auto-confirmar un gasto programado: siempre se confirma explícitamente.
  if (!programado && accion === 'crear' && tabla === 'movimientos' && (datos?.monto || 0) < 5000) {
    const concepto = (datos?.concepto || '').toLowerCase().trim();
    if (concepto) {
      const { data: patron } = await sb.from('patrones_ia')
        .select('*').eq('user_phone', phone).eq('concepto_clave', concepto).maybeSingle();
      if (patron && patron.contador >= 5 && patron.monto_promedio > 0) {
        const diff = Math.abs(((datos.monto || 0) - patron.monto_promedio) / patron.monto_promedio);
        if (diff <= 0.30) {
          await executeDbAction(phone, arg, 'auto_confirm');
          return {
            auto: true,
            msg: `✓ ${fmt(datos.monto)} · ${datos.categoria || 'OTROS'} · responde *deshacer* para revertir`,
          };
        }
      }
    }
  }

  // Construir texto de propuesta según accion/tabla
  let propuesta;
  if (accion === 'crear') {
    let resumen;
    const d = datos || {};
    if (tabla === 'movimientos' && programado) {
      resumen = `📅 Gasto PROGRAMADO (va a tu Presupuesto, no como gasto hecho):\n${fmt(d.monto || 0)} · ${d.concepto || ''} → ${labelQuincena(getQuincena(d.fecha || hoy()).key)}`;
    } else if (tabla === 'movimientos') {
      const fechaStr = d.fecha === hoy() ? 'hoy' : (d.fecha || hoy());
      const icon = d.tipo === 'INGRESO' ? '💰' : '💸';
      resumen = `${icon} ${fmt(d.monto || 0)} · ${d.categoria || 'OTROS'} · ${d.concepto || ''} · ${d.medio_pago || 'efectivo'} · ${fechaStr}`;
    } else if (tabla === 'calendario') {
      resumen = `📅 ${d.fecha || ''} ${d.hora || ''} — ${d.titulo || ''}`;
    } else if (tabla === 'metas') {
      resumen = `🎯 Meta: ${d.nombre || ''} — ${fmt(d.meta || 0)}`;
    } else if (tabla === 'nidito') {
      const { data: usr } = await sb.from('usuarios').select('nombre').eq('telefono', phone).maybeSingle();
      const nombreCreador = usr?.nombre || 'tú';
      resumen = `💫 Nidito (${d.tipo || 'idea'}): ${d.titulo || ''}${d.monto > 0 ? ' · ' + fmt(d.monto) : ''}\n_Compartido — visible para ambos. Crea: ${nombreCreador}_`;
    } else {
      resumen = `${tabla}: ${JSON.stringify(d)}`;
    }
    propuesta = `Voy a registrar:\n${resumen}\n\n*1* Sí · *2* Editar · *3* No`;
  } else if (accion === 'editar') {
    const { id } = arg;
    const { data: before } = await sb.from(tabla).select('*').eq('id', id).maybeSingle();
    let changes = '(sin cambios detectados)';
    if (before && datos) {
      const lines = Object.entries(datos)
        .filter(([k, v]) => before[k] !== v && k !== 'updated_at')
        .map(([k, v]) => `  ${k}: *${before[k]}* → *${v}*`);
      if (lines.length) changes = lines.join('\n');
    }
    propuesta = `¿Editar ${tabla}#${id}?\n${changes}\n\n*1* Sí · *2* Editar · *3* No`;
  } else if (accion === 'eliminar') {
    const { id } = arg;
    const { data: before } = await sb.from(tabla).select('*').eq('id', id).maybeSingle();
    let detalle = `${tabla}#${id}`;
    if (before && tabla === 'movimientos') {
      detalle = `${before.tipo === 'GASTO' ? '💸' : '💰'} ${before.fecha} | ${before.categoria} | ${before.concepto || ''} | ${fmt(before.monto)}`;
    } else if (before) {
      detalle = JSON.stringify(before, null, 2);
    }
    propuesta = `¿Eliminar este registro?\n${detalle}\n\n*1* Sí · *3* No`;
  } else {
    propuesta = `Ejecutar: ${tabla}.${accion}\n\n*1* Sí · *3* No`;
  }

  const { error: insertErr } = await sb.from('acciones_pendientes').insert({
    user_phone: phone,
    tipo:       'db_action',
    datos:      { ...arg, texto_original: textoOriginal },
    estado:     'pending',
    expira_at:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  if (insertErr) console.error('[proposeDbAction] insert error:', insertErr.message, JSON.stringify(arg).slice(0,120));

  return { auto: false, msg: propuesta };
}

// ── RECEIPT EXTRACTOR (Gemini Flash + imagen) ────────────────────────────────
// Intenta extraer datos de un ticket/recibo simple. Devuelve null si no es recibo.
async function extractReceiptInfo(b64, mime, phone = '') {
  try {
    const model = genAI.getGenerativeModel({
      model:            'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });
    const result = await geminiWithRetry(() => model.generateContent([
      { inlineData: { mimeType: mime, data: b64 } },
      'Extrae datos de este ticket/recibo de compra. Si la imagen NO es un recibo o ticket simple (es estado de cuenta bancario, screenshot, foto de comida, etc.) responde {"es_recibo":false}. Si SÍ es un recibo con monto visible responde: {"es_recibo":true,"monto_total":número,"comercio":"nombre","fecha":"YYYY-MM-DD"}',
    ]));
    logUsage(phone, 'gemini-2.5-flash', result.response.usageMetadata, 'vision');
    const data = JSON.parse(result.response.text());
    if (!data.es_recibo || !data.monto_total) return null;
    return data;
  } catch (e) {
    console.error('extractReceiptInfo error:', e.message);
    return null;
  }
}

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
// Devuelve { static, dynamic } para que los callers apliquen cache_control
// en el bloque estático. intent='CONSULTA' incluye últimos 10 movimientos.
async function buildSystemPrompt(user, intent = 'CONSULTA') {
  const today = hoy();
  const phone = user.telefono;
  const mesStr = mes();

  // Fetches paralelos — movimientos solo se trae con detalle en CONSULTA
  const movsLimit = intent === 'CONSULTA' ? 10 : 0;
  const [tdcR, movsR, metasR, calR, patrR, prspR, niditoR] = await Promise.all([
    sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
    movsLimit > 0
      ? sb.from('movimientos').select('*').eq('user_phone', phone).is('deleted_at', null)
          .order('created_at', { ascending: false }).limit(movsLimit)
      : Promise.resolve({ data: [] }),
    sb.from('metas').select('*').eq('user_phone', phone).is('deleted_at', null),
    sb.from('calendario').select('*').eq('user_phone', phone).is('deleted_at', null)
        .gte('fecha', today).order('fecha').limit(10),
    sb.from('patrones_ia').select('*').eq('user_phone', phone)
        .order('contador', { ascending: false }).limit(10),
    sb.from('presupuesto').select('*').eq('user_phone', phone).eq('mes', mesStr),
    sb.from('nidito').select('*').is('deleted_at', null)
        .order('prioridad', { ascending: false }).limit(20),
  ]);

  // Para gastos/ingresos del mes siempre necesitamos un agregado ligero
  const [aggrR] = await Promise.all([
    sb.from('movimientos').select('tipo,categoria,monto,fecha')
      .eq('user_phone', phone).is('deleted_at', null)
      .gte('fecha', mesStr + '-01'),
  ]);

  const tdcs     = tdcR.data    || [];
  const movs     = movsR.data   || [];
  const metas    = metasR.data  || [];
  const eventos  = calR.data    || [];
  const patrones = patrR.data   || [];
  const presp    = prspR.data   || [];
  const nidito   = niditoR.data || [];
  const aggrMovs = aggrR.data   || [];
  const refs     = user.external_refs || {};

  const gastMes = aggrMovs.filter(m => m.tipo === 'GASTO').reduce((a, m) => a + (m.monto || 0), 0);
  const ingrMes = aggrMovs.filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + (m.monto || 0), 0);

  const catLines = CATEGORIAS.map(cat => {
    const tot = aggrMovs.filter(m => m.tipo === 'GASTO' && m.categoria === cat)
                        .reduce((a, m) => a + (m.monto || 0), 0);
    if (!tot) return null;
    const lim    = presp.find(p => p.categoria === cat)?.limite || 0;
    const alerta = lim > 0 && tot > lim * 0.85 ? ' ⚠️ CERCA DEL LÍMITE' : '';
    return `  ${cat}: ${fmt(tot)}${lim > 0 ? ` / límite ${fmt(lim)}` : ''}${alerta}`;
  }).filter(Boolean).join('\n');

  let ghost = '';
  if (user.role === 'ADMIN_A') {
    const { data: otros } = await sb.from('movimientos').select('*')
      .neq('user_phone', phone).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(20);
    ghost = `\n[MODO FANTASMA — últimos movs Sujeto B]\n${JSON.stringify(otros)}`;
  }

  // ── Bloque estático (cacheable) — reglas y esquemas que no cambian ─────────
  const staticBlock = `Eres Finn, el asistente financiero personal de Ángel.

CONTEXTO DE PAREJA:
- Usuario: Ángel. Novia: Alicia. Comparten vida y gastos cotidianos.
- "Platina" = su coche (Nissan). Gasolina, aceite, afinación, refacciones, verificación → categoria:"Platina".
- "Alicia/ella/mi novia/nosotros/fuimos/fueron" → comentarios:"Alicia" + categoria:"Ocio" automático.
- "Platina" tiene prioridad sobre la regla de Ocio (un gasto de coche no es Ocio).
- Nunca trates a Alicia o Ángel como medio de pago; son personas mencionadas en el contexto.

VOCABULARIO COLOQUIAL MX:
- "varo/lana/feria/bil/billete/biyuyo" = dinero; interpreta como monto en contexto.
- "hay que sacar/le saqué/le metí/le di/le eché" = gasto.
- "me cayeron/me cayó/me entraron" = ingreso.
- "agarré la BBVA/cargué a la AMEX/lo puse en la NU" = medio de pago concreto.
- "del Wally/del Walties" = Walmart → Despensa.
- Tolerar ortografía: "gaste/pague/compre" (sin acento) = equivalente con acento.

CATEGORIZACIÓN AUTOMÁTICA:
Transporte:  Uber, DiDi, Beat, Lyft, Cabify, metro, metrobús, tren, combi, camión, taxi, caseta peaje
Platina:     gasolina, aceite, afinación, suspensión, verificación, tenencia, seguro coche, llanta, frenos, batería, refacción auto
Comida:      tacos, taquería, restaurante, fonda, comida corrida, torta, burger, sushi, pizza, café, Starbucks, McDonald's, KFC, Domino's, antojitos, alitas, helado, panadería
Despensa:    Walmart, Wally, Chedraui, Soriana, Costco, Sam's, Bodega Aurrera, La Comer, City Market, Oxxo, 7-Eleven, mercado, abarrotes, súper, frutas, verduras, papel, limpieza hogar
Hogar:       renta, luz, agua, gas (hogar), internet, cable, teléfono, predial, mantenimiento depto, mueble, electrodoméstico, HomeDepot, IKEA
Ocio:        Netflix, Spotify, Disney+, HBO, Prime, Apple TV, YouTube Premium, cine, teatro, concierto, bar, antro, botanero, cover, videojuego, Steam, PlayStation, Xbox, viaje, hotel, Airbnb, regalo, flores
Personales:  doctor, dentista, psicólogo, farmacia, medicina, pastilla, gym, spa, peluquería, barbería, cosméticos, ropa, zapatos, lentes, Farmacias del Ahorro, Simi
TDC:         pago mínimo tarjeta, abono TDC, corte [banco]
Hormiga:     Amazon, Mercado Libre, Shein, AliExpress, suscripción, app, dominio, compra online pequeña

TONO Y ESTILO:
- Respuestas cortas y directas. Sin relleno. Sin cascadas de emojis.
- Un emoji máximo por respuesta; omítelo si el contexto no lo pide.
- Consultas: máx 4 párrafos. Registros confirmados: máx 2 líneas, formato "✓ $580 · Comida · Uber Eats".
- Habla con naturalidad, como un asesor cercano que ya conoce al usuario.

REGLAS DE ACCIÓN:
- TIENES PODER DE ACCIÓN: usa 'modificar_plataforma' cuando la información sea clara.
- "gasté X en Y" (monto + concepto claros) → llama la herramienta sin preguntar.
- Información AMBIGUA o falta algo CRÍTICO → pregunta en una sola línea antes de registrar.
- Nidito y calendario: infiere detalles razonables sin preguntar.
- Nota de voz: mismas reglas, confía en la transcripción.
- SISTEMA DE CONFIRMACIÓN: cuando llames 'modificar_plataforma', tu texto debe ser vacío o máx 1 línea de contexto. La propuesta la maneja el sistema. NUNCA digas que algo quedó guardado.
- DETECTA PATRONES: si gasta mucho en algo vs historial, avísalo en 1 línea.
- PROYECCIONES: cuando des estimaciones de gasto futuro, tendencias o proyecciones de fin de mes, añade al final "— estimación basada en tu historial" (solo en respuestas analíticas; nunca en confirmaciones de registro ni comandos simples).

CAMPOS OBLIGATORIOS para movimientos.crear (tipo GASTO):
  tipo: "GASTO"
  categoria: una de [${CATEGORIAS.join(', ')}]
  concepto: producto/servicio específico ("Uber", "McDonald's", "mínimo BBVA")
  comentarios: observaciones — puede estar vacío; usa "Alicia" cuando corresponda
  monto: número
  medio_pago: uno de [${MEDIOS_PAGO.join(', ')}] — default "efectivo"
  fecha: YYYY-MM-DD
  programado: true SOLO si es un gasto FUTURO/planeado (ver regla abajo)

GASTO PROGRAMADO vs GASTO YA HECHO (¡importante!):
- Gasto ya hecho (pasado/hoy): "gasté/pagué/compré X" → movimiento normal (sin programado).
- Gasto PROGRAMADO/futuro: el usuario PLANEA o PRESUPUESTA un gasto que aún no ocurre ("voy a / programa / presupuesta / para la quincena del 25 / el próximo mes" o cualquier fecha futura).
  → Añade programado:true y la fecha del gasto. El sistema lo guarda en el Presupuesto de la quincena correspondiente, NO como gasto hecho. Cuando el usuario lo pague de verdad, se registra como movimiento normal en ese momento.

Para INGRESO: tipo="INGRESO", categoria="OTROS", concepto=fuente del ingreso, monto, fecha.
Para calendario.crear: titulo, fecha (YYYY-MM-DD), hora (HH:MM), tipo, descripcion.
Para nidito: titulo, descripcion, tipo (meta/idea/wishlist/plan/nota), emoji, monto, prioridad.

════════ REGLAS DE MODIFICACIÓN ════════
- tabla="usuarios" datos={campo: valor}: merge automático, no sobreescribe campos no enviados.
- NÚMEROS: Siempre números puros. "$14,843.72" → 14843.72 (coma=miles, punto=decimal). NUNCA truncar.
- tabla="movimientos" accion="editar" id=X datos={campo: nuevo_valor}: corrige un movimiento existente.
- Sueldo quincenal: tabla="usuarios", datos={ ingreso_quincenal: X, dias_pago:[D1,D2], ingresos_esperados:[{descripcion:"Sueldo",monto:X,dias:[D1,D2]}] }
- Ingreso recurrente extra: tabla="usuarios", datos={ ingresos_esperados:[...existentes, {descripcion:"X",monto:Y,dias:[dia]}] }
- Gasto fijo: tabla="usuarios", datos={ gastos_esperados:[...existentes,{descripcion:"X",monto:Y}], gastos_fijos:{...existentes,X:Y} }
- Presupuesto mensual por categoría: una llamada a tabla="presupuesto" POR cada categoría.`;

  // ── Bloque dinámico (por request) — datos del día ─────────────────────────
  const date3m = new Date(new Date().setMonth(new Date().getMonth() + 3)).toISOString().split('T')[0];
  const prspLines = presp.length
    ? presp.map(p => {
        const gastado = aggrMovs.filter(m => m.tipo === 'GASTO' && m.categoria === p.categoria)
                                .reduce((a, m) => a + (m.monto || 0), 0);
        return `  ${p.categoria}: límite ${fmt(p.limite)} | gastado ${fmt(gastado)}`;
      }).join('\n')
    : '  Sin límites. Usa: "pon límite de $X en categoría Y"';

  const rebalSugs = calcRebalanceo(
    presp, aggrMovs.filter(m => m.tipo === 'GASTO'),
    new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate(),
    new Date().getDate()
  );
  const rebalLine = rebalSugs.length
    ? `\nREBALANCEO DISPONIBLE: ${rebalSugs.map(s => `mover ${fmt(s.monto)} de ${s.de} → ${s.hacia}`).join('; ')}. Menciónalo si el usuario pregunta sobre presupuesto o gastos altos.`
    : '';
  const infoLines = [
    refs.ingreso_quincenal
      ? `  Ingreso quincenal: ${fmt(refs.ingreso_quincenal)} | Días de pago: ${(refs.dias_pago||[]).join(' y ')}`
      : '  Ingreso quincenal: no configurado.',
    Array.isArray(refs.ingresos_esperados) && refs.ingresos_esperados.length
      ? `  Ingresos esperados:\n${refs.ingresos_esperados.map(i=>`    • ${i.descripcion}: ${fmt(i.monto)} días ${(i.dias||[]).join(',')}`).join('\n')}`
      : '',
    Array.isArray(refs.gastos_esperados) && refs.gastos_esperados.length
      ? `  Gastos fijos:\n${refs.gastos_esperados.map(g=>`    • ${g.descripcion}: ${fmt(g.monto)}`).join('\n')}`
      : refs.gastos_fijos
        ? `  Gastos fijos:\n${Object.entries(refs.gastos_fijos).map(([k,v])=>`    • ${k}: ${fmt(v)}`).join('\n')}`
        : '  Gastos fijos: no configurados.',
  ].filter(Boolean).join('\n');

  const movsSection = intent === 'CONSULTA' && movs.length
    ? `\nÚLTIMOS ${movs.length} MOVIMIENTOS:\n${movs.map(m=>`  [${m.id}] ${m.fecha} ${m.tipo} ${m.categoria} "${m.concepto||''}" ${fmt(m.monto)} ${m.medio_pago||''}`).join('\n')}`
    : '';

  const dynamicBlock = `Hoy: ${today} | Mes: ${mesStr}
Si dice "en 3 meses" → fecha ${date3m}. Si dice "en X días" → suma X a ${today}.
tabla="presupuesto" datos={categoria, limite, mes:"${mesStr}"}.

════════ DATOS FINANCIEROS ════════
GASTOS MES: ${fmt(gastMes)} | INGRESOS: ${fmt(ingrMes)} | NETO: ${fmt(ingrMes - gastMes)}

POR CATEGORÍA (${mesStr}):
${catLines || '  (sin gastos este mes)'}

PRESUPUESTO:
${prspLines}${rebalLine}

INFO PERSONAL:
${infoLines}

DEUDAS TDC:
${tdcs.map(t=>`  [${t.id}] ${t.nombre} (${t.estado}): pago ${fmt(t.a_pagar)} saldo ${fmt(Math.max(0,(t.a_pagar||0)-(t.pagado||0)))}`).join('\n')||'  Sin TDC'}
${movsSection}
METAS: ${metas.map(m=>`[${m.id}] ${m.nombre}: ${fmt(m.actual)}/${fmt(m.meta)}`).join(' | ')||'Sin metas'}

PRÓXIMOS EVENTOS:
${eventos.map(e=>`  [${e.id}] ${e.fecha}: ${e.titulo}`).join('\n')||'  Calendario vacío'}

PATRONES:
${patrones.map(p=>`  ${p.concepto_clave}: promedio ${fmt(p.monto_promedio)}, ${p.contador}x, medio: ${p.medio_pago_usual||'?'}`).join('\n')||'  Sin patrones'}

NIDITO:
${nidito.map(n=>`  [${n.id}] ${n.emoji||'💫'} ${n.tipo?.toUpperCase()}: "${n.titulo}"${n.monto>0?' '+fmt(n.monto):''}${n.completado?' ✅':''}`).join('\n')||'  Nidito vacío'}
Para nidito usa tabla="nidito".${ghost}`;

  return { static: staticBlock, dynamic: dynamicBlock };
}

// ── QUICK COMMANDS ─────────────────────────────────────────────────────────
async function cmdResumen(phone) {
  const today = hoy();
  const mesStr = mes();
  const [{ data: hoyMovs }, { data: mesMovs }, { data: tdcs }, { data: evts }] = await Promise.all([
    sb.from('movimientos').select('*').eq('user_phone', phone).eq('fecha', today).is('deleted_at', null),
    sb.from('movimientos').select('*').eq('user_phone', phone).gte('fecha', mesStr + '-01').is('deleted_at', null),
    sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
    sb.from('calendario').select('*').eq('user_phone', phone).is('deleted_at', null).gte('fecha', today).order('fecha').limit(3),
  ]);
  const gasHoy = (hoyMovs||[]).filter(m=>m.tipo==='GASTO').reduce((a,m)=>a+m.monto,0);
  const ingHoy = (hoyMovs||[]).filter(m=>m.tipo==='INGRESO').reduce((a,m)=>a+m.monto,0);
  const gasMes = (mesMovs||[]).filter(m=>m.tipo==='GASTO').reduce((a,m)=>a+m.monto,0);
  const ingMes = (mesMovs||[]).filter(m=>m.tipo==='INGRESO').reduce((a,m)=>a+m.monto,0);
  const tdcPend = (tdcs||[]).reduce((a,t)=>a+Math.max(0,(t.a_pagar||0)-(t.pagado||0)),0);
  let txt = `📊 *RESUMEN*\n📅 ${today}\n\n*Hoy*\n💸 ${fmt(gasHoy)} | 💵 ${fmt(ingHoy)}\n\n*Mes ${mesStr}*\n💸 ${fmt(gasMes)} | 💵 ${fmt(ingMes)}\n📈 Neto: ${fmt(ingMes-gasMes)}\n\n*TDC pendiente:* ${fmt(tdcPend)}`;
  if (evts?.length) txt += `\n\n*Próximos eventos:*\n${evts.map(e=>`📅 ${e.fecha}: ${e.titulo}`).join('\n')}`;
  return txt;
}

async function cmdDeudas(phone) {
  const { data: tdcs } = await sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad');
  if (!tdcs?.length) return '💳 Sin deudas registradas.';
  const total = tdcs.reduce((a,t)=>a+Math.max(0,(t.a_pagar||0)-(t.pagado||0)),0);
  return `💳 *DEUDAS TDC* — Total: ${fmt(total)}\n\n${tdcs.map(t=>`*${t.nombre}* (${t.estado})\nSaldo: ${fmt(Math.max(0,(t.a_pagar||0)-(t.pagado||0)))} | Obj: ${t.mes_objetivo||'—'}`).join('\n\n')}`;
}

async function cmdHistorial(phone) {
  const { data: movs } = await sb.from('movimientos').select('*').eq('user_phone', phone).is('deleted_at', null).order('created_at', { ascending: false }).limit(10);
  if (!movs?.length) return '📋 Sin movimientos.';
  return `📋 *ÚLTIMOS MOVIMIENTOS*\n\n${movs.map(m=>`${m.tipo==='GASTO'?'💸':'💰'} [${m.id}] ${m.fecha} | ${m.categoria} | ${m.concepto||''} | ${fmt(m.monto)} | ${m.medio_pago||''}`).join('\n')}`;
}

async function cmdCalendario(phone) {
  const today = hoy();
  const { data: evts } = await sb.from('calendario').select('*').eq('user_phone', phone).is('deleted_at', null).gte('fecha', today).order('fecha').limit(10);
  if (!evts?.length) return '📅 Calendario vacío.';
  return `📅 *PRÓXIMOS EVENTOS*\n\n${evts.map(e=>`[${e.id}] *${e.fecha}*${e.hora?' '+e.hora:''} — ${e.titulo}${e.descripcion?'\n   '+e.descripcion:''}`).join('\n\n')}`;
}

// ── TOOLS SCHEMA ───────────────────────────────────────────────────────────
const toolsSchema = {
  name: "modificar_plataforma",
  description: "Crea, edita o elimina registros en: movimientos, metas, calendario, tdc, presupuesto, nidito (metas/ideas/wishlist compartidas entre Ángel y Alicia).",
  input_schema: {
    type: "object",
    properties: {
      tabla:  { type: "string", enum: ["movimientos","metas","calendario","tdc","presupuesto","nidito"] },
      accion: { type: "string", enum: ["crear","editar","eliminar"] },
      id:     { type: "string", description: "ID a editar/eliminar" },
      datos:  { type: "object", description: "Campos a insertar/actualizar. Para movimientos: tipo, categoria, concepto, comentarios, monto, medio_pago, fecha. Para calendario: titulo, fecha, hora, tipo, descripcion, recurrente. Para nidito: titulo, descripcion, tipo (meta/idea/wishlist/plan/nota), emoji, monto, completado, prioridad." }
    },
    required: ["tabla","accion"]
  }
};

const geminiTools = [{ functionDeclarations: [{ name: "modificar_plataforma", description: "Crea, edita o elimina registros en la plataforma. Para guardar info personal del usuario (ingreso quincenal, días de pago, etc.) usa tabla='usuarios'. Para nidito (espacio compartido) usa tabla='nidito'.", parameters: { type: "OBJECT", properties: { tabla: { type: "STRING", enum: ["movimientos","metas","calendario","tdc","presupuesto","nidito","usuarios"], description: "Tabla destino. Usa 'usuarios' para datos personales/configuración, 'presupuesto' para límites por categoría, 'movimientos' para ingresos/gastos." }, accion: { type: "STRING", enum: ["crear","editar","eliminar"] }, id: { type: "STRING", description: "ID del registro a editar o eliminar (omitir en crear)" }, datos: { type: "OBJECT", description: "Para 'usuarios': {ingreso_quincenal, dias_pago, ...}. Para 'presupuesto': {categoria, limite, mes}. Para 'movimientos': {monto, tipo, categoria, descripcion, fecha}." } }, required: ["tabla","accion","datos"] } }] }];

// ── LLM ENGINE ─────────────────────────────────────────────────────────────

// Ejecuta tool calls DIRECTAMENTE (sin confirmación) y devuelve el resumen estilo web.
// Usado por el chat web (PWA/móvil): los registros son inmediatos, sin menú interactivo.
async function execToolsDirect(phone, argsList, textoOriginal = '') {
  const execs = [];
  for (const args of argsList) {
    // Mismo objeto a executeDbAction y a execs: así se preserva el flag _programado
    // que executeDbAction marca en sitio (lo usa buildWebChatReply).
    const item = { ...args, texto_original: textoOriginal };
    const result = await executeDbAction(phone, item, 'web');
    execs.push({ item, result });
  }
  return buildWebChatReply(execs);
}

// Claude con tool calling — direct=true ejecuta sin confirmación (web); false propone (WhatsApp)
async function callClaude(user, sysBlocks, messages, text, phone, direct = false) {
  if (!anthropic) {
    // Fallback a Gemini si Anthropic no está configurado
    const geminiHistory = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    return callGemini(user, sysBlocks, geminiHistory, text, phone, direct);
  }
  const model = user.ai_model || 'claude-sonnet-4-6';
  const msgs = [...messages, { role: 'user', content: text }];

  // sysBlocks puede ser { static, dynamic } (Sprint 2) o string legado
  const system = (sysBlocks && typeof sysBlocks === 'object' && sysBlocks.static)
    ? [
        { type: 'text', text: sysBlocks.static, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: sysBlocks.dynamic },
      ]
    : sysBlocks;

  const res = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system,
    tools: [toolsSchema],
    messages: msgs,
  });
  logUsage(phone, model, res.usage, 'conversador');

  let aiText = '';
  const toolUses = [];
  for (const block of res.content) {
    if (block.type === 'text') aiText += block.text;
    else if (block.type === 'tool_use') toolUses.push(block);
  }

  if (toolUses.length > 0) {
    if (direct) {
      // Web: ejecutar directo, sin menú de confirmación
      const directReply = await execToolsDirect(phone, toolUses.map(t => t.input), text);
      return [aiText.trim(), directReply].filter(Boolean).join('\n\n');
    }
    // WhatsApp: proposeDbAction decide auto-confirm o propuesta — short-circuit sin segundo turno
    const results = await Promise.all(toolUses.map(t => proposeDbAction(phone, t.input, text)));
    const proposalMsg = results.map(r => r.msg).join('\n');
    return [aiText.trim(), proposalMsg].filter(Boolean).join('\n\n');
  }

  return aiText;
}

// Gemini con function calling — direct=true ejecuta sin confirmación (web); false propone (WhatsApp)
async function callGemini(user, sysBlocks, geminiHistory, text, phone, direct = false) {
  // sysBlocks puede ser { static, dynamic } (Sprint 2) o string legado
  const systemInstruction = (sysBlocks && typeof sysBlocks === 'object' && sysBlocks.static)
    ? sysBlocks.static + '\n\n' + sysBlocks.dynamic
    : sysBlocks;

  const model = genAI.getGenerativeModel({
    model: user.ai_model || 'gemini-2.5-flash',
    tools: geminiTools,
    systemInstruction,
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });

  // Garantizar alternancia user→model
  const safeHist = [];
  for (const msg of geminiHistory) {
    if (safeHist.length === 0 && msg.role !== 'user') continue;
    if (safeHist.length > 0 && safeHist[safeHist.length - 1].role === msg.role) continue;
    safeHist.push(msg);
  }
  if (safeHist.length > 0 && safeHist[safeHist.length - 1].role === 'user') safeHist.pop();

  const chat = model.startChat({ history: safeHist });
  const res = await geminiWithRetry(() => chat.sendMessage(text));
  logUsage(phone, user.ai_model || 'gemini-2.5-flash', res.response.usageMetadata, 'conversador');
  const calls = res.response.functionCalls();

  if (calls?.length) {
    // Web: ejecutar directo, sin menú de confirmación
    if (direct) return await execToolsDirect(phone, calls.map(c => c.args), text);
    // WhatsApp: proponer confirmación
    const results = await Promise.all(calls.map(c => proposeDbAction(phone, c.args, text)));
    return results.map(r => r.msg).join('\n');
  }

  return res.response.text();
}

// Dispatcher que enruta por preferencia del usuario. direct=true → ejecuta sin
// confirmación (chat web/PWA); false → propone con menú (WhatsApp).
async function callIA(user, sysBlocks, text, phone, direct = false) {
  const dbHistory = await cargarHistorial(phone);

  if (user.ai_preference === 'CLAUDE') {
    return callClaude(user, sysBlocks, dbHistory, text, phone, direct);
  } else {
    const geminiHistory = dbHistory.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    return callGemini(user, sysBlocks, geminiHistory, text, phone, direct);
  }
}

// ── REST API DASHBOARD ─────────────────────────────────────────────────────
app.get('/api/dashboard/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    // Auto-create usuario si accede por primera vez desde la web
    const { data: existing } = await sb.from('usuarios').select('id').eq('telefono', phone).maybeSingle();
    if (!existing) {
      await sb.from('usuarios').insert([{ telefono: phone, role: 'USER_B', ai_preference: 'GEMINI' }]);
    }
    const [tdc, movs, metas, user, cal, pat, presp, nidAsig, nidDin] = await Promise.all([
      sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
      sb.from('movimientos').select('*').eq('user_phone', phone).is('deleted_at', null).order('fecha', { ascending: false }).limit(500),
      sb.from('metas').select('*').eq('user_phone', phone).is('deleted_at', null),
      sb.from('usuarios').select('*').eq('telefono', phone).single(),
      sb.from('calendario').select('*').eq('user_phone', phone).is('deleted_at', null).order('fecha'),
      sb.from('patrones_ia').select('*').eq('user_phone', phone).order('contador', { ascending: false }),
      sb.from('presupuesto').select('*').eq('user_phone', phone),
      sb.from('nidito_asignaciones')
        .select('monto_quincenal, nidito_items!inner(deleted_at)')
        .eq('user_phone', phone)
        .is('nidito_items.deleted_at', null),
      sb.from('nidito_dinerito').select('monto').eq('user_phone', phone).eq('quincena_key', getQuincenaActual().key).maybeSingle(),
    ]);
    const nidito_compromiso   = (nidAsig.data || []).reduce((a, r) => a + (r.monto_quincenal || 0), 0);
    const nidito_dinerito_val = nidDin.data?.monto || 0;
    res.json({ success: true, data: {
      tdc: tdc.data, movs: movs.data, metas: metas.data, user: user.data,
      calendario: cal.data, patrones: pat.data, presupuesto: presp.data,
      nidito: {
        compromiso_quincenal: nidito_compromiso,
        dinerito_quincenal:   nidito_dinerito_val,
        total_quincenal:      nidito_compromiso + nidito_dinerito_val,
      },
      nidito_compromiso,
      nidito_dinerito: nidito_dinerito_val,
    }});
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Lista todos los usuarios (para ghost mode del admin)
app.get('/api/usuarios', async (req, res) => {
  try {
    const { data } = await sb.from('usuarios').select('telefono, nombre, role, ai_preference');
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── WHOAMI — detecta rol y preferencias del usuario por teléfono ──────────
app.get('/api/whoami/:phone', async (req, res) => {
  try {
    const raw   = decodeURIComponent(req.params.phone);
    const phone = 'whatsapp:+' + raw.replace(/\D/g, '');
    const { data } = await sb.from('usuarios')
      .select('nombre, role, ai_preference, ai_model')
      .eq('telefono', phone)
      .single();
    if (!data) return res.status(404).json({ error: 'not found' });
    return res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/movimientos', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('movimientos').insert({ ...d, user_phone }).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    if (d.tipo === 'GASTO') await learnPattern(user_phone, d);
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/movimientos/:id', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('movimientos').update(d).eq('id', req.params.id).eq('user_phone', user_phone).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/movimientos/:id', async (req, res) => {
  try {
    const { user_phone, ...fields } = req.body;
    if (!user_phone) return res.status(400).json({ success: false, error: 'Falta user_phone' });
    const allowed = ['revisado', 'categoria'];
    const update = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(update).length) return res.status(400).json({ success: false, error: 'Sin campos válidos' });
    const { data, error } = await sb.from('movimientos').update(update).eq('id', req.params.id).eq('user_phone', user_phone).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/movimientos/:id', async (req, res) => {
  try {
    const { user_phone } = req.body;
    const { error } = await sb.from('movimientos').delete().eq('id', req.params.id).eq('user_phone', user_phone);
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/calendario', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('calendario').insert({ ...d, user_phone }).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/calendario/:id', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('calendario').update(d).eq('id', req.params.id).eq('user_phone', user_phone).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/calendario/:id', async (req, res) => {
  try {
    const { user_phone } = req.body;
    const { error } = await sb.from('calendario').delete().eq('id', req.params.id).eq('user_phone', user_phone);
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/preferencia', async (req, res) => {
  try {
    const { phone, ai_preference } = req.body;
    await sb.from('usuarios').update({ ai_preference }).eq('telefono', phone);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── NIDITO v8 — items, asignaciones, comentarios, dinerito ───────────────────

app.get('/api/nidito/items', async (req, res) => {
  try {
    const { tipo, estado, phone } = req.query;
    let q = sb.from('nidito_items').select('*, nidito_asignaciones(*), nidito_comentarios(id)').order('orden');
    if (tipo)   q = q.eq('tipo', tipo);
    if (estado) q = q.eq('estado', estado);
    const { data, error } = await q;
    if (error) return res.status(400).json({ success: false, error: error.message });
    const rows = (data || []).map(item => {
      const { nidito_comentarios, nidito_asignaciones, ...base } = item;
      return {
        ...base,
        asignaciones: nidito_asignaciones || [],
        mi_asignacion: phone ? (nidito_asignaciones || []).find(a => a.user_phone === phone) || null : null,
        comentarios_count: (nidito_comentarios || []).length,
      };
    });
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/nidito/items/:id', async (req, res) => {
  try {
    const { data, error } = await sb.from('nidito_items')
      .select('*, nidito_asignaciones(*), nidito_comentarios(*)')
      .eq('id', req.params.id).single();
    if (error) return res.status(404).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/nidito/items', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('nidito_items').insert(d).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    await writeAuditLog(user_phone, 'nidito_items', 'crear', data.id, null, data, 'web');
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/nidito/items/:id', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data: before } = await sb.from('nidito_items').select('*').eq('id', req.params.id).single();
    const { data, error } = await sb.from('nidito_items')
      .update({ ...d, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    await writeAuditLog(user_phone, 'nidito_items', 'editar', data.id, before, data, 'web');
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/nidito/quincena', async (req, res) => {
  try {
    const { fecha } = req.query;
    const q = fecha ? getQuincena(fecha) : getQuincenaActual();
    res.json({ success: true, data: q });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/nidito/items/:id', async (req, res) => {
  try {
    const { user_phone } = req.body;
    const { data: before } = await sb.from('nidito_items').select('*').eq('id', req.params.id).single();
    const { error } = await sb.from('nidito_items').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(400).json({ success: false, error: error.message });
    await writeAuditLog(user_phone, 'nidito_items', 'eliminar', req.params.id, before, null, 'web');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/nidito/items/:id/asignaciones', async (req, res) => {
  try {
    const { user_phone, monto_total_asignado, monto_quincenal } = req.body;
    if (!user_phone) return res.status(400).json({ success: false, error: 'Falta user_phone' });
    const { data: item } = await sb.from('nidito_items').select('presupuesto_total').eq('id', req.params.id).single();
    const warn = (item && monto_total_asignado !== undefined && monto_total_asignado > (item.presupuesto_total || 0))
      ? `⚠️ El monto asignado (${fmt(monto_total_asignado)}) supera el presupuesto total del ítem (${fmt(item.presupuesto_total)})`
      : null;
    const payload = { item_id: req.params.id, user_phone, updated_at: new Date().toISOString() };
    if (monto_total_asignado !== undefined) payload.monto_total_asignado = monto_total_asignado;
    if (monto_quincenal      !== undefined) payload.monto_quincenal      = monto_quincenal;
    const { data, error } = await sb.from('nidito_asignaciones')
      .upsert(payload, { onConflict: 'item_id,user_phone' }).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    await writeAuditLog(user_phone, 'nidito_asignaciones', 'upsert', data.id, null, data, 'web');
    res.json({ success: true, data, warn });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/nidito/items/:id/comentarios', async (req, res) => {
  try {
    const { data, error } = await sb.from('nidito_comentarios')
      .select('*').eq('item_id', req.params.id).order('created_at', { ascending: false });
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/nidito/items/:id/comentarios', async (req, res) => {
  try {
    const { user_phone, cuerpo, adjuntos } = req.body;
    if (!user_phone || !cuerpo?.trim()) return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    const { data, error } = await sb.from('nidito_comentarios')
      .insert({ item_id: req.params.id, user_phone, cuerpo: cuerpo.trim(), adjuntos: adjuntos || [] })
      .select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    await writeAuditLog(user_phone, 'nidito_comentarios', 'crear', data.id, null, data, 'web');
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/nidito/dinerito', async (req, res) => {
  try {
    const { phone, quincena } = req.query;
    const qKey = quincena || getQuincenaActual().key;
    let q = sb.from('nidito_dinerito').select('*').eq('quincena_key', qKey);
    if (phone) {
      q = q.eq('user_phone', phone);
      const { data, error } = await q.maybeSingle();
      if (error) return res.status(400).json({ success: false, error: error.message });
      res.json({ success: true, data, quincena_key: qKey });
    } else {
      const { data, error } = await q;
      if (error) return res.status(400).json({ success: false, error: error.message });
      res.json({ success: true, data, quincena_key: qKey });
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/nidito/dinerito', async (req, res) => {
  try {
    const { user_phone, monto, quincena } = req.body;
    if (!user_phone) return res.status(400).json({ success: false, error: 'Falta user_phone' });
    const qKey = quincena || getQuincenaActual().key;
    const { data, error } = await sb.from('nidito_dinerito')
      .upsert({ user_phone, quincena_key: qKey, monto: monto || 0, updated_at: new Date().toISOString() },
               { onConflict: 'user_phone,quincena_key' })
      .select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    await writeAuditLog(user_phone, 'nidito_dinerito', 'upsert', data.id, null, data, 'web');
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── NIDITO (espacio compartido — tabla legacy) ────────────────────────────────
app.get('/api/nidito', async (_req, res) => {
  try {
    const { data, error } = await sb.from('nidito').select('*').order('completado').order('prioridad', { ascending: false });
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/nidito', async (req, res) => {
  try {
    const { created_by, ...d } = req.body;
    const { data, error } = await sb.from('nidito').insert({ ...d, created_by: created_by || '' }).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/nidito/:id', async (req, res) => {
  try {
    const { data, error } = await sb.from('nidito').update({ ...req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/nidito/:id', async (req, res) => {
  try {
    const { error } = await sb.from('nidito').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── METAS (objetivos de ahorro) ───────────────────────────────────────────────
app.post('/api/metas', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('metas').insert({ ...d, user_phone }).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/metas/:id', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('metas').update(d).eq('id', req.params.id).eq('user_phone', user_phone).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/metas/:id', async (req, res) => {
  try {
    const { user_phone } = req.body;
    const { error } = await sb.from('metas').delete().eq('id', req.params.id).eq('user_phone', user_phone);
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── TDC CRUD ──────────────────────────────────────────────────────────────────
app.post('/api/tdc', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    if (!user_phone) return res.status(400).json({ success: false, error: 'Falta user_phone' });
    const { data, error } = await sb.from('tdc').insert({ user_phone, ...d }).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/tdc/:id', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('tdc').update(d).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/patrones/:id', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('patrones_ia').update(d).eq('id', req.params.id).eq('user_phone', user_phone).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/tdc/:id', async (req, res) => {
  try {
    const { error } = await sb.from('tdc').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── REBALANCEO ───────────────────────────────────────────────────────────────
// Pure function — no I/O. presupuesto: [{categoria,limite}], gastos: [{categoria,monto}]
function calcRebalanceo(presupuesto, gastos, diasMes, diaActual) {
  if (!diasMes || !diaActual || !presupuesto.length) return [];
  const rows = presupuesto
    .filter(p => p.limite > 0)
    .map(p => {
      const gastado = gastos.filter(m => m.categoria === p.categoria).reduce((a, m) => a + (m.monto || 0), 0);
      const ritmo = diaActual > 0 ? gastado / diaActual : 0;
      const proyectado = Math.round(ritmo * diasMes);
      const margen = p.limite - proyectado;   // positive = surplus at month end
      return { categoria: p.categoria, limite: p.limite, gastado, proyectado, margen };
    });

  const necesitadas = rows.filter(r => r.proyectado > r.limite)
    .sort((a, b) => (a.limite - a.proyectado) - (b.limite - b.proyectado));
  const sobrantes = rows.filter(r => r.margen > 100)
    .sort((a, b) => b.margen - a.margen);

  const sugerencias = [];
  const comprometido = {};

  for (const nec of necesitadas.slice(0, 2)) {
    const sobrante = sobrantes.find(s =>
      s.categoria !== nec.categoria &&
      s.margen - 100 - (comprometido[s.categoria] || 0) >= 50
    );
    if (!sobrante) continue;
    const disponible = sobrante.margen - 100 - (comprometido[sobrante.categoria] || 0);
    const deficit = nec.proyectado - nec.limite;
    const monto = Math.min(disponible, deficit);
    if (monto < 50) continue;
    const montoR = Math.round(monto / 50) * 50;
    comprometido[sobrante.categoria] = (comprometido[sobrante.categoria] || 0) + montoR;
    sugerencias.push({ de: sobrante.categoria, hacia: nec.categoria, monto: montoR,
      deMargen: Math.round(sobrante.margen), haciaDeficit: Math.round(deficit) });
  }
  return sugerencias;
}

app.get('/api/rebalanceo/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const mesStr = mes();
    const now = new Date();
    const diaActual = now.getDate();
    const diasMes = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const [{ data: presp }, { data: gastos }] = await Promise.all([
      sb.from('presupuesto').select('*').eq('user_phone', phone).eq('mes', mesStr),
      sb.from('movimientos').select('categoria,monto').eq('user_phone', phone)
        .eq('tipo', 'GASTO').gte('fecha', mesStr + '-01').is('deleted_at', null),
    ]);
    const sugerencias = calcRebalanceo(presp || [], gastos || [], diasMes, diaActual);
    res.json({ success: true, data: { sugerencias, diasMes, diaActual, mes: mesStr } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/rebalanceo/apply', async (req, res) => {
  try {
    const { user_phone, de, hacia, monto, mes: mesReq } = req.body;
    if (!user_phone || !de || !hacia || !monto) return res.status(400).json({ success: false, error: 'Faltan campos' });
    const mesStr = mesReq || mes();
    const { data: rows } = await sb.from('presupuesto').select('*').eq('user_phone', user_phone).eq('mes', mesStr).in('categoria', [de, hacia]);
    const rowDe    = rows?.find(r => r.categoria === de)    || { limite: 0 };
    const rowHacia = rows?.find(r => r.categoria === hacia) || { limite: 0 };
    const nuevoLimiteDe    = Math.max(0, rowDe.limite - monto);
    const nuevoLimiteHacia = rowHacia.limite + monto;
    const [r1, r2] = await Promise.all([
      sb.from('presupuesto').upsert({ user_phone, categoria: de, limite: nuevoLimiteDe, mes: mesStr }, { onConflict: 'user_phone,categoria,mes' }).select().single(),
      sb.from('presupuesto').upsert({ user_phone, categoria: hacia, limite: nuevoLimiteHacia, mes: mesStr }, { onConflict: 'user_phone,categoria,mes' }).select().single(),
    ]);
    if (r1.error) return res.status(400).json({ success: false, error: r1.error.message });
    if (r2.error) return res.status(400).json({ success: false, error: r2.error.message });
    await Promise.all([
      writeAuditLog(user_phone, 'presupuesto', 'editar', r1.data?.id, rowDe,    r1.data, 'pwa'),
      writeAuditLog(user_phone, 'presupuesto', 'editar', r2.data?.id, rowHacia, r2.data, 'pwa'),
    ]);
    res.json({ success: true, data: { de: r1.data, hacia: r2.data } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PRESUPUESTO CRUD ──────────────────────────────────────────────────────────
app.put('/api/presupuesto', async (req, res) => {
  try {
    const { user_phone, categoria, limite, mes } = req.body;
    if (!user_phone || !categoria || !mes) return res.status(400).json({ success: false, error: 'Faltan campos' });
    const { data, error } = await sb.from('presupuesto')
      .upsert({ user_phone, categoria, limite: parseFloat(limite) || 0, mes }, { onConflict: 'user_phone,categoria,mes' })
      .select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── COSTOS IA ─────────────────────────────────────────────────────────────────
app.get('/api/costos/:mes', async (req, res) => {
  try {
    const mesStr = req.params.mes;                          // YYYY-MM
    const phone  = req.query.phone ? decodeURIComponent(req.query.phone) : null;
    if (!phone) return res.status(400).json({ success: false, error: 'Falta phone' });

    const { data: usr, error: usrErr } = await sb.from('usuarios').select('role').eq('telefono', phone).maybeSingle();
    if (usrErr || !usr) return res.status(404).json({ success: false, error: 'usuario no encontrado' });
    if (usr.role !== 'ADMIN_A') return res.status(403).json({ success: false, error: 'Solo ADMIN_A' });

    const [y, m] = mesStr.split('-').map(Number);
    const nextMes = new Date(y, m, 1).toISOString().slice(0, 7);   // month is 1-indexed here

    let rows = [];
    try {
      const { data: logRows, error: logErr } = await sb.from('usage_log')
        .select('modelo, input_tokens, output_tokens, cache_read_tokens, etapa')
        .gte('created_at', mesStr + '-01T00:00:00')
        .lt('created_at',  nextMes  + '-01T00:00:00');
      if (logErr) throw logErr;
      rows = logRows || [];
    } catch (_e) {
      return res.json({ success: true, data: { totalUSD: 0, breakdown: [], totalCalls: 0, mes: mesStr } });
    }

    const agg = {};
    for (const r of (rows || [])) {
      if (!agg[r.modelo]) agg[r.modelo] = { input: 0, output: 0, cacheRead: 0, calls: 0 };
      agg[r.modelo].input    += r.input_tokens      || 0;
      agg[r.modelo].output   += r.output_tokens     || 0;
      agg[r.modelo].cacheRead += r.cache_read_tokens || 0;
      agg[r.modelo].calls    += 1;
    }

    let totalUSD = 0;
    const breakdown = Object.entries(agg).map(([modelo, t]) => {
      const p = PRECIOS_IA[modelo] || { input: 0, output: 0, cacheRead: 0 };
      const costUSD = (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead) / 1e6;
      totalUSD += costUSD;
      return { modelo, ...t, costUSD: +costUSD.toFixed(5) };
    }).sort((a, b) => b.costUSD - a.costUSD);

    res.json({ success: true, data: { mes: mesStr, totalUSD: +totalUSD.toFixed(5), breakdown, totalCalls: rows?.length || 0 } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── DESPENSA CRUD ─────────────────────────────────────────────────────────────
app.get('/api/despensa/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { data, error } = await sb.from('despensa').select('*').eq('user_phone', phone).order('comprado').order('prioridad', { ascending: false }).order('created_at', { ascending: false });
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data: data || [] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/despensa', async (req, res) => {
  try {
    const { user_phone, nombre, cantidad, precio_est, prioridad } = req.body;
    if (!user_phone || !nombre) return res.status(400).json({ success: false, error: 'Faltan campos' });
    const { data, error } = await sb.from('despensa').insert({ user_phone, nombre, cantidad: cantidad || '', precio_est: parseFloat(precio_est) || 0, prioridad: parseInt(prioridad) || 0, comprado: false }).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/despensa/:id', async (req, res) => {
  try {
    const { user_phone, ...d } = req.body;
    const { data, error } = await sb.from('despensa').update({ ...d, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_phone', user_phone).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/despensa/:id', async (req, res) => {
  try {
    const { user_phone } = req.body;
    const { error } = await sb.from('despensa').delete().eq('id', req.params.id).eq('user_phone', user_phone);
    if (error) return res.status(400).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/despensa/buscar-precios', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'Missing phone' });
  try {
    const { data: items } = await sb.from('despensa')
      .select('id, nombre').eq('user_phone', phone).eq('comprado', false);
    if (!items?.length) return res.json({ success: true, data: [] });

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} }],
    });

    const itemList = items.map((it, i) => `${i + 1}. ID:${it.id} - ${it.nombre}`).join('\n');
    const prompt = `Busca el precio actual y link directo de cada producto en Walmart México (walmart.com.mx) y Amazon México (amazon.com.mx).

Productos a buscar:
${itemList}

Devuelve SOLO un array JSON sin ningún texto adicional. Cada elemento debe tener exactamente:
- "id": número entero (el ID del producto tal como aparece arriba)
- "precio_walmart": precio en pesos MXN como número sin símbolo (o null si no se encuentra)
- "url_walmart": URL directa al producto en walmart.com.mx (o null)
- "precio_amazon": precio en pesos MXN como número sin símbolo (o null)
- "url_amazon": URL directa al producto en amazon.com.mx (o null)`;

    const result = await geminiWithRetry(() => model.generateContent(prompt));
    const text = result.response.text();

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Gemini no devolvió JSON válido con los precios');
    const priceData = JSON.parse(jsonMatch[0]);

    const now = new Date().toISOString();
    const updates = await Promise.all(priceData.map(async p => {
      const { data } = await sb.from('despensa')
        .update({
          precio_walmart:  p.precio_walmart  ?? null,
          url_walmart:     p.url_walmart     || null,
          precio_amazon:   p.precio_amazon   ?? null,
          url_amazon:      p.url_amazon      || null,
          ultima_consulta: now
        })
        .eq('id', p.id).eq('user_phone', phone).select().single();
      return data;
    }));

    res.json({ success: true, data: updates.filter(Boolean) });
  } catch (e) {
    console.error('buscar-precios error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/send-whatsapp-invite', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });
    const msg = `Hola 👋 Desde *OnlyUs* 💑\n\nPara conectarte al asistente y gestionar tus finanzas, responde a este mensaje o envía:\n\n*join everywhere-shot*\n\nLuego puedes hablar naturalmente: "gasté 250 en comida", "recibí $8000 de sueldo", "agrega a wishlist un sillón", etc.`;
    await twl.messages.create({ from: WA_FROM, to: phone, body: msg });
    res.json({ success: true, message: 'Invitación enviada a WhatsApp' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── WEBHOOK ────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // Responder inmediatamente a Twilio

  const { Body, From, MediaUrl0, MediaContentType0, NumMedia } = req.body;
  if (!From) return;

  const hasMedia = parseInt(NumMedia || 0) > 0;

  // FIX 1: Descargar el media buffer AHORA, antes de cualquier otro await,
  // para no depender de que la URL de Twilio siga viva (~4 h de TTL).
  let mediaBuf = null;
  if (hasMedia && MediaUrl0) {
    try {
      const mr = await axios.get(MediaUrl0, {
        auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN },
        responseType: 'arraybuffer',
      });
      mediaBuf = Buffer.from(mr.data);
    } catch (e) {
      console.error('[media-download]', e.message);
    }
  }

  let reply = '';
  let replySaved = false;
  try {
    const usuario = await identificarUsuario(From);
    const lower   = (Body || '').trim().toLowerCase();

    if (lower === 'ayuda' || lower === 'help') {
      reply = `🤖 *Hola ${usuario.nombre}, soy Finn*\n\nTus comandos:\n` +
        `📊 *resumen* — resumen del día y mes\n` +
        `💳 *deudas* — estado de tus TDC\n` +
        `🎯 *metas* — tus objetivos de ahorro\n` +
        `🏠 *nidito* — metas compartidas con tu pareja\n` +
        `📋 *presupuesto* — avance por categoría\n` +
        `📂 *historial* — últimos 10 movimientos\n` +
        `🗑 *borrar ultimo* — eliminar el último registro\n` +
        `🔒 *privacidad* — qué datos guardo y cómo borrarlos\n\n` +
        `También puedes escribirme en lenguaje natural o mandarme foto/PDF de un estado de cuenta 📄`;

    } else if (lower === 'privacidad' || lower === 'privacy') {
      const aiModel = (usuario.ai_preference || '').toUpperCase() === 'CLAUDE' ? 'Anthropic Claude' : 'Google Gemini';
      reply =
        `🔒 *Privacidad — FinanceOS*\n\n` +
        `*Datos guardados:* movimientos, metas, TDC, calendario, presupuesto y perfil — en Supabase (servidores en la nube).\n` +
        `*IA que procesa tus mensajes:* ${aiModel}.\n` +
        `*Sin vinculación bancaria* ni contraseñas: solo datos que tú registras explícitamente.\n` +
        `*${aiModel.split(' ')[0]} no entrena sus modelos* con datos enviados por API por defecto.\n` +
        `*Para borrar todo:* escribe *borrar mis datos* (soft-delete inmediato, purga definitiva en 30 días).`;

    } else if (lower === 'resumen') {
      const ctx = await cargarContexto(From, usuario.role);
      const neto = ctx.ingresosMes - ctx.gastosMes;
      const gastoHoy = ctx.movs.filter(m => m.fecha === hoy() && m.tipo === 'GASTO').reduce((a,m)=>a+m.monto,0);
      const tdcPend  = ctx.tdcs.reduce((a,t)=>a+Math.max(0,(t.a_pagar||0)-(t.pagado||0)),0);
      reply = `📊 *Resumen financiero, ${usuario.nombre}*\n📅 ${hoy()}\n\n` +
        `*HOY*\n💸 ${fmt(gastoHoy)} gastados\n\n` +
        `*ESTE MES (${mesActual()})*\n` +
        `💰 Ingresos: ${fmt(ctx.ingresosMes)}\n` +
        `💸 Gastos: ${fmt(ctx.gastosMes)}\n` +
        `📈 Neto: ${fmt(neto)}\n` +
        (tdcPend > 0 ? `\n💳 TDC pendiente: ${fmt(tdcPend)}` : '');

    } else if (lower === 'deudas') {
      const ctx = await cargarContexto(From, usuario.role);
      if (!ctx.tdcs.length) {
        reply = `💳 ${usuario.nombre}, no tengo deudas TDC registradas para ti.`;
      } else {
        const rows = ctx.tdcs.map(t => {
          const saldo = Math.max(0,(t.a_pagar||0)-(t.pagado||0));
          const pct   = t.a_pagar > 0 ? Math.round((t.pagado||0)/t.a_pagar*100) : 0;
          const bar   = '█'.repeat(Math.round(pct/20)).padEnd(5,'░');
          return `*${t.nombre}* ${t.estado.toUpperCase()}\n  ${bar} ${fmt(saldo)} pendiente · meta: ${t.mes_objetivo}`;
        }).join('\n\n');
        const total = ctx.tdcs.reduce((a,t)=>a+Math.max(0,(t.a_pagar||0)-(t.pagado||0)),0);
        reply = `💳 *Deudas TDC, ${usuario.nombre}*\n\n${rows}\n\n📌 Total: *${fmt(total)}*\n🎯 Meta: deuda cero Feb 2027`;
      }

    } else if (lower === 'metas') {
      const ctx = await cargarContexto(From, usuario.role);
      if (!ctx.metasInd.length) {
        reply = `🎯 Sin metas individuales aún, ${usuario.nombre}. Escríbeme: *"quiero ahorrar X para [nombre]"*`;
      } else {
        const rows = ctx.metasInd.map(m => {
          const pct = m.meta > 0 ? Math.min(100,Math.round((m.actual||0)/m.meta*100)) : 0;
          const bar = '█'.repeat(Math.round(pct/20)).padEnd(5,'░');
          return `*${m.nombre}*\n  ${bar} ${fmt(m.actual)} / ${fmt(m.meta)} (${pct}%)`;
        }).join('\n\n');
        reply = `🎯 *Metas de ${usuario.nombre}*\n\n${rows}`;
      }

    } else if (lower === 'nidito') {
      const ctx = await cargarContexto(From, usuario.role);
      if (!ctx.metasNidito.length) {
        reply = `🏠 Sin metas de Nidito aún. Crea una: *"quiero ahorrar X para [viaje/casa/etc] juntos"*`;
      } else {
        const rows = ctx.metasNidito.map(m => {
          const pct = m.meta > 0 ? Math.min(100,Math.round((m.actual||0)/m.meta*100)) : 0;
          const bar = '█'.repeat(Math.round(pct/20)).padEnd(5,'░');
          return `🏠 *${m.nombre}*\n  ${bar} ${fmt(m.actual)} / ${fmt(m.meta)} (${pct}%)`;
        }).join('\n\n');
        const totalNidito = ctx.metasNidito.reduce((a,m)=>a+(m.actual||0),0);
        reply = `🏠 *Nidito — metas de pareja*\n\n${rows}\n\n💪 Total ahorrado juntos: ${fmt(totalNidito)}`;
      }

    } else if (lower === 'presupuesto') {
      const ctx = await cargarContexto(From, usuario.role);
      if (!ctx.presupuesto.length) {
        reply = `📋 Sin presupuesto configurado, ${usuario.nombre}.\nEjemplo: *"mi presupuesto de ocio es 2000"*`;
      } else {
        const rows = ctx.presupuesto.map(p => {
          const gastado = ctx.movs.filter(m => m.categoria===p.categoria && m.tipo==='GASTO').reduce((a,m)=>a+m.monto,0);
          const pct  = p.limite>0 ? Math.round(gastado/p.limite*100) : 0;
          const bar  = '█'.repeat(Math.round(Math.min(pct,100)/20)).padEnd(5,'░');
          const icon = pct>=100?'🔴':pct>=80?'🟡':'✅';
          return `${icon} *${p.categoria}*\n  ${bar} ${fmt(gastado)} / ${fmt(p.limite)} (${pct}%)`;
        }).join('\n\n');
        reply = `📋 *Presupuesto ${mesActual()}, ${usuario.nombre}*\n\n${rows}`;
      }

    } else if (lower === 'historial') {
      const ctx = await cargarContexto(From, usuario.role);
      if (!ctx.movs.length) {
        reply = `📂 Sin movimientos registrados este mes, ${usuario.nombre}.`;
      } else {
        const rows = ctx.movs.slice(0,10).map(m =>
          `${m.tipo==='GASTO'?'💸':'💰'} ${m.fecha} | ${m.categoria} | ${m.descripcion} | ${fmt(m.monto)}`
        ).join('\n');
        reply = `📂 *Últimos movimientos, ${usuario.nombre}*\n\n${rows}`;
      }

    } else if (lower === 'borrar mis datos' || lower === 'eliminar mis datos') {
      await sb.from('acciones_pendientes').update({ estado: 'cancelled' })
        .eq('user_phone', From).eq('estado', 'pending');
      await sb.from('acciones_pendientes').insert({
        user_phone: From, tipo: 'db_action',
        datos: { accion: 'borrar_datos', paso: 1 },
        estado: 'pending',
        expira_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      reply =
        `⚠️ *¿Borrar todos tus datos?*\n\n` +
        `Se eliminarán: movimientos, metas, TDC, calendario, presupuesto y patrones de ${usuario.nombre}.\n` +
        `Los registros con soft-delete se purgarán definitivamente en 30 días.\n` +
        `Esta acción requiere doble confirmación.\n\n` +
        `*1* Sí, continuar · *3* Cancelar`;

    } else if (lower === 'borrar ultimo') {
      const { data: ultimo } = await sb.from('movimientos')
        .select('*').eq('user_phone', From).is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (ultimo) {
        await sb.from('movimientos').update({ deleted_at: new Date().toISOString() }).eq('id', ultimo.id);
        await writeAuditLog(From, 'movimientos', 'eliminar', ultimo.id, ultimo, null, 'whatsapp');
        reply = `🗑 Eliminado: ${ultimo.tipo} | ${ultimo.categoria} | ${ultimo.concepto || ultimo.descripcion || ''} | ${fmt(ultimo.monto)}\nResponde *deshacer* para revertirlo.`;
      } else {
        reply = `No encontré ningún movimiento para eliminar.`;
      }

    } else if (hasMedia && mediaBuf) {
      const mime = MediaContentType0 || 'application/octet-stream';

      if (mime.startsWith('audio/')) {
        // ── Nota de voz → transcribir → flujo idéntico al texto ──────────────
        const transcribed = await transcribeAudio(mediaBuf, mime, From);
        if (!transcribed) {
          reply = '⚠️ No pude transcribir el audio. Intenta de nuevo.';
        } else {
          const voiceText = `[🎤 Nota de voz] ${transcribed}`;
          const intercepted = await handlePendingCommand(From, voiceText.toLowerCase());
          if (intercepted !== null) {
            reply = intercepted;
          } else {
            const pendingEdit = await getLastPendingAction(From, 'editing');
            if (pendingEdit) {
              const mergedDatos = mergeEditIntent(pendingEdit.datos?.datos || {}, voiceText);
              const newArg = { ...pendingEdit.datos, datos: mergedDatos };
              await sb.from('acciones_pendientes').update({ estado: 'cancelled' }).eq('id', pendingEdit.id);
              const { msg } = await proposeDbAction(From, newArg, voiceText);
              reply = msg;
            } else {
              const { intent, toolArgs } = await extractIntent(voiceText, From);
              if ((intent === 'REGISTRO' || intent === 'EDICION' || intent === 'ELIMINACION') && toolArgs) {
                await guardarMensaje(From, 'user', voiceText);
                const { msg } = await proposeDbAction(From, toolArgs, voiceText);
                await guardarMensaje(From, 'assistant', msg);
                reply = msg; replySaved = true;
              } else {
                const sysBlocks = await buildSystemPrompt(usuario, intent);
                await guardarMensaje(From, 'user', voiceText);
                reply = await callIA(usuario, sysBlocks, voiceText, From);
                await guardarMensaje(From, 'assistant', reply);
                replySaved = true;
              }
            }
          }
        }

      } else {
        // ── Imagen o PDF — buffer ya descargado arriba ────────────────────────
        const b64 = mediaBuf.toString('base64');

        if (mime.startsWith('image/')) {
          // Intento rápido de extracción de recibo con Haiku
          const recibo = await extractReceiptInfo(b64, mime, From);
          if (recibo) {
            const toolArg = {
              tabla: 'movimientos', accion: 'crear',
              datos: {
                tipo: 'GASTO', categoria: 'OTROS',
                concepto: recibo.comercio || 'Compra',
                monto: recibo.monto_total,
                medio_pago: 'efectivo',
                fecha: recibo.fecha || hoy(),
              },
            };
            await guardarMensaje(From, 'user', '[📷 Foto de recibo]');
            const { msg } = await proposeDbAction(From, toolArg, '[foto recibo]');
            await guardarMensaje(From, 'assistant', msg);
            reply = msg;
          } else {
            // Imagen no reconocida como recibo → análisis Gemini
            reply = '🔍 Analizando imagen...';
            await enviarWhatsApp(From, reply);
            const sysBlocks  = await buildSystemPrompt(usuario, 'CONSULTA');
            const imageModel = genAI.getGenerativeModel({
              model: 'gemini-2.5-flash',
              systemInstruction: sysBlocks.static + '\n\n' + sysBlocks.dynamic,
            });
            const imgResult = await geminiWithRetry(() => imageModel.generateContent([
              { inlineData: { mimeType: mime, data: b64 } },
              'Analiza esta imagen y dime qué relevancia tiene para mis finanzas.',
            ]));
            logUsage(From, 'gemini-2.5-flash', imgResult.response.usageMetadata, 'vision');
            reply = imgResult.response.text();
          }

        } else {
          // PDF — análisis profundo Gemini (estados de cuenta multipágina)
          reply = '📄 Analizando estado de cuenta...';
          await enviarWhatsApp(From, reply);
          const sysBlocks  = await buildSystemPrompt(usuario, 'CONSULTA');
          const pdfModel   = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: sysBlocks.static + '\n\n' + sysBlocks.dynamic,
          });
          const pdfResult = await geminiWithRetry(() => pdfModel.generateContent([
            { inlineData: { mimeType: mime, data: b64 } },
            'Analiza este estado de cuenta. Dame: banco y período, cargos principales, intereses cobrados, algo disputable, y la acción concreta que debo tomar esta semana según mi plan de finanzas.',
          ]));
          logUsage(From, 'gemini-2.5-flash', pdfResult.response.usageMetadata, 'vision');
          reply = pdfResult.response.text();
        }
      }

    } else {
      // 1) Intercept comandos de confirmación / cancelación / deshacer
      const intercepted = await handlePendingCommand(From, lower);
      if (intercepted !== null) {
        reply = intercepted;
      } else {
        // 2) Verificar si hay una acción en estado 'editing' (usuario responde "2" y luego edita)
        const pendingEdit = await getLastPendingAction(From, 'editing');
        if (pendingEdit) {
          const mergedDatos = mergeEditIntent(pendingEdit.datos?.datos || {}, Body || '');
          const newArg = { ...pendingEdit.datos, datos: mergedDatos };
          await sb.from('acciones_pendientes').update({ estado: 'cancelled' }).eq('id', pendingEdit.id);
          const { msg } = await proposeDbAction(From, newArg, Body || '');
          reply = msg;
        } else {
          // 3) Si hay acción pendiente y el mensaje no es respuesta a ella → cancelar y proceder
          const existingPending = await getLastPendingAction(From, 'pending');
          if (existingPending) {
            await sb.from('acciones_pendientes').update({ estado: 'cancelada' }).eq('id', existingPending.id);
          }

          // extractIntent → REGISTRO/EDICION/ELIMINACION → proposeDbAction directo (sin Sonnet/Gemini)
          const { intent, toolArgs } = await extractIntent(Body || '', From);
          if ((intent === 'REGISTRO' || intent === 'EDICION' || intent === 'ELIMINACION') && toolArgs) {
            await guardarMensaje(From, 'user', Body || '');
            const { msg } = await proposeDbAction(From, toolArgs, Body || '');
            await guardarMensaje(From, 'assistant', msg);
            reply = msg; replySaved = true;
          } else {
            const sysBlocks = await buildSystemPrompt(usuario, intent);
            await guardarMensaje(From, 'user', Body || '');
            reply = await callIA(usuario, sysBlocks, Body || '', From);
            await guardarMensaje(From, 'assistant', reply);
            replySaved = true;
          }
        }
      }
    }

  } catch (err) {
    console.error('Webhook error:', err);
    reply = '❌ Algo salió mal. Intenta de nuevo o escribe *ayuda*.';
  }

  if (reply && From) {
    if (!replySaved) await guardarMensaje(From, 'assistant', reply);
    await enviarWhatsApp(From, reply);
  }
});

// ── CHAT WEB (PWA) ────────────────────────────────────────────────────────────
// Mismo motor que WhatsApp pero para el chat integrado en el dashboard
app.post('/api/chat-web', async (req, res) => {
  const { phone, message, audio_b64, audio_mime } = req.body;
  if (!phone) return res.status(400).json({ error: 'Missing phone' });
  try {

    let text    = (message || '').trim();
    let isAudio = false;

    // Transcribir audio si viene en base64 (desde grabación web)
    if (audio_b64) {
      isAudio = true;
      const sizeKB = Math.round(audio_b64.length * 0.75 / 1024);
      console.log(`🎤 Audio recibido | mime=${audio_mime} | size≈${sizeKB}KB`);
      try {
        const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent([
          { inlineData: { mimeType: audio_mime || 'audio/wav', data: audio_b64 } },
          'Transcribe exactamente este audio en español. Solo devuelve el texto transcrito.'
        ]);
        logUsage(phone, 'gemini-2.5-flash', result.response.usageMetadata, 'vision');
        text = result.response.text().trim();
        console.log(`🎤 Transcripción OK: "${text}"`);
      } catch (e) {
        console.error(`🎤 Error Gemini transcripción: ${e.message} | status=${e.status} | code=${e.code}`);
        return res.json({ reply: `⚠️ Error de transcripción: ${e.message?.slice(0,80) || 'desconocido'}. Escribe tu mensaje.` });
      }
    }

    if (!text) return res.json({ reply: '⚠️ Mensaje vacío.' });

    const lower = text.toLowerCase().trim();
    // El chat web SIEMPRE usa Gemini (gratis), sin importar la preferencia guardada.
    const user  = { ...(await getOrCreateUser(phone)), ai_preference: 'GEMINI' };
    checkAndSendReminders(phone).catch(() => {});   // no-bloqueante: no retrasa la respuesta del chat

    let reply = '';
    if (['resumen','summary','balance'].includes(lower))         reply = await cmdResumen(phone);
    else if (['deudas','tdc'].includes(lower))                   reply = await cmdDeudas(phone);
    else if (['historial','movimientos'].includes(lower))        reply = await cmdHistorial(phone);
    else if (['calendario','agenda','eventos'].includes(lower))  reply = await cmdCalendario(phone);
    else {
      const input = isAudio ? `[🎤 Nota de voz web] ${text}` : text;

      await guardarMensaje(phone, 'user', input);
      const { intent, items } = await withTimeout(
        extractIntentBatch(input, phone),
        12000,
        { intent: 'CONSULTA', items: [] }
      );

      if (['REGISTRO', 'EDICION', 'ELIMINACION'].includes(intent) && items.length > 0) {
        const mentionsAlicia = /alicia/i.test(input);
        const execs = [];
        for (const item of items) {
          if (mentionsAlicia && item.tabla === 'movimientos' && item.accion === 'crear') {
            item.datos = { ...item.datos, comentarios: 'Alicia' };
          }
          const result = await executeDbAction(phone, item, 'web');
          execs.push({ item, result });
        }
        reply = buildWebChatReply(execs);
      } else {
        const sysBlocks = await buildSystemPrompt(user, intent);
        reply = await withTimeout(
          callIA(user, sysBlocks, input, phone, true),
          12000,
          '⚠️ Gemini tardó demasiado en responder. Intenta de nuevo, o escribe "gasté [monto] en [concepto]" para registrar directo.'
        );   // direct=true → registros sin menú
      }

      await guardarMensaje(phone, 'assistant', reply);
    }

    res.json({ reply, transcription: isAudio ? text : undefined });
  } catch (e) {
    const detail = `${e.message || e} | status=${e.status} | code=${e.code}`;
    console.error('chat-web error:', detail);
    const is429 = /429|quota|Too Many Requests/i.test(e.message || '');
    if (is429) {
      const friendlyMsg = '⚠️ Gemini está al límite de cuota por ahora. Para registrar gastos escribe: *gasté [monto] en [concepto]* (se procesa sin IA).';
      try { await guardarMensaje(phone, 'assistant', friendlyMsg); } catch {}
      return res.json({ reply: friendlyMsg });
    }
    res.status(500).json({ error: detail.slice(0, 200) });
  }
});

// ── INSIGHTS IA — consejos financieros personalizados (Dashboard) ─────────────
app.post('/api/insights', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const mes = mesActual();
    const [patrR, movR, prspR, tdcR] = await Promise.all([
      sb.from('patrones_ia').select('*').eq('user_phone', phone).order('contador', { ascending: false }).limit(15),
      sb.from('movimientos').select('*').eq('user_phone', phone).gte('fecha', mes + '-01').is('deleted_at', null),
      sb.from('presupuesto').select('*').eq('user_phone', phone),
      sb.from('tdc').select('*').eq('user_phone', phone).is('deleted_at', null),
    ]);

    const patrones = patrR.data || [];
    const movs     = movR.data  || [];
    const presp    = prspR.data || [];
    const tdc      = tdcR.data  || [];

    const gastos   = movs.filter(m => m.tipo === 'GASTO');
    const gastoTotal = gastos.reduce((a, m) => a + (m.monto || 0), 0);
    const ingTotal   = movs.filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + (m.monto || 0), 0);
    const deudaTDC   = tdc.reduce((a, t) => a + Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)), 0);

    const porCat = {};
    gastos.forEach(m => { porCat[m.categoria] = (porCat[m.categoria] || 0) + (m.monto || 0); });
    const topCats = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `${k}: ${fmt(v)}`).join(', ');

    const prspLines = presp.length
      ? presp.map(p => {
          const gastadoCat = porCat[p.categoria] || 0;
          const pct = p.monto_limite > 0 ? Math.round(gastadoCat / p.monto_limite * 100) : 0;
          return `${p.categoria}: gastado ${fmt(gastadoCat)} de ${fmt(p.monto_limite)} (${pct}%)`;
        }).join(', ')
      : 'sin presupuesto configurado';

    const patronLines = patrones.length
      ? patrones.slice(0, 10).map(p =>
          `${p.concepto_clave}: promedio ${fmt(p.monto_promedio)}, ${p.contador} veces, ${p.medio_pago_usual || '?'}`
        ).join('\n')
      : 'sin patrones detectados aún';

    const prompt = `Eres OnlyUs, asesor financiero personal amigable en México.
Con los datos reales del usuario genera EXACTAMENTE 4 consejos financieros personalizados, concretos y útiles.
Responde ÚNICAMENTE con JSON válido (sin texto adicional, sin markdown): {"consejos":[...]}

Cada consejo tiene:
- tipo: "ahorro" | "alerta" | "habito" | "logro"  (elige el que mejor aplique)
- titulo: máximo 6 palabras, directo y claro
- cuerpo: 2-3 oraciones en español amigable, menciona cifras reales cuando ayude, da un paso accionable

DATOS DEL USUARIO ESTE MES (${mes}):
- Gasto total: ${fmt(gastoTotal)}
- Ingreso registrado: ${fmt(ingTotal)}
- Balance: ${fmt(ingTotal - gastoTotal)}
- Deuda TDC actual: ${fmt(deudaTDC)}
- Gasto por categoría: ${topCats || 'sin movimientos'}
- Presupuesto vs real: ${prspLines}
- Hábitos detectados (patrones repetidos):
${patronLines}

Prioriza: "alerta" si hay categoría excedida o deuda alta, "logro" si el balance es positivo o hay ahorro real, "habito" para mejorar comportamientos recurrentes, "ahorro" para oportunidades concretas de reducir gasto.`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });
    const result = await geminiWithRetry(() => model.generateContent(prompt));
    logUsage(phone, 'gemini-2.5-flash', result.response.usageMetadata, 'insights');

    const json = JSON.parse(result.response.text());
    res.json({ success: true, consejos: json.consejos || [] });
  } catch (e) {
    console.error('insights error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── NIDITO STORAGE ─────────────────────────────────────────────────────────
const UPLOAD_ALLOWED = new Set(['image/jpeg','image/png','image/gif','image/webp','application/pdf']);
app.post('/api/nidito/upload-url', async (req, res) => {
  try {
    const { nombre, tipo, itemId } = req.body;
    if (!nombre || !tipo || !itemId) return res.status(400).json({ error: 'nombre, tipo, itemId requeridos' });
    if (!UPLOAD_ALLOWED.has(tipo)) return res.status(400).json({ error: 'Tipo no permitido (imagen o PDF)' });
    const ext = (nombre.split('.').pop()||'bin').toLowerCase().slice(0,10);
    const path = `${itemId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { data, error } = await sb.storage.from('nidito-adjuntos').createSignedUploadUrl(path);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, uploadUrl: data.signedUrl, path });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/nidito/upload-confirm', async (req, res) => {
  try {
    const { path, nombre, tipo } = req.body;
    if (!path) return res.status(400).json({ error: 'path requerido' });
    const { data, error } = await sb.storage.from('nidito-adjuntos').createSignedUrl(path, 315360000);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, url: data.signedUrl, path, nombre: nombre || path.split('/').pop(), tipo: tipo || 'application/octet-stream' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ status: 'OnlyUs v6 ✅', build: 'quincenal-panel-full' }));

// ── QUINCENAL IA — genera recomendaciones para una quincena ──────────────────
app.post('/api/quincenal-ia', async (req, res) => {
  try {
    const { phone, qLabel, qFrom, qTo, espIngreso, realIngreso, espGasto, realGasto, items } = req.body;
    const fmt2 = n => '$' + Math.round(n||0).toLocaleString('es-MX');
    const prompt = `Eres OnlyUs, asesor financiero personal cercano. Analiza este período financiero y da 3-4 recomendaciones concretas y accionables:

Período: ${qLabel} (${qFrom} al ${qTo})
━━━ INGRESOS ━━━
  Esperado: ${fmt2(espIngreso)}  |  Real: ${fmt2(realIngreso)}  |  Dif: ${fmt2(realIngreso-espIngreso)}
━━━ GASTOS ━━━
  Esperado: ${fmt2(espGasto)}  |  Real: ${fmt2(realGasto)}  |  Dif: ${fmt2(realGasto-espGasto)}
━━━ BALANCE ━━━
  Esperado: ${fmt2(espIngreso-espGasto)}  |  Real: ${fmt2(realIngreso-realGasto)}

Detalle gastos fijos vs real:
${(items||[]).map(i=>`  • ${i.desc}: esp ${fmt2(i.esp)}, real ${fmt2(i.real)}`).join('\n')||'  (sin detalle)'}

Instrucciones: sé específico con los números. Si hay overspending en alguna categoría, menciónalo. Usa emojis. Máx 4 puntos breves. No uses markdown de encabezados.`;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await geminiWithRetry(() => model.generateContent(prompt));
    res.json({ success: true, text: result.response.text() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── UPDATE REFS — actualiza external_refs directamente (sin IA) ──────────────
app.post('/api/update-refs', async (req, res) => {
  try {
    const { phone, field, action, item, itemId } = req.body;
    const { data: cur, error: selErr } = await sb.from('usuarios').select('external_refs').eq('telefono', phone).single();
    if (selErr && selErr.code !== 'PGRST116') return res.status(500).json({ success: false, error: selErr.message });
    const refs = { ...(cur?.external_refs || {}) };

    if (field === 'hide_despensa_gastos') {
      refs.hide_despensa_gastos = req.body.value === true;
    } else if (field === 'forma_pago_gastos' && action === 'set') {
      if (!refs.forma_pago_gastos) refs.forma_pago_gastos = {};
      refs.forma_pago_gastos[itemId] = item || '';  // itemId=descripcion, item='efectivo'|'tarjeta_debito'|''
    } else if (field === 'budget_q') {
      const { qKey, tipo } = req.body;
      if (!qKey || !tipo) return res.status(400).json({ success: false, error: 'qKey and tipo required for budget_q' });
      if (!refs.budget_q) refs.budget_q = {};
      if (!refs.budget_q[qKey]) refs.budget_q[qKey] = { gastos: [], ingresos: [] };
      const { items: replaceItems } = req.body;
      if (action === 'replace' && Array.isArray(replaceItems)) {
        refs.budget_q[qKey][tipo] = replaceItems;
      } else {
        let arr = Array.isArray(refs.budget_q[qKey][tipo]) ? [...refs.budget_q[qKey][tipo]] : [];
        if (action === 'add') {
          // Auto-init from global template on first add
          if (arr.length === 0 && tipo === 'gastos' && Array.isArray(refs.gastos_esperados) && refs.gastos_esperados.length) {
            arr = refs.gastos_esperados.map(g => ({ ...g }));
          }
          if (arr.length === 0 && tipo === 'ingresos' && Array.isArray(refs.ingresos_esperados) && refs.ingresos_esperados.length) {
            arr = refs.ingresos_esperados.map(i => ({ ...i }));
          }
          arr.push({ ...item, _id: Date.now().toString() });
          refs.budget_q[qKey][tipo] = arr;
        } else if (action === 'remove') {
          let idx = arr.findIndex(x => (x._id || x.id) === itemId);
          if (idx === -1) idx = arr.findIndex(x => x.descripcion === itemId);
          if (idx > -1) { arr.splice(idx, 1); refs.budget_q[qKey][tipo] = arr; }
        } else if (action === 'update') {
          let idx = arr.findIndex(x => (x._id || x.id) === itemId);
          if (idx === -1) idx = arr.findIndex(x => x.descripcion === itemId);
          if (idx > -1) {
            arr[idx] = { _id: arr[idx]._id || arr[idx].id || Date.now().toString(), ...arr[idx], ...item };
            refs.budget_q[qKey][tipo] = arr;
          }
        }
      }
    } else if (field === 'ingresos_esperados' || field === 'gastos_esperados') {
      const { items: replaceItems } = req.body;
      if (action === 'replace' && Array.isArray(replaceItems)) {
        refs[field] = replaceItems;
      }
      const arr = Array.isArray(refs[field]) ? [...refs[field]] : [];
      if (action === 'add') {
        arr.push({ ...item, _id: Date.now().toString() });
        refs[field] = arr;
      } else if (action === 'remove') {
        let idx = arr.findIndex(x => (x._id || x.id) === itemId);
        if (idx === -1) idx = arr.findIndex(x => x.descripcion === itemId);
        if (idx > -1) { arr.splice(idx, 1); refs[field] = arr; }
      } else if (action === 'update') {
        let idx = arr.findIndex(x => (x._id || x.id) === itemId);
        if (idx === -1) idx = arr.findIndex(x => x.descripcion === itemId);
        if (idx > -1) {
          // Ensure item gets an _id so future lookups use the proper path
          arr[idx] = { _id: arr[idx]._id || arr[idx].id || Date.now().toString(), ...arr[idx], ...item };
          refs[field] = arr;
        } else if (typeof itemId === 'string' && itemId.startsWith('lg-') && field === 'gastos_esperados') {
          // legacy gastos_fijos format
          const key = itemId.slice(3);
          if (refs.gastos_fijos && key in refs.gastos_fijos) {
            refs.gastos_fijos = { ...refs.gastos_fijos, [key]: item.monto ?? refs.gastos_fijos[key] };
          }
        } else if (itemId === 'legacy-sueldo' && field === 'ingresos_esperados') {
          // legacy ingreso_quincenal format
          if ('ingreso_quincenal' in refs) refs.ingreso_quincenal = item.monto ?? refs.ingreso_quincenal;
        }
      }
    }

    const { error } = await sb.from('usuarios').update({ external_refs: refs }).eq('telefono', phone);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── SEED ADMIN AL STARTUP ──────────────────────────────────────────────────
// Si ADMIN_PHONE está definido, asigna automáticamente los registros huérfanos
// (TDC y metas sin user_phone) al admin. Configura en Railway env vars:
// ADMIN_PHONE=whatsapp:+521XXXXXXXXXX
async function seedAdminOnStartup() {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) return;
  try {
    // Solo inserta si NO existe — nunca sobreescribir preferencias (ai_preference, ai_model)
    const { data: existing } = await sb.from('usuarios').select('id').eq('telefono', adminPhone).single();
    if (!existing) {
      await sb.from('usuarios').insert([{ telefono: adminPhone, role: 'ADMIN_A', ai_preference: 'CLAUDE', ai_model: 'claude-sonnet-4-6' }]);
    }
    const [r1, r2] = await Promise.all([
      sb.from('tdc').update({ user_phone: adminPhone }).eq('user_phone', ''),
      sb.from('metas').update({ user_phone: adminPhone }).eq('user_phone', ''),
    ]);
    const tdcCount = r1.count || 0, metasCount = r2.count || 0;
    console.log(`✅ Admin seeded: ${adminPhone} | TDC: ${tdcCount} | Metas: ${metasCount}`);
  } catch (e) { console.error('seedAdmin error:', e.message); }
}

const PORT   = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log('[OnlyUs] v6 ready on port', PORT);
  await seedAdminOnStartup();
});

process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received');
  server.close(() => { console.log('[shutdown] HTTP closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
