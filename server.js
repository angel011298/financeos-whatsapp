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

// ── Clientes ────────────────────────────────────────────────────────────────
const sb        = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: WebSocket }
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const gemini    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const twl       = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const WA_FROM   = process.env.TWILIO_WHATSAPP_FROM;

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
const hoy       = () => new Date().toISOString().split('T')[0];
const mesActual = () => new Date().toISOString().slice(0, 7);

// ── Compatibilidad con código existente ──────────────────────────────────────
const path    = require('path');
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
      ai_preference: esAngel ? 'CLAUDE' : 'GEMINI',
      ai_model:      esAngel ? 'claude-sonnet-4-6' : 'gemini-1.5-flash',
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
async function writeAuditLog(phone, tabla, accion, registroId, datosBefore, datosAfter, origen = 'whatsapp') {
  try {
    await sb.from('audit_log').insert({
      user_phone:    phone,
      tabla,
      accion,
      registro_id:   registroId != null ? String(registroId) : null,
      datos_antes:   datosBefore  || null,
      datos_despues: datosAfter   || null,
      origen,
    });
  } catch (e) { console.error('audit_log write error:', e.message); }
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
async function transcribeAudio(mediaUrl, contentType) {
  try {
    const auth = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64');
    const res  = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf    = await res.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    const mime   = contentType || 'audio/ogg';
    const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
      { inlineData: { mimeType: mime, data: base64 } },
      'Transcribe exactamente este audio en español. Devuelve solo el texto transcrito, sin comentarios adicionales.'
    ]);
    return result.response.text().trim();
  } catch (e) {
    console.error('Audio transcription error:', e.message);
    return null;
  }
}

// ── PROACTIVE REMINDERS ────────────────────────────────────────────────────
async function checkAndSendReminders(phone) {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tStr = tomorrow.toISOString().split('T')[0];
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

async function executeDbAction(phone, arg, origen = 'whatsapp') {
  const { tabla, accion, id, datos } = arg;
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
        await writeAuditLog(phone, tabla, accion, data?.id, null, data, origen);
        return `✅ Agregado al Nidito ✓ ID: ${data?.id}`;
      }
      if (accion === 'editar') {
        const { data, error } = await sb.from('nidito').update({ ...datos, updated_at: new Date().toISOString() }).eq('id', id).select().single();
        if (error) return `❌ Error: ${error.message}`;
        await writeAuditLog(phone, tabla, accion, id, snapshotBefore, data, origen);
        return `✅ Nidito #${id} actualizado.`;
      }
      if (accion === 'eliminar') {
        const { error } = await sb.from('nidito').update({ deleted_at: new Date().toISOString() }).eq('id', id);
        if (error) return `❌ Error: ${error.message}`;
        await writeAuditLog(phone, tabla, accion, id, snapshotBefore, null, origen);
        return `🗑️ Eliminado del Nidito #${id}.`;
      }
    }

    // ── usuarios — merge en external_refs ────────────────────────────────────
    if (tabla === 'usuarios') {
      const { data: cur } = await sb.from('usuarios').select('external_refs').eq('telefono', phone).single();
      const refs = { ...(cur?.external_refs || {}), ...datos };
      const { error } = await sb.from('usuarios').update({ external_refs: refs }).eq('telefono', phone);
      if (error) return `❌ Error: ${error.message}`;
      await writeAuditLog(phone, tabla, 'editar', phone, cur?.external_refs, refs, origen);
      return `✅ Perfil personal actualizado.`;
    }

    if (accion === 'crear') {
      const { data, error } = await sb.from(tabla).insert({ ...datos, user_phone: phone }).select().single();
      if (error) return `❌ Error: ${error.message}`;
      if (tabla === 'movimientos' && datos?.tipo === 'GASTO') {
        await learnPattern(phone, datos);
        await verificarLimitePresupuesto(phone, datos.categoria, mesActual()).catch(() => null);
      }
      await writeAuditLog(phone, tabla, accion, data?.id, null, data, origen);
      return `✅ ${tabla === 'calendario' ? 'Evento agendado' : 'Registrado'} ✓ ID: ${data?.id}`;
    }
    if (accion === 'editar') {
      const { data, error } = await sb.from(tabla).update(datos).eq('id', id).eq('user_phone', phone).select().single();
      if (error) return `❌ Error: ${error.message}`;
      await writeAuditLog(phone, tabla, accion, id, snapshotBefore, data, origen);
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
      await writeAuditLog(phone, tabla, accion, id, snapshotBefore, null, origen);
      return `🗑️ Registro ${id} eliminado.`;
    }
    return '❌ Acción no reconocida.';
  } catch (e) { return `❌ DB error: ${e.message}`; }
}

// ── INTENT EXTRACTION (Haiku — compartido para todos los usuarios) ────────────
// El extractor siempre usa Claude Haiku independientemente de ai_preference.
// Solo la CONVERSACIÓN (CONSULTA/CHARLA) respeta ai_preference del usuario.
const _extractIntentStaticPrompt = `Eres un extractor de intents para una app de finanzas personales.
Clasifica el mensaje del usuario en uno de estos intents y responde SOLO con la palabra:

REGISTRO   → el usuario reporta un gasto, ingreso u operación con monto explícito
EDICION    → el usuario quiere corregir/modificar un registro existente (menciona ID o "el último")
ELIMINACION→ el usuario quiere borrar un registro específico
CONSULTA   → el usuario pregunta por sus finanzas, pide análisis o resúmenes
CHARLA     → saludo, agradecimiento, conversación casual, preguntas generales
COMANDO    → palabras clave: resumen, deudas, metas, historial, presupuesto, calendario, ayuda, nidito

Si el intent es REGISTRO, EDICION o ELIMINACION con datos suficientes: usa también la herramienta modificar_plataforma.
Si faltan datos críticos (ej: "gasté en el súper" sin monto) → responde CONSULTA, sin tool.

HERRAMIENTA: modificar_plataforma
  tabla:  movimientos | metas | calendario | tdc | presupuesto | nidito | usuarios
  accion: crear | editar | eliminar
  id:     string (solo editar/eliminar)
  datos:  object — campos del registro

CATEGORÍAS:   Hogar, Comida, TDC, Despensa, Hormiga, Ocio, Personales, Platina, Transporte, OTROS
MEDIOS PAGO:  efectivo, TDC BBVA, TDC HEY, TDC Liverpool, TDC AMEX, TDC NU, TDC Rappi, TDC Palacio, transferencia, débito
Tipo GASTO requiere: tipo, categoria, concepto, monto, medio_pago (default "efectivo"), fecha
Tipo INGRESO requiere: tipo="INGRESO", categoria="OTROS", concepto, monto, fecha

EJEMPLOS:
"50 tacos"                    → REGISTRO  + crear movimientos {tipo:"GASTO",categoria:"Comida",concepto:"tacos",monto:50,medio_pago:"efectivo"}
"gasté 350 uber con TDC BBVA" → REGISTRO  + crear movimientos {tipo:"GASTO",categoria:"Transporte",concepto:"uber",monto:350,medio_pago:"TDC BBVA"}
"recibí mi sueldo $14,000"    → REGISTRO  + crear movimientos {tipo:"INGRESO",categoria:"OTROS",concepto:"Sueldo",monto:14000}
"cuánto gasté este mes"       → CONSULTA  (sin tool)
"hola cómo estás"             → CHARLA    (sin tool)`;

async function extractIntent(text) {
  const today = hoy();
  try {
    const res = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: [
        {
          type:          'text',
          text:          _extractIntentStaticPrompt + `\nfecha hoy: ${today}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools:       [toolsSchema],
      tool_choice: { type: 'auto' },
      messages:    [{ role: 'user', content: text }],
    });

    let intent   = 'CONSULTA';
    let toolArgs = null;

    for (const block of res.content) {
      if (block.type === 'text') {
        const m = block.text.match(/\b(REGISTRO|EDICION|ELIMINACION|CONSULTA|CHARLA|COMANDO)\b/i);
        if (m) intent = m[1].toUpperCase();
      } else if (block.type === 'tool_use') {
        toolArgs = block.input;
        if (!toolArgs.datos?.fecha) {
          toolArgs = { ...toolArgs, datos: { ...toolArgs.datos, fecha: today } };
        }
        // intent from tool accion
        if (toolArgs.accion === 'crear')   intent = 'REGISTRO';
        if (toolArgs.accion === 'editar')  intent = 'EDICION';
        if (toolArgs.accion === 'eliminar') intent = 'ELIMINACION';
      }
    }

    return { intent, toolArgs };
  } catch (e) {
    console.error('extractIntent error:', e.message);
    return { intent: 'CONSULTA', toolArgs: null }; // fallback seguro
  }
}

// ── PROPOSE → CONFIRM ─────────────────────────────────────────────────────
async function proposeDbAction(phone, arg, textoOriginal) {
  const { tabla, accion, datos } = arg;

  // Auto-confirm: crear movimiento con patrón conocido (contador≥5, diff≤30%, monto<5000)
  if (accion === 'crear' && tabla === 'movimientos' && (datos?.monto || 0) < 5000) {
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
    if (tabla === 'movimientos') {
      const fechaStr = d.fecha === hoy() ? 'hoy' : (d.fecha || hoy());
      const icon = d.tipo === 'INGRESO' ? '💰' : '💸';
      resumen = `${icon} ${fmt(d.monto || 0)} · ${d.categoria || 'OTROS'} · ${d.concepto || ''} · ${d.medio_pago || 'efectivo'} · ${fechaStr}`;
    } else if (tabla === 'calendario') {
      resumen = `📅 ${d.fecha || ''} ${d.hora || ''} — ${d.titulo || ''}`;
    } else if (tabla === 'metas') {
      resumen = `🎯 Meta: ${d.nombre || ''} — ${fmt(d.meta || 0)}`;
    } else if (tabla === 'nidito') {
      resumen = `💫 Nidito (${d.tipo || 'idea'}): ${d.titulo || ''}${d.monto > 0 ? ' · ' + fmt(d.monto) : ''}`;
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

  await sb.from('acciones_pendientes').insert({
    user_phone: phone,
    tipo:       'db_action',
    datos:      { ...arg, texto_original: textoOriginal },
    estado:     'pending',
    expira_at:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  return { auto: false, msg: propuesta };
}

// ── RECEIPT EXTRACTOR (Haiku + imagen) ────────────────────────────────────
// Intenta extraer datos de un ticket/recibo simple. Devuelve null si no es recibo.
async function extractReceiptInfo(b64, mime) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'Extrae datos de tickets/recibos de compra. Responde ÚNICAMENTE con JSON válido: {"es_recibo":true,"monto_total":número,"comercio":"nombre","fecha":"YYYY-MM-DD"}. Si la imagen NO es un recibo o ticket simple (es un estado de cuenta bancario, screenshot, foto de comida, etc.), responde exactamente: {"es_recibo":false}.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          { type: 'text', text: '¿Es un recibo o ticket de compra con monto total visible?' },
        ],
      }],
    });
    const raw = res.content[0]?.text || '';
    const m = raw.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const data = JSON.parse(m[0]);
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
  comentarios: observaciones — puede estar vacío
  monto: número
  medio_pago: uno de [${MEDIOS_PAGO.join(', ')}] — default "efectivo"
  fecha: YYYY-MM-DD

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

// Claude con tool calling — proposeDbAction intercepts; sin segundo turno de IA
async function callClaude(user, sysBlocks, messages, text, phone) {
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

  let aiText = '';
  const toolUses = [];
  for (const block of res.content) {
    if (block.type === 'text') aiText += block.text;
    else if (block.type === 'tool_use') toolUses.push(block);
  }

  if (toolUses.length > 0) {
    // proposeDbAction decide auto-confirm o propuesta — short-circuit sin segundo turno
    const results = await Promise.all(toolUses.map(t => proposeDbAction(phone, t.input, text)));
    const proposalMsg = results.map(r => r.msg).join('\n');
    return [aiText.trim(), proposalMsg].filter(Boolean).join('\n\n');
  }

  return aiText;
}

// Gemini con function calling — proposeDbAction intercepts; sin segundo turno de IA
async function callGemini(user, sysBlocks, geminiHistory, text, phone) {
  // sysBlocks puede ser { static, dynamic } (Sprint 2) o string legado
  const systemInstruction = (sysBlocks && typeof sysBlocks === 'object' && sysBlocks.static)
    ? sysBlocks.static + '\n\n' + sysBlocks.dynamic
    : sysBlocks;

  const model = genAI.getGenerativeModel({
    model: user.ai_model || 'gemini-2.5-flash',
    tools: geminiTools,
    systemInstruction,
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
  const res = await chat.sendMessage(text);
  const calls = res.response.functionCalls();

  if (calls?.length) {
    const results = await Promise.all(calls.map(c => proposeDbAction(phone, c.args, text)));
    return results.map(r => r.msg).join('\n');
  }

  return res.response.text();
}

// Dispatcher que enruta por preferencia del usuario
async function callIA(user, sysBlocks, text, phone) {
  const dbHistory = await cargarHistorial(phone);

  if (user.ai_preference === 'CLAUDE') {
    return callClaude(user, sysBlocks, dbHistory, text, phone);
  } else {
    const geminiHistory = dbHistory.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    return callGemini(user, sysBlocks, geminiHistory, text, phone);
  }
}

// ── REST API DASHBOARD ─────────────────────────────────────────────────────
app.get('/api/dashboard/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    // Auto-create usuario si accede por primera vez desde la web
    const { data: existing } = await sb.from('usuarios').select('id').eq('telefono', phone).single();
    if (!existing) {
      await sb.from('usuarios').insert([{ telefono: phone, role: 'USER_B', ai_preference: 'GEMINI' }]);
    }
    const [tdc, movs, metas, user, cal, pat, presp, nidito] = await Promise.all([
      sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
      sb.from('movimientos').select('*').eq('user_phone', phone).is('deleted_at', null).order('fecha', { ascending: false }).limit(500),
      sb.from('metas').select('*').eq('user_phone', phone).is('deleted_at', null),
      sb.from('usuarios').select('*').eq('telefono', phone).single(),
      sb.from('calendario').select('*').eq('user_phone', phone).is('deleted_at', null).order('fecha'),
      sb.from('patrones_ia').select('*').eq('user_phone', phone).order('contador', { ascending: false }),
      sb.from('presupuesto').select('*').eq('user_phone', phone),
      sb.from('nidito').select('*').is('deleted_at', null).order('completado').order('prioridad', { ascending: false }),
    ]);
    res.json({ success: true, data: { tdc: tdc.data, movs: movs.data, metas: metas.data, user: user.data, calendario: cal.data, patrones: pat.data, presupuesto: presp.data, nidito: nidito.data } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Lista todos los usuarios (para ghost mode del admin)
app.get('/api/usuarios', async (req, res) => {
  try {
    const { data } = await sb.from('usuarios').select('telefono, nombre, role, ai_preference');
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── WHOAMI — detecta si el teléfono es admin o Alicia ─────────────────────
app.get('/api/whoami/:phone', (req, res) => {
  // Compara los últimos 10 dígitos (número local sin prefijo de país ni el "1" de México móvil)
  // Así funciona sin importar si ADMIN_PHONE es +521XXXXXXXXXX, +52XXXXXXXXXX, whatsapp:+521..., etc.
  const last10 = s => (s || '').replace(/\D/g, '').slice(-10);
  const adminLast10 = last10(process.env.ADMIN_PHONE);
  const reqLast10   = last10(req.params.phone);
  const isAdmin = adminLast10.length === 10 && adminLast10 === reqLast10;
  console.log(`[whoami] req=${reqLast10} admin=${adminLast10} match=${isAdmin}`);
  res.json({ role: isAdmin ? 'ADMIN' : 'USER' });
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

// ── NIDITO (espacio compartido) ───────────────────────────────────────────────
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
    const { error } = await sb.from('nidito').delete().eq('id', req.params.id);
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

  let reply = '';
  try {
    const usuario = await identificarUsuario(From);
    const lower   = (Body || '').trim().toLowerCase();
    const hasMedia = parseInt(NumMedia || 0) > 0;

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

    } else if (hasMedia && MediaUrl0) {
      const mime = MediaContentType0 || 'application/octet-stream';

      if (mime.startsWith('audio/')) {
        // ── Nota de voz → transcribir → flujo idéntico al texto ──────────────
        const transcribed = await transcribeAudio(MediaUrl0, mime);
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
              const { intent, toolArgs } = await extractIntent(voiceText);
              if ((intent === 'REGISTRO' || intent === 'EDICION' || intent === 'ELIMINACION') && toolArgs) {
                await guardarMensaje(From, 'user', voiceText);
                const { msg } = await proposeDbAction(From, toolArgs, voiceText);
                await guardarMensaje(From, 'assistant', msg);
                reply = msg;
              } else {
                const sysBlocks = await buildSystemPrompt(usuario, intent);
                await guardarMensaje(From, 'user', voiceText);
                reply = await callIA(usuario, sysBlocks, voiceText, From);
                await guardarMensaje(From, 'assistant', reply);
              }
            }
          }
        }

      } else {
        // ── Imagen o PDF — descargar primero ─────────────────────────────────
        const mediaResp = await axios.get(MediaUrl0, {
          auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN },
          responseType: 'arraybuffer',
        });
        const b64 = Buffer.from(mediaResp.data).toString('base64');

        if (mime.startsWith('image/')) {
          // Intento rápido de extracción de recibo con Haiku
          const recibo = await extractReceiptInfo(b64, mime);
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
            // Imagen no reconocida como recibo → análisis Sonnet
            reply = '🔍 Analizando imagen...';
            await enviarWhatsApp(From, reply);
            const sysBlocks = await buildSystemPrompt(usuario, 'CONSULTA');
            const sysArray  = [
              { type: 'text', text: sysBlocks.static, cache_control: { type: 'ephemeral' } },
              { type: 'text', text: sysBlocks.dynamic },
            ];
            const analisisResp = await anthropic.messages.create({
              model: 'claude-sonnet-4-6', max_tokens: 1024, system: sysArray,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
                { type: 'text', text: 'Analiza esta imagen y dime qué relevancia tiene para mis finanzas.' },
              ]}],
            });
            reply = analisisResp.content[0].text;
          }

        } else {
          // PDF — análisis profundo Sonnet (estados de cuenta multipágina)
          reply = '📄 Analizando estado de cuenta...';
          await enviarWhatsApp(From, reply);
          const sysBlocks = await buildSystemPrompt(usuario, 'CONSULTA');
          const sysArray  = [
            { type: 'text', text: sysBlocks.static, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: sysBlocks.dynamic },
          ];
          const analisisResp = await anthropic.messages.create({
            model: 'claude-sonnet-4-6', max_tokens: 1024, system: sysArray,
            betas: ['pdfs-2024-09-25'],
            messages: [{ role: 'user', content: [
              { type: 'document', source: { type: 'base64', media_type: mime, data: b64 } },
              { type: 'text', text: 'Analiza este estado de cuenta. Dame: banco y período, cargos principales, intereses cobrados, algo disputable, y la acción concreta que debo tomar esta semana según mi plan de finanzas.' },
            ]}],
          });
          reply = analisisResp.content[0].text;
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
          // 3) extractIntent → REGISTRO/EDICION/ELIMINACION → proposeDbAction directo (sin Sonnet/Gemini)
          const { intent, toolArgs } = await extractIntent(Body || '');
          if ((intent === 'REGISTRO' || intent === 'EDICION' || intent === 'ELIMINACION') && toolArgs) {
            await guardarMensaje(From, 'user', Body || '');
            const { msg } = await proposeDbAction(From, toolArgs, Body || '');
            await guardarMensaje(From, 'assistant', msg);
            reply = msg;
          } else {
            const sysBlocks = await buildSystemPrompt(usuario, intent);
            await guardarMensaje(From, 'user', Body || '');
            reply = await callIA(usuario, sysBlocks, Body || '', From);
            await guardarMensaje(From, 'assistant', reply);
          }
        }
      }
    }

  } catch (err) {
    console.error('Webhook error:', err);
    reply = '❌ Algo salió mal. Intenta de nuevo o escribe *ayuda*.';
  }

  if (reply && From) {
    await enviarWhatsApp(From, reply);
  }
});

// ── CHAT WEB (PWA) ────────────────────────────────────────────────────────────
// Mismo motor que WhatsApp pero para el chat integrado en el dashboard
app.post('/api/chat-web', async (req, res) => {
  try {
    const { phone, message, audio_b64, audio_mime } = req.body;
    if (!phone) return res.status(400).json({ error: 'Missing phone' });

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
        text = result.response.text().trim();
        console.log(`🎤 Transcripción OK: "${text}"`);
      } catch (e) {
        console.error(`🎤 Error Gemini transcripción: ${e.message} | status=${e.status} | code=${e.code}`);
        return res.json({ reply: `⚠️ Error de transcripción: ${e.message?.slice(0,80) || 'desconocido'}. Escribe tu mensaje.` });
      }
    }

    if (!text) return res.json({ reply: '⚠️ Mensaje vacío.' });

    const lower = text.toLowerCase().trim();
    const user  = await getOrCreateUser(phone);
    await checkAndSendReminders(phone).catch(() => {});

    let reply = '';
    if (['resumen','summary','balance'].includes(lower))         reply = await cmdResumen(phone);
    else if (['deudas','tdc'].includes(lower))                   reply = await cmdDeudas(phone);
    else if (['historial','movimientos'].includes(lower))        reply = await cmdHistorial(phone);
    else if (['calendario','agenda','eventos'].includes(lower))  reply = await cmdCalendario(phone);
    else {
      const input = isAudio ? `[🎤 Nota de voz web] ${text}` : text;
      const lowerInput = input.toLowerCase().trim();

      // 1) Intercept confirmación / cancelación / deshacer
      const intercepted = await handlePendingCommand(phone, lowerInput);
      if (intercepted !== null) {
        reply = intercepted;
      } else {
        // 2) Estado 'editing' — usuario fusiona cambio con acción pendiente
        const pendingEdit = await getLastPendingAction(phone, 'editing');
        if (pendingEdit) {
          const mergedDatos = mergeEditIntent(pendingEdit.datos?.datos || {}, input);
          const newArg = { ...pendingEdit.datos, datos: mergedDatos };
          await sb.from('acciones_pendientes').update({ estado: 'cancelled' }).eq('id', pendingEdit.id);
          const { msg } = await proposeDbAction(phone, newArg, input);
          reply = msg;
        } else {
          // 3) extractIntent → REGISTRO/EDICION/ELIMINACION → proposeDbAction directo (sin Sonnet/Gemini)
          const { intent, toolArgs } = await extractIntent(input);
          if ((intent === 'REGISTRO' || intent === 'EDICION' || intent === 'ELIMINACION') && toolArgs) {
            await guardarMensaje(phone, 'user', input);
            const { msg } = await proposeDbAction(phone, toolArgs, input);
            await guardarMensaje(phone, 'assistant', msg);
            reply = msg;
          } else {
            const sysBlocks = await buildSystemPrompt(user, intent);
            await guardarMensaje(phone, 'user', input);
            reply = await callIA(user, sysBlocks, input, phone);
            await guardarMensaje(phone, 'assistant', reply);
          }
        }
      }
    }

    res.json({ reply, transcription: isAudio ? text : undefined });
  } catch (e) {
    const detail = `${e.message || e} | status=${e.status} | code=${e.code}`;
    console.error('chat-web error:', detail);
    res.status(500).json({ error: detail.slice(0, 200) });
  }
});

app.get('/api/health', (_req, res) => res.json({ status: 'OnlyUs v5 ✅', build: 'quincenal-panel-full' }));

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
    const result = await model.generateContent(prompt);
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

    if (field === 'forma_pago_gastos' && action === 'set') {
      if (!refs.forma_pago_gastos) refs.forma_pago_gastos = {};
      refs.forma_pago_gastos[itemId] = item || '';  // itemId=descripcion, item='efectivo'|'tarjeta_debito'|''
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
      await sb.from('usuarios').insert([{ telefono: adminPhone, role: 'ADMIN_A', ai_preference: 'GEMINI' }]);
    }
    const [r1, r2] = await Promise.all([
      sb.from('tdc').update({ user_phone: adminPhone }).eq('user_phone', ''),
      sb.from('metas').update({ user_phone: adminPhone }).eq('user_phone', ''),
    ]);
    const tdcCount = r1.count || 0, metasCount = r2.count || 0;
    console.log(`✅ Admin seeded: ${adminPhone} | TDC: ${tdcCount} | Metas: ${metasCount}`);
  } catch (e) { console.error('seedAdmin error:', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`OnlyUs v5 — puerto ${PORT}`);
  await seedAdminOnStartup();
});
