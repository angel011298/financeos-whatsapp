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
const history = {};          // DEPRECADO — reemplazado por historial_chat en DB
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
    sb.from('movimientos').select('*').eq('user_phone', userPhone).gte('fecha', inicio).order('fecha', { ascending: false }).limit(30),
    esAngel ? sb.from('tdc').select('*').order('prioridad') : Promise.resolve({ data: [] }),
    sb.from('metas').select('*').eq('user_phone', userPhone).eq('tipo_meta', 'individual'),
    sb.from('metas').select('*').eq('tipo_meta', 'nidito'),
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

// ── System prompt para Finn ──────────────────────────────────────────────────
function buildSystemPrompt(usuario, ctx) {
  const esAngel = usuario.role === 'ADMIN_A';
  const nombre  = usuario.nombre;

  const presStr = ctx.presupuesto.length
    ? ctx.presupuesto.map(p => {
        const gastado = ctx.movs.filter(m => m.categoria === p.categoria && m.tipo === 'GASTO')
                                .reduce((a, m) => a + (m.monto || 0), 0);
        const pct = p.limite > 0 ? Math.round(gastado / p.limite * 100) : 0;
        const icon = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '✅';
        return `  ${icon} ${p.categoria}: ${fmt(gastado)} / ${fmt(p.limite)} (${pct}%)`;
      }).join('\n')
    : '  (sin presupuesto configurado)';

  const tdcStr = esAngel && ctx.tdcs.length
    ? ctx.tdcs.map(t => {
        const saldo = Math.max(0, (t.a_pagar || 0) - (t.pagado || 0));
        return `  • ${t.nombre}: saldo ${fmt(saldo)} | ${t.estado} | meta: ${t.mes_objetivo}`;
      }).join('\n')
    : '';

  const perfilAngel = esAngel ? `
PERFIL FINANCIERO BASE DE ANGEL:
  Ingresos base: $31,898/mes (sueldo $27,407 + WFH $425 + vales $3,566 + beca $500)
  Egresos fijos: ~$8,203/mes
  Disponible para TDC: ~$22,726/mes
  Meta: liquidar todas las TDC antes de febrero 2027
  Inicio empleo: 26 mayo 2026` : '';

  return `Eres Finn, el asistente financiero personal de ${nombre}.
Eres cálido, cercano y directo — como un amigo muy inteligente que sabe de finanzas y contabilidad.
Siempre llamas a ${nombre} por su nombre. Usas emojis con moderación.
Respondes en español. Mensajes cortos y concretos para WhatsApp.
Jamás inventas cifras — solo usas los datos reales del contexto.
Si no tienes un dato, dilo claramente y pregunta.
${perfilAngel}

FINANZAS DEL MES ACTUAL (${mesActual()}):
  💰 Ingresos registrados: ${fmt(ctx.ingresosMes)}
  💸 Gastos registrados:   ${fmt(ctx.gastosMes)}
  📈 Neto del mes:         ${fmt(ctx.ingresosMes - ctx.gastosMes)}
${tdcStr ? '\nDEUDAS TDC:\n' + tdcStr : ''}

PRESUPUESTO MENSUAL:
${presStr}

METAS INDIVIDUALES:
${ctx.metasInd.length
  ? ctx.metasInd.map(m => {
      const pct = m.meta > 0 ? Math.min(100, Math.round((m.actual || 0) / m.meta * 100)) : 0;
      return `  • ${m.nombre}: ${fmt(m.actual)} / ${fmt(m.meta)} (${pct}%)`;
    }).join('\n')
  : '  (sin metas individuales)'}

METAS DE NIDITO (compartidas con pareja):
${ctx.metasNidito.length
  ? ctx.metasNidito.map(m => {
      const pct = m.meta > 0 ? Math.min(100, Math.round((m.actual || 0) / m.meta * 100)) : 0;
      return `  🏠 ${m.nombre}: ${fmt(m.actual)} / ${fmt(m.meta)} (${pct}%)`;
    }).join('\n')
  : '  (sin metas de Nidito)'}

ÚLTIMOS MOVIMIENTOS:
${ctx.movs.slice(0, 8).map(m =>
  `  ${m.tipo === 'GASTO' ? '💸' : '💰'} ${m.fecha} | ${m.categoria} | ${m.descripcion} | ${fmt(m.monto)}`
).join('\n') || '  (ninguno este mes)'}

PATRONES APRENDIDOS DE ${nombre.toUpperCase()}:
${ctx.patrones.length
  ? ctx.patrones.map(p => `  "${p.concepto_clave}" → ${p.categoria} (${p.contador}x)`).join('\n')
  : '  (aún aprendiendo tus hábitos)'}

REGLAS DE GUARDADO — cuando detectes un movimiento incluye AL FINAL (el usuario no lo ve):
SAVE:{"tipo":"GASTO","categoria":"COMIDA","descripcion":"tacos","monto":150}
SAVE:{"tipo":"INGRESO","categoria":"SUELDO","descripcion":"Quincena 1 junio","monto":13703}
META:{"accion":"crear","nombre":"Viaje Europa","meta":45000,"tipo_meta":"nidito"}
META:{"accion":"crear","nombre":"Fondo emergencia","meta":10000,"tipo_meta":"individual"}
META:{"accion":"abonar","nombre":"Viaje Europa","monto":2000}
PRESUPUESTO:{"categoria":"OCIO","limite":2000}

NO incluyas SAVE/META/PRESUPUESTO si el usuario solo pregunta o conversa.
Si hay ambigüedad en monto o categoría, PREGUNTA antes de guardar.
Cuando guardes algo, menciona brevemente que quedó registrado.`;
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

// ── Llamada a IA según preferencia del usuario ───────────────────────────────
async function llamarIA(usuario, systemPrompt, historial, mensajeUsuario) {
  const mensajes = [...historial, { role: 'user', content: mensajeUsuario }];

  if (usuario.ai_preference === 'CLAUDE') {
    const result = await anthropic.messages.create({
      model:      usuario.ai_model || 'claude-sonnet-4-6',
      max_tokens: 800,
      system:     systemPrompt,
      messages:   mensajes,
    });
    return result.content[0].text;
  }

  // Gemini — inyectar system prompt como primer turno del historial
  const geminiModel = gemini.getGenerativeModel({ model: usuario.ai_model || 'gemini-2.5-flash' });
  const historialGemini = [
    { role: 'user',  parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Entendido. Soy Finn. ¿En qué puedo ayudarte?' }] },
    ...mensajes.slice(0, -1).map(m => ({
      role:  m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    })),
  ];
  const chat   = geminiModel.startChat({ history: historialGemini });
  const result = await chat.sendMessage(mensajeUsuario);
  return result.response.text();
}

// ── Parsear y limpiar la respuesta de la IA ──────────────────────────────────
function parsearYLimpiar(texto) {
  const extraer = (regex) => [...texto.matchAll(new RegExp(regex, 'g'))].map(m => {
    try { return JSON.parse(m[1]); } catch { return null; }
  }).filter(Boolean);

  const saves  = extraer('SAVE:(\\{[^}]+\\})');
  const metas  = extraer('META:(\\{[^}]+\\})');
  const presup = extraer('PRESUPUESTO:(\\{[^}]+\\})');

  const limpio = texto
    .replace(/SAVE:\{[^}]+\}/g, '')
    .replace(/META:\{[^}]+\}/g, '')
    .replace(/PRESUPUESTO:\{[^}]+\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { limpio, saves, metas, presup };
}

// ── Ejecutar guardados en Supabase ───────────────────────────────────────────
async function ejecutarGuardados(saves, metas, presup, userPhone) {
  const fecha = hoy();
  const mes   = mesActual();

  for (const s of saves) {
    if (!s.monto || !s.tipo) continue;
    await sb.from('movimientos').insert({
      user_phone:  userPhone,
      tipo:        s.tipo,
      categoria:   s.categoria || 'OTROS',
      descripcion: s.descripcion || '',
      monto:       parseFloat(s.monto) || 0,
      fecha,
    });
    if (s.tipo === 'GASTO') {
      await verificarLimitePresupuesto(userPhone, s.categoria, mes).catch(() => null);
    }
  }

  for (const m of metas) {
    if (!m.nombre || !m.accion) continue;
    const esNidito  = m.tipo_meta === 'nidito';
    const phoneMeta = esNidito ? 'nidito_compartido' : userPhone;

    if (m.accion === 'crear') {
      await sb.from('metas').upsert({
        user_phone: phoneMeta,
        nombre:     m.nombre,
        tipo_meta:  m.tipo_meta || 'individual',
        meta:       parseFloat(m.meta) || 0,
        actual:     0,
      }, { onConflict: 'user_phone,nombre' });
    } else if (m.accion === 'abonar') {
      const { data: existente } = await sb.from('metas')
        .select('id, actual')
        .eq('nombre', m.nombre)
        .or(`user_phone.eq.${userPhone},user_phone.eq.nidito_compartido`)
        .single();
      if (existente) {
        await sb.from('metas')
          .update({ actual: (existente.actual || 0) + (parseFloat(m.monto) || 0) })
          .eq('id', existente.id);
      }
    }
  }

  for (const p of presup) {
    if (!p.categoria || !p.limite) continue;
    await sb.from('presupuesto').upsert({
      user_phone: userPhone,
      categoria:  p.categoria,
      mes,
      limite:     parseFloat(p.limite) || 0,
    }, { onConflict: 'user_phone,categoria,mes' });
  }
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
    .eq('tipo', 'GASTO').gte('fecha', inicio);
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

async function executeDbAction(phone, arg) {
  const { tabla, accion, id, datos } = arg;
  try {
    // Validar tabla — nunca usar nombres inventados
    if (!TABLAS_VALIDAS.includes(tabla)) {
      return `❌ Tabla '${tabla}' no existe. Tablas válidas: ${TABLAS_VALIDAS.join(', ')}`;
    }

    // nidito — tabla compartida sin user_phone
    if (tabla === 'nidito') {
      if (accion === 'crear') {
        const { data, error } = await sb.from('nidito').insert({ ...datos, created_by: phone }).select().single();
        if (error) return `❌ Error: ${error.message}`;
        return `✅ Agregado al Nidito ✓ ID: ${data?.id}`;
      }
      if (accion === 'editar') {
        const { error } = await sb.from('nidito').update({ ...datos, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) return `❌ Error: ${error.message}`;
        return `✅ Nidito #${id} actualizado.`;
      }
      if (accion === 'eliminar') {
        const { error } = await sb.from('nidito').delete().eq('id', id);
        if (error) return `❌ Error: ${error.message}`;
        return `🗑️ Eliminado del Nidito #${id}.`;
      }
    }

    // usuarios — tabla de perfil, merge en external_refs
    if (tabla === 'usuarios') {
      const { data: cur } = await sb.from('usuarios').select('external_refs').eq('telefono', phone).single();
      const refs = { ...(cur?.external_refs || {}), ...datos };
      const { error } = await sb.from('usuarios').update({ external_refs: refs }).eq('telefono', phone);
      if (error) return `❌ Error: ${error.message}`;
      return `✅ Perfil personal actualizado.`;
    }

    if (accion === 'crear') {
      const { data, error } = await sb.from(tabla).insert({ ...datos, user_phone: phone }).select().single();
      if (error) return `❌ Error: ${error.message}`;
      if (tabla === 'movimientos' && datos?.tipo === 'GASTO') await learnPattern(phone, datos);
      return `✅ ${tabla === 'calendario' ? 'Evento agendado' : 'Registrado'} ✓ ID: ${data?.id}`;
    }
    if (accion === 'editar') {
      const { error } = await sb.from(tabla).update(datos).eq('id', id).eq('user_phone', phone);
      if (error) return `❌ Error: ${error.message}`;
      return `✅ Registro ${id} actualizado.`;
    }
    if (accion === 'eliminar') {
      const { error } = await sb.from(tabla).delete().eq('id', id).eq('user_phone', phone);
      if (error) return `❌ Error: ${error.message}`;
      return `🗑️ Registro ${id} eliminado.`;
    }
    return '❌ Acción no reconocida.';
  } catch (e) { return `❌ DB error: ${e.message}`; }
}

// ── SYSTEM PROMPT ──────────────────────────────────────────────────────────
async function buildSystemPrompt(user) {
  const today = hoy();
  const phone = user.telefono;
  const mesStr = mes();

  const [tdcR, movsR, metasR, calR, patrR, prspR, niditoR] = await Promise.all([
    sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
    sb.from('movimientos').select('*').eq('user_phone', phone).order('created_at', { ascending: false }).limit(60),
    sb.from('metas').select('*').eq('user_phone', phone),
    sb.from('calendario').select('*').eq('user_phone', phone).gte('fecha', today).order('fecha').limit(10),
    sb.from('patrones_ia').select('*').eq('user_phone', phone).order('contador', { ascending: false }).limit(10),
    sb.from('presupuesto').select('*').eq('user_phone', phone).eq('mes', mesStr),
    sb.from('nidito').select('*').order('prioridad', { ascending: false }).limit(20),
  ]);

  const tdcs = tdcR.data || [], movs = movsR.data || [], metas = metasR.data || [];
  const eventos = calR.data || [], patrones = patrR.data || [], presp = prspR.data || [];
  const nidito = niditoR.data || [];
  const refs = user.external_refs || {};

  const mesMov = movs.filter(m => m.fecha?.startsWith(mesStr));
  const gastMes = mesMov.filter(m => m.tipo === 'GASTO').reduce((a, m) => a + (m.monto || 0), 0);
  const ingrMes = mesMov.filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + (m.monto || 0), 0);

  const catLines = CATEGORIAS.map(cat => {
    const tot = mesMov.filter(m => m.tipo === 'GASTO' && m.categoria === cat).reduce((a, m) => a + (m.monto || 0), 0);
    if (!tot) return null;
    const lim = presp.find(p => p.categoria === cat)?.limite || 0;
    const alerta = lim > 0 && tot > lim * 0.85 ? ' ⚠️ CERCA DEL LÍMITE' : '';
    return `  ${cat}: ${fmt(tot)}${lim > 0 ? ` / límite ${fmt(lim)}` : ''}${alerta}`;
  }).filter(Boolean).join('\n');

  let ghost = '';
  if (user.role === 'ADMIN_A') {
    const { data: otros } = await sb.from('movimientos').select('*').neq('user_phone', phone).order('created_at', { ascending: false }).limit(20);
    ghost = `\n[MODO FANTASMA — últimos movs Sujeto B]\n${JSON.stringify(otros)}`;
  }

  return `Eres OnlyUs, el asesor financiero personal inteligente de Ángel.
Hoy: ${today} | Mes: ${mesStr}

REGLAS DE ORO:
- Habla con naturalidad. NO eres un bot robótico. Eres un asistente cercano que conoce bien al usuario.
- Para WhatsApp: máx 4 párrafos cortos. Usa emojis con moderación.
- DETECTA PATRONES: Si gasta mucho en algo comparado con historial, avísale proactivamente.
- TIENES PODER DE ACCIÓN: usa la herramienta 'modificar_plataforma' automáticamente cuando la información sea suficientemente clara.
- Si el usuario dice algo como "gasté X en Y" (monto + concepto claros) → EJECUTA sin preguntar.
- Si la información es AMBIGUA o falta algo CRÍTICO (monto sin número, concepto completamente vago) → PREGUNTA brevemente antes de registrar. Ejemplo: si dice "gasté en el súper" sin monto, pregunta "¿Cuánto gastaste en el súper?" antes de registrar.
- Para nidito y calendario: puedes inferir detalles razonables sin preguntar (usa monto=0 si no hay monto, tipo "idea" si no está claro).
- Si viene de 🎤 nota de voz: mismas reglas, confía en la transcripción.

CAMPOS OBLIGATORIOS para movimientos.crear (tipo GASTO):
  tipo: "GASTO"
  categoria: una de [${CATEGORIAS.join(', ')}]
  concepto: producto/servicio específico ("Uber", "McDonald's", "mínimo BBVA")
  comentarios: observaciones del usuario ("con Alicia", "fue emergencia", "error de cobro") — puede estar vacío
  monto: número
  medio_pago: uno de [${MEDIOS_PAGO.join(', ')}] — si no lo dice, usa "efectivo"
  fecha: "${today}" o la fecha que mencione

Para INGRESO: tipo="INGRESO", categoria="OTROS", concepto=fuente del ingreso, monto, fecha.

Para calendario.crear: titulo, fecha (YYYY-MM-DD), hora (HH:MM si la da), tipo, descripcion.
Si dice "en 3 meses" → calcula: ${new Date(new Date().setMonth(new Date().getMonth() + 3)).toISOString().split('T')[0]}.
Si dice "en X días" → suma X a hoy.

════════ DATOS FINANCIEROS ════════
GASTOS MES: ${fmt(gastMes)} | INGRESOS: ${fmt(ingrMes)} | NETO: ${fmt(ingrMes - gastMes)}

POR CATEGORÍA:
${catLines || '  (sin gastos registrados este mes)'}

PRESUPUESTO MENSUAL (límites por categoría, mes ${mesStr}):
${presp.length ? presp.map(p => `  ${p.categoria}: límite ${fmt(p.limite)} | gastado ${fmt(mesMov.filter(m => m.tipo === 'GASTO' && m.categoria === p.categoria).reduce((a,m) => a+(m.monto||0), 0))}`).join('\n') : '  Sin límites configurados. Para configurar usa: "pon límite de $X en categoría Y" o "configura presupuesto mensual".'}

INFO PERSONAL:
${refs.ingreso_quincenal ? `  Ingreso quincenal: ${fmt(refs.ingreso_quincenal)} | Días de pago: ${(refs.dias_pago||[]).join(' y ')}` : '  Ingreso quincenal: no configurado.'}
${Array.isArray(refs.ingresos_esperados) && refs.ingresos_esperados.length ? `  Ingresos esperados configurados:\n${refs.ingresos_esperados.map(i=>`    • ${i.descripcion}: ${fmt(i.monto)} días ${(i.dias||[]).join(',')}`).join('\n')}` : ''}
${Array.isArray(refs.gastos_esperados) && refs.gastos_esperados.length ? `  Gastos fijos configurados:\n${refs.gastos_esperados.map(g=>`    • ${g.descripcion}: ${fmt(g.monto)}`).join('\n')}` : refs.gastos_fijos ? `  Gastos fijos:\n${Object.entries(refs.gastos_fijos).map(([k,v])=>`    • ${k}: ${fmt(v)}`).join('\n')}` : '  Gastos fijos: no configurados.'}

DEUDAS TDC:
${tdcs.map(t => `  [${t.id}] ${t.nombre} (${t.estado}): pago ${fmt(t.a_pagar)} saldo ${fmt(Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)))}`).join('\n') || '  Sin TDC'}

ÚLTIMOS 10 MOVIMIENTOS:
${movs.slice(0, 10).map(m => `  [${m.id}] ${m.fecha} ${m.tipo} ${m.categoria} "${m.concepto||''}" ${fmt(m.monto)} ${m.medio_pago||''}`).join('\n') || '  Sin movimientos'}

METAS: ${metas.map(m => `[${m.id}] ${m.nombre}: ${fmt(m.actual)}/${fmt(m.meta)}`).join(' | ') || 'Sin metas'}

PRÓXIMOS EVENTOS:
${eventos.map(e => `  [${e.id}] ${e.fecha}: ${e.titulo}`).join('\n') || '  Calendario vacío'}

PATRONES (top conceptos recurrentes):
${patrones.map(p => `  ${p.concepto_clave}: promedio ${fmt(p.monto_promedio)}, ${p.contador}x, último ${p.ultima_vez}, medio: ${p.medio_pago_usual||'?'}`).join('\n') || '  Sin patrones aún'}

NIDITO (espacio compartido con Alicia — metas/ideas/wishlist):
${nidito.map(n => `  [${n.id}] ${n.emoji||'💫'} ${n.tipo?.toUpperCase()}: "${n.titulo}"${n.monto>0?' '+fmt(n.monto):''}${n.completado?' ✅':''}`).join('\n') || '  Nidito vacío'}
Para agregar al nidito usa tabla="nidito". Ejemplos: "anota en nidito que queremos ir a Cancún", "agrega a wishlist un sillón $3000".

════════ REGLAS DE MODIFICACIÓN ════════
- tabla="usuarios" accion="crear" datos={campo: valor}: guarda info personal (el backend hace merge automático, no sobreescribe campos no enviados).
- tabla="presupuesto" accion="crear" datos={categoria, limite, mes:"${mesStr}"}: límite mensual por categoría.
- NÚMEROS: Los montos siempre son números puros. "$14,843.72" → 14843.72 (coma=miles, punto=decimal). NUNCA truncar.
- Cuando el usuario diga "mi sueldo es $X quincenal, cobro los días D1 y D2" → tabla="usuarios", datos={ ingreso_quincenal: X, dias_pago:[D1,D2], ingresos_esperados:[{descripcion:"Sueldo",monto:X,dias:[D1,D2]}] }
- Cuando mencione un ingreso recurrente extra → tabla="usuarios", datos={ ingresos_esperados:[...existentes, {descripcion:"X",monto:Y,dias:[dia]}] }
- Cuando mencione un gasto fijo → tabla="usuarios", datos={ gastos_esperados:[...existentes, {descripcion:"X",monto:Y}], gastos_fijos:{...existentes,X:Y} }
- Cuando el usuario configure presupuesto mensual por categoría → una llamada a "presupuesto" POR cada categoría.
- tabla="movimientos" accion="editar" id=X datos={campo: nuevo_valor}: corrige un movimiento.
${ghost}`;
}

// ── QUICK COMMANDS ─────────────────────────────────────────────────────────
async function cmdResumen(phone) {
  const today = hoy();
  const mesStr = mes();
  const [{ data: hoyMovs }, { data: mesMovs }, { data: tdcs }, { data: evts }] = await Promise.all([
    sb.from('movimientos').select('*').eq('user_phone', phone).eq('fecha', today),
    sb.from('movimientos').select('*').eq('user_phone', phone).gte('fecha', mesStr + '-01'),
    sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
    sb.from('calendario').select('*').eq('user_phone', phone).gte('fecha', today).order('fecha').limit(3),
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
  const { data: movs } = await sb.from('movimientos').select('*').eq('user_phone', phone).order('created_at', { ascending: false }).limit(10);
  if (!movs?.length) return '📋 Sin movimientos.';
  return `📋 *ÚLTIMOS MOVIMIENTOS*\n\n${movs.map(m=>`${m.tipo==='GASTO'?'💸':'💰'} [${m.id}] ${m.fecha} | ${m.categoria} | ${m.concepto||''} | ${fmt(m.monto)} | ${m.medio_pago||''}`).join('\n')}`;
}

async function cmdCalendario(phone) {
  const today = hoy();
  const { data: evts } = await sb.from('calendario').select('*').eq('user_phone', phone).gte('fecha', today).order('fecha').limit(10);
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
async function callIA(user, sysPrompt, text, phone) {
  if (!history[phone]) history[phone] = [];
  history[phone].push({ role: 'user', content: text });
  if (history[phone].length > 20) history[phone].splice(0, 2);

  // ── GEMINI 2.5-flash con systemInstruction nativo + function calling ─────
  // Usar systemInstruction es la forma correcta para que el modelo respete
  // las instrucciones de herramientas (TIENES PODER DE ACCIÓN, etc.)
  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    tools:             geminiTools,
    systemInstruction: sysPrompt,            // nativo — más fiable que par falso user/model
  });

  // Construir historial de conversación (sin el mensaje actual, que va en sendMessage)
  let gHist = history[phone]
    .filter(m => typeof m.content === 'string')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  gHist = gHist.slice(0, -1);

  // Garantizar alternancia user→model (Gemini rechaza duplicados consecutivos)
  const safeHist = [];
  for (const msg of gHist) {
    if (safeHist.length === 0 && msg.role !== 'user') continue;
    if (safeHist.length > 0 && safeHist[safeHist.length - 1].role === msg.role) continue;
    safeHist.push(msg);
  }
  if (safeHist.length > 0 && safeHist[safeHist.length - 1].role === 'user') safeHist.pop();

  // Sin par falso al inicio — systemInstruction lo maneja el SDK
  const chat = model.startChat({ history: safeHist });
  const res  = await chat.sendMessage(text);
  const calls = res.response.functionCalls();
  if (calls?.length) {
    const dbRes = await executeDbAction(phone, calls[0].args);
    const res2  = await chat.sendMessage([{ functionResponse: { name: 'modificar_plataforma', response: { result: dbRes } } }]);
    const reply = res2.response.text();
    history[phone].push({ role: 'assistant', content: reply });
    return reply;
  }
  const reply = res.response.text();
  history[phone].push({ role: 'assistant', content: reply });
  return reply;
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
      sb.from('movimientos').select('*').eq('user_phone', phone).order('fecha', { ascending: false }).limit(500),
      sb.from('metas').select('*').eq('user_phone', phone),
      sb.from('usuarios').select('*').eq('telefono', phone).single(),
      sb.from('calendario').select('*').eq('user_phone', phone).order('fecha'),
      sb.from('patrones_ia').select('*').eq('user_phone', phone).order('contador', { ascending: false }),
      sb.from('presupuesto').select('*').eq('user_phone', phone),
      sb.from('nidito').select('*').order('completado').order('prioridad', { ascending: false }),
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
        `🗑 *borrar ultimo* — eliminar el último registro\n\n` +
        `También puedes escribirme en lenguaje natural o mandarme foto/PDF de un estado de cuenta 📄`;

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

    } else if (lower === 'borrar ultimo') {
      const { data: ultimo } = await sb.from('movimientos')
        .select('*').eq('user_phone', From)
        .order('created_at', { ascending: false }).limit(1).single();
      if (ultimo) {
        await sb.from('movimientos').delete().eq('id', ultimo.id);
        reply = `🗑 Eliminado: ${ultimo.tipo} | ${ultimo.categoria} | ${ultimo.descripcion} | ${fmt(ultimo.monto)}`;
      } else {
        reply = `No encontré ningún movimiento para eliminar.`;
      }

    } else if (hasMedia && MediaUrl0) {
      reply = '📄 Analizando tu estado de cuenta... dame un momento ⏳';
      await enviarWhatsApp(From, reply);

      const mediaResp = await axios.get(MediaUrl0, {
        auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN },
        responseType: 'arraybuffer',
      });
      const b64  = Buffer.from(mediaResp.data).toString('base64');
      const mime = MediaContentType0 || 'image/jpeg';
      const ctx  = await cargarContexto(From, usuario.role);
      const sys  = buildSystemPrompt(usuario, ctx);

      const contentParts = [
        mime === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: mime, data: b64 } }
          : { type: 'image',    source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: 'Analiza este estado de cuenta. Dame: banco y período, cargos principales, intereses cobrados, algo disputable, y la acción concreta que debo tomar esta semana según mi plan de finanzas.' },
      ];

      // Siempre Claude para análisis de documentos (mejor visión)
      const analisisResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     sys,
        messages:   [{ role: 'user', content: contentParts }],
        ...(mime === 'application/pdf' ? { betas: ['pdfs-2024-09-25'] } : {}),
      });
      reply = analisisResp.content[0].text;

    } else {
      const ctx       = await cargarContexto(From, usuario.role);
      const sys       = buildSystemPrompt(usuario, ctx);
      const historial = await cargarHistorial(From);

      await guardarMensaje(From, 'user', Body || '');

      const respuestaRaw = await llamarIA(usuario, sys, historial, Body || '');
      const { limpio, saves, metas, presup } = parsearYLimpiar(respuestaRaw);

      await guardarMensaje(From, 'assistant', limpio);
      await ejecutarGuardados(saves, metas, presup, From);

      reply = limpio;
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
      const sys   = await buildSystemPrompt(user);
      const input = isAudio ? `[🎤 Nota de voz web] ${text}` : text;

      if (user.ai_preference === 'CLAUDE') {
        // ── Claude: llamarIA + text tokens (SAVE/META/PRESUPUESTO) + DB history ──
        const historial = await cargarHistorial(phone);
        const rawReply  = await llamarIA(user, sys, historial, input);
        const { limpio, saves, metas, presup } = parsearYLimpiar(rawReply);
        await guardarMensaje(phone, 'user', input);
        await guardarMensaje(phone, 'assistant', limpio);
        await ejecutarGuardados(saves, metas, presup, phone)
          .catch(e => console.error('chat-web ejecutarGuardados:', e.message));
        reply = limpio;
      } else {
        // ── Gemini: callIA con function calling nativo (más confiable para DB) ──
        // Precargar historial DB → history[phone] para persistencia entre reinicios
        const dbHistorial = await cargarHistorial(phone);
        history[phone] = dbHistorial.map(m => ({ role: m.role, content: m.content }));
        reply = await callIA(user, sys, input, phone);
        // Guardar en DB (callIA ya actualiza history[] en memoria)
        await guardarMensaje(phone, 'user', input);
        await guardarMensaje(phone, 'assistant', reply);
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
