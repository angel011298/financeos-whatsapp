// FinanceOS WhatsApp — server.js v2
// Stack: Express + Twilio + Claude (Sonnet 4.6) + Supabase
// Deploy: Railway.app

require('dotenv').config();
const express   = require('express');
const path      = require('path');
const twilio    = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const axios     = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CLIENTS ────────────────────────────────────────────────────────────────
const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: WebSocket },
});
const ai  = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const twl = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM;

// ── CONVERSATION MEMORY (en memoria, se resetea en redeploy) ────────────────
const history = {};

// ── HELPERS ────────────────────────────────────────────────────────────────
function fmt(n) {
  return '$' + Math.round(n || 0).toLocaleString('es-MX');
}

function hoy() {
  return new Date().toISOString().split('T')[0];
}

function mesActual() {
  return hoy().substring(0, 7) + '-01';
}

// ── SYSTEM PROMPT (inteligente, conversacional, auto-aprendizaje) ───────────
async function buildSystemPrompt() {
  const today = hoy();

  const [tdcRes, movsRes, metasRes, calRes] = await Promise.all([
    sb.from('tdc').select('*').order('prioridad'),
    sb.from('movimientos').select('*').order('created_at', { ascending: false }).limit(50),
    sb.from('metas').select('*'),
    sb.from('calendario').select('*')
      .gte('fecha', today)
      .order('fecha')
      .limit(15),
  ]);

  const tdcs    = tdcRes.data   || [];
  const movs    = movsRes.data  || [];
  const metas   = metasRes.data || [];
  const eventos = calRes.data   || [];

  // Análisis de patrones
  const gastosMes   = movs.filter(m => m.tipo === 'GASTO').reduce((a, m) => a + (m.monto || 0), 0);
  const ingresosMes = movs.filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + (m.monto || 0), 0);

  const catTotales = {};
  const medioPagoUso = {};
  const comentariosRecientes = [];

  movs.forEach(m => {
    if (m.tipo === 'GASTO') {
      catTotales[m.categoria] = (catTotales[m.categoria] || 0) + (m.monto || 0);
      if (m.medio_pago) medioPagoUso[m.medio_pago] = (medioPagoUso[m.medio_pago] || 0) + 1;
    }
    if (m.comentarios && m.comentarios.trim()) comentariosRecientes.push(m.comentarios.trim());
  });

  const topCats = Object.entries(catTotales)
    .sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([c, t]) => `${c}: ${fmt(t)}`).join(', ');

  const topMedios = Object.entries(medioPagoUso)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([m, c]) => `${m}(${c}x)`).join(', ');

  const eventosProximos = eventos.length
    ? eventos.map(e => `• ${e.fecha}${e.hora ? ' '+e.hora : ''}: ${e.titulo} [${e.tipo}]${e.completado ? ' ✅' : ''}`).join('\n')
    : '• Sin eventos próximos';

  const patrones = comentariosRecientes.length
    ? `Comentarios recientes de contexto:\n${comentariosRecientes.slice(0, 5).map(c => `  - "${c}"`).join('\n')}`
    : '';

  return `Eres el asesor financiero personal de Ángel Alberto Ortiz Sánchez (Ciudad de México).
Fecha hoy: ${today}

PERSONALIDAD:
- Eres inteligente, empático y proactivo. No das respuestas robóticas.
- Hablas como un amigo experto en finanzas mexicanas.
- Respuestas cortas y directas para WhatsApp (máx 4 párrafos o lista concisa).
- Usas emojis con moderación. Siempre en español.
- PROACTIVO: si detectas patrones problemáticos, los mencionas sin que te pregunten.
- APRENDES de los comentarios de contexto para dar mejores consejos.

════════════════════════════════
CONTEXTO FINANCIERO COMPLETO
════════════════════════════════
Ingreso mensual base: $31,898 MXN
  • Sueldo neto: $27,407 (quincenas $13,703 los días 1 y 16)
  • WFH: $425 | Vales despensa: $3,566 (día 10) | Beca: $500
Egresos fijos: ~$9,172/mes
Disponible para TDC: ~$22,726/mes
Inicio empleo: 26 mayo 2026 | META: DEUDA CERO FEBRERO 2027

DEUDAS TDC (prioridad):
${tdcs.map(t => {
  const saldo = Math.max(0, (t.a_pagar || 0) - (t.pagado || 0));
  const pct = t.deuda_original > 0 ? Math.round((1 - t.a_pagar / t.deuda_original) * 100) : 0;
  return `• [${t.prioridad}] ${t.nombre} — orig ${fmt(t.deuda_original)} → pagar ${fmt(t.a_pagar)} | pagado ${fmt(t.pagado)} | SALDO ${fmt(saldo)} | desc. ${pct}% | ${t.estado.toUpperCase()} | ${t.mes_objetivo}`;
}).join('\n')}

ACTIVIDAD (últimos 50 mov.):
• Gastos: ${fmt(gastosMes)} | Ingresos: ${fmt(ingresosMes)} | Neto: ${fmt(ingresosMes - gastosMes)}
• Top categorías: ${topCats || 'Sin datos'}
• Medios de pago más usados: ${topMedios || 'Sin datos'}

${patrones}

ÚLTIMOS 10 MOVIMIENTOS:
${movs.slice(0, 10).map(m =>
  `• ${m.fecha} | ${m.tipo} | ${m.categoria}${m.concepto ? ' | '+m.concepto : ''} | ${fmt(m.monto)} | ${m.medio_pago || 'efectivo'}${m.comentarios ? ' 📝 '+m.comentarios : ''}`
).join('\n')}

METAS DE AHORRO:
${metas.map(m => {
  const pct = m.meta > 0 ? Math.round(((m.actual || 0) / m.meta) * 100) : 0;
  return `• ${m.nombre} [${m.tipo}]: ${fmt(m.actual)} / ${fmt(m.meta)} (${pct}%)`;
}).join('\n') || '• Sin metas aún'}

CALENDARIO (próximos eventos):
${eventosProximos}

════════════════════════════════
REGISTRO DE MOVIMIENTOS
════════════════════════════════
Cuando el usuario registre un GASTO o INGRESO, incluye AL FINAL de tu respuesta (invisible para el usuario) la línea SAVE con TODOS los campos:

SAVE:{"tipo":"GASTO","categoria":"COMIDA","concepto":"Tacos de canasta","descripcion":"Lunch rápido","comentarios":"con Alicia, gasto social","monto":120,"medio_pago":"efectivo","fecha":"${today}"}

SAVE:{"tipo":"INGRESO","categoria":"SUELDO","concepto":"Quincena 1","descripcion":"Depósito nómina","comentarios":"","monto":13703,"medio_pago":"transferencia","fecha":"${today}"}

CATEGORÍAS DE GASTOS:
HOGAR, COMIDA, TDC, DESPENSA, HORMIGA, OCIO, PERSONALES, PLATINA, PASAJES, SALUD, TECNOLOGIA, SERVICIOS, OTROS
(Para TDC siempre especifica: "TDC" como categoría y en concepto pon "Pago BBVA" etc.)

CATEGORÍAS DE INGRESOS:
SUELDO, VALES_DESPENSA, BECA, WFH, FREELANCE, AGUINALDO, TRANSFERENCIA, REEMBOLSO, OTRO_INGRESO

MEDIOS DE PAGO: efectivo, BBVA, HEY, Liverpool, AMEX, NU, Rappi Card, Palacio, transferencia, otro

════════════════════════════════
CALENDARIO / RECORDATORIOS
════════════════════════════════
Para agendar eventos o recordatorios incluye AL FINAL:

CALENDAR:{"titulo":"Cumpleaños de Jorge","fecha":"2026-07-15","hora":"19:00","tipo":"cumpleanos","descripcion":"Llevar regalo","recordatorio_fecha":"2026-07-13"}

REMINDER:{"titulo":"Cambiar cepillo de dientes","fecha":"2026-08-31","tipo":"recordatorio","descripcion":"Cada 3 meses"}

TIPOS de evento: evento, recordatorio, cumpleanos, pago, cita, otro

════════════════════════════════
METAS DE AHORRO
════════════════════════════════
META:{"accion":"crear","nombre":"Fondo emergencia","meta":10000}
META:{"accion":"abonar","nombre":"Fondo emergencia","monto":500}

════════════════════════════════
REGLAS IMPORTANTES
════════════════════════════════
• SOLO incluye SAVE/CALENDAR/REMINDER/META al final si el usuario está registrando algo específico.
• En conversación normal o preguntas, NO incluyas nada.
• Si el usuario menciona un gasto pasado (ayer, el lunes, etc.) usa esa fecha en el campo "fecha".
• Si hay eventos próximos en el calendario en los próximos 3 días, mencionarlos proactivamente.
• Si los gastos de HORMIGA son altos, dar consejo específico.
• Siempre da el número exacto de saldo disponible cuando sea relevante.`;
}

// ── SAVE MOVIMIENTO (6 campos) ──────────────────────────────────────────────
async function saveMovimiento(data) {
  const fecha = data.fecha || hoy();
  await sb.from('movimientos').insert({
    tipo:        data.tipo        || 'GASTO',
    categoria:   data.categoria   || 'OTROS',
    concepto:    data.concepto    || data.descripcion || '',
    descripcion: data.descripcion || data.concepto    || '',
    comentarios: data.comentarios || '',
    monto:       parseFloat(data.monto) || 0,
    medio_pago:  data.medio_pago  || 'efectivo',
    fecha,
  });
}

// ── CALENDARIO ──────────────────────────────────────────────────────────────
async function handleCalendar(data) {
  if (!data || !data.titulo) return;
  await sb.from('calendario').insert({
    titulo:             data.titulo || 'Evento',
    descripcion:        data.descripcion || '',
    fecha:              data.fecha || hoy(),
    hora:               data.hora || null,
    recordatorio_fecha: data.recordatorio_fecha || null,
    tipo:               data.tipo || 'evento',
    completado:         false,
  });
}

// ── METAS ───────────────────────────────────────────────────────────────────
async function handleMeta(data) {
  if (data.accion === 'crear') {
    await sb.from('metas').upsert(
      { nombre: data.nombre, meta: parseFloat(data.meta), actual: 0 },
      { onConflict: 'nombre' }
    );
  } else if (data.accion === 'abonar') {
    const { data: existing } = await sb.from('metas')
      .select('actual').eq('nombre', data.nombre).single();
    if (existing) {
      await sb.from('metas')
        .update({ actual: (existing.actual || 0) + parseFloat(data.monto), updated_at: new Date().toISOString() })
        .eq('nombre', data.nombre);
    }
  }
}

// ── EXTRACT & STRIP (parsea SAVE / CALENDAR / REMINDER / META) ──────────────
function extractAndStrip(text) {
  // Regex que soporta JSON multilinea y con caracteres especiales
  const saveMatch     = text.match(/SAVE:(\{[^{}]+\})/s);
  const metaMatch     = text.match(/META:(\{[^{}]+\})/s);
  const calMatch      = text.match(/CALENDAR:(\{[^{}]+\})/s);
  const reminderMatch = text.match(/REMINDER:(\{[^{}]+\})/s);

  let cleanText = text
    .replace(/SAVE:\{[^{}]+\}/gs, '')
    .replace(/META:\{[^{}]+\}/gs, '')
    .replace(/CALENDAR:\{[^{}]+\}/gs, '')
    .replace(/REMINDER:\{[^{}]+\}/gs, '')
    .trim();

  const tryParse = (match) => {
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch (e) { return null; }
  };

  const saveData     = tryParse(saveMatch);
  const metaData     = tryParse(metaMatch);
  const calData      = tryParse(calMatch) || tryParse(reminderMatch);

  return { cleanText, saveData, metaData, calData };
}

// ── QUICK COMMANDS ──────────────────────────────────────────────────────────
async function cmdResumen() {
  const today    = hoy();
  const mesStart = mesActual();

  const [{ data: movHoy }, { data: movMes }, { data: tdcs }, { data: eventosHoy }] = await Promise.all([
    sb.from('movimientos').select('*').eq('fecha', today),
    sb.from('movimientos').select('*').gte('fecha', mesStart),
    sb.from('tdc').select('*').order('prioridad'),
    sb.from('calendario').select('*').eq('fecha', today).eq('completado', false),
  ]);

  const gastoHoy = (movHoy || []).filter(m => m.tipo === 'GASTO').reduce((a, m) => a + m.monto, 0);
  const ingrHoy  = (movHoy || []).filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + m.monto, 0);
  const gastoMes = (movMes || []).filter(m => m.tipo === 'GASTO').reduce((a, m) => a + m.monto, 0);
  const ingrMes  = (movMes || []).filter(m => m.tipo === 'INGRESO').reduce((a, m) => a + m.monto, 0);
  const tdcPend  = (tdcs || []).reduce((a, t) => a + Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)), 0);

  const ultMovs = (movHoy || []).slice(0, 4).map(m =>
    `  ${m.tipo === 'GASTO' ? '💸' : '💰'} ${m.categoria}${m.concepto ? ' · '+m.concepto : ''}: ${fmt(m.monto)} (${m.medio_pago || 'efectivo'})`
  ).join('\n');

  const eventosTxt = (eventosHoy || []).length
    ? '\n\n*📅 HOY*\n' + eventosHoy.map(e => `  • ${e.titulo}`).join('\n')
    : '';

  return `📊 *RESUMEN FINANCIERO*\n📅 ${today}\n\n` +
    `*HOY*\n💸 Gasto: ${fmt(gastoHoy)}\n💵 Ingreso: ${fmt(ingrHoy)}\n\n` +
    `*ESTE MES*\n💸 Gastos: ${fmt(gastoMes)}\n💵 Ingresos: ${fmt(ingrMes)}\n📈 Neto: ${fmt(ingrMes - gastoMes)}\n\n` +
    `*TDC PENDIENTE*\n💳 ${fmt(tdcPend)} total\n\n` +
    (ultMovs ? `*Movimientos de hoy*\n${ultMovs}\n` : '') +
    eventosTxt + '\n\n🎯 Meta: Deuda cero Feb 2027';
}

async function cmdDeudas() {
  const { data: tdcs } = await sb.from('tdc').select('*').order('prioridad');
  if (!tdcs?.length) return '💳 No tienes deudas registradas aún.';

  const rows = tdcs.map(t => {
    const saldo = Math.max(0, (t.a_pagar || 0) - (t.pagado || 0));
    const pct   = t.deuda_original > 0 ? Math.round((1 - t.a_pagar / t.deuda_original) * 100) : 0;
    const bar   = '█'.repeat(Math.round((t.pagado || 0) / (t.a_pagar || 1) * 5)).padEnd(5, '░');
    return `*${t.nombre}* ${t.estado.toUpperCase()}\n  ${bar} Saldo: ${fmt(saldo)} (desc. ${pct}%)\n  Objetivo: ${t.mes_objetivo || '—'}`;
  }).join('\n\n');

  const totalSaldo = tdcs.reduce((a, t) => a + Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)), 0);
  return `💳 *DEUDAS TDC*\n\n${rows}\n\n📌 Total: *${fmt(totalSaldo)}*\n🎯 Meta: deuda cero Feb 2027`;
}

async function cmdMetas() {
  const { data: metas } = await sb.from('metas').select('*');
  if (!metas?.length) return '🎯 Sin metas. Escríbeme: _"quiero ahorrar $10,000 para fondo de emergencia"_';

  const rows = metas.map(m => {
    const pct = m.meta > 0 ? Math.min(100, Math.round((m.actual || 0) / m.meta * 100)) : 0;
    const bar = '█'.repeat(Math.round(pct / 20)).padEnd(5, '░');
    return `*${m.nombre}* [${m.tipo}]\n  ${bar} ${fmt(m.actual)} / ${fmt(m.meta)} (${pct}%)`;
  }).join('\n\n');

  return `🎯 *METAS DE AHORRO*\n\n${rows}`;
}

async function cmdCalendario() {
  const { data: eventos } = await sb.from('calendario')
    .select('*')
    .gte('fecha', hoy())
    .order('fecha')
    .limit(10);

  if (!eventos?.length) return '📅 Sin eventos próximos.\nEscríbeme: _"recuérdame X el 15 de julio"_ o _"cumpleaños de Jorge el 26 de mayo"_';

  const rows = eventos.map(e => {
    const icons = { evento: '📌', recordatorio: '⏰', cumpleanos: '🎂', pago: '💳', cita: '📋', otro: '📎' };
    return `${icons[e.tipo] || '📎'} *${e.fecha}* — ${e.titulo}${e.completado ? ' ✅' : ''}`;
  }).join('\n');

  return `📅 *PRÓXIMOS EVENTOS*\n\n${rows}\n\nEscribe _"agendar [evento] el [fecha]"_ para agregar.`;
}

async function cmdHistorial() {
  const { data: movs } = await sb.from('movimientos')
    .select('*').order('created_at', { ascending: false }).limit(10);
  if (!movs?.length) return '📋 Sin movimientos registrados aún.';

  const rows = movs.map(m =>
    `${m.tipo === 'GASTO' ? '💸' : '💰'} ${m.fecha} | ${m.categoria}${m.concepto ? ' · '+m.concepto : ''} | ${fmt(m.monto)} | ${m.medio_pago || 'efectivo'}${m.comentarios ? '\n   📝 '+m.comentarios : ''}`
  ).join('\n');

  return `📋 *ÚLTIMOS MOVIMIENTOS*\n\n${rows}`;
}

function cmdAyuda() {
  return `🤖 *FinanceOS v2 — Comandos*\n\n` +
    `📊 *resumen* — resumen financiero del día\n` +
    `💳 *deudas* — estado de tus 7 TDC\n` +
    `🎯 *metas* — objetivos de ahorro\n` +
    `📋 *historial* — últimos 10 movimientos\n` +
    `📅 *calendario* — próximos eventos\n\n` +
    `*Registrar gastos (lenguaje natural):*\n` +
    `💸 "gasté 200 en el super con BBVA, fue con Alicia"\n` +
    `💸 "pagué 150 de pasajes en efectivo"\n` +
    `💸 "abono de $2,700 a BBVA desde mi cuenta"\n` +
    `💰 "me depositaron 13,703 de quincena"\n` +
    `💰 "recibí $2,500 de freelance"\n\n` +
    `*Calendario:*\n` +
    `📅 "recuérdame cambiar mi cepillo en 3 meses"\n` +
    `📅 "cumpleaños de Jorge el 15 de julio"\n` +
    `📅 "cita con el dentista el 20 de junio a las 10am"\n\n` +
    `*Preguntas financieras:*\n` +
    `❓ "¿Cuándo termino de pagar todas mis deudas?"\n` +
    `❓ "¿Cuánto he gastado en comida este mes?"\n` +
    `❓ "Guión para negociar con NU"\n\n` +
    `📄 Envía foto/PDF de estado de cuenta para análisis\n\n` +
    `🌐 Dashboard: financeos-whatsapp-production.up.railway.app`;
}

// ── ANALYZE BANK STATEMENT ──────────────────────────────────────────────────
async function analyzeBankStatement(mediaUrl, mediaType) {
  const response = await axios.get(mediaUrl, {
    auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN },
    responseType: 'arraybuffer',
  });
  const b64 = Buffer.from(response.data).toString('base64');

  const sysPrompt = await buildSystemPrompt();
  const isImage   = (mediaType || '').startsWith('image/');
  const isPDF     = mediaType === 'application/pdf';

  if (!isImage && !isPDF) {
    return '⚠️ Formato no soportado. Envía el estado de cuenta como imagen JPG/PNG o PDF.';
  }

  const contentParts = [];
  if (isImage) {
    contentParts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } });
  } else {
    contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
  }
  contentParts.push({
    type: 'text',
    text: 'Analiza este estado de cuenta completo. Dame: banco y período, saldo e intereses cobrados, top 5 cargos más altos, cargos disputables, y la acción específica que debo tomar ESTA SEMANA con esta tarjeta según mi plan de liquidación.',
  });

  const apiOptions = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: sysPrompt,
    messages: [{ role: 'user', content: contentParts }],
  };
  if (isPDF) apiOptions.betas = ['pdfs-2024-09-25'];

  const result = await ai.messages.create(apiOptions);
  return result.content[0].text;
}

// ── MAIN WEBHOOK ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // Responder 200 inmediatamente para que Twilio no reintente

  const { Body, From, MediaUrl0, MediaContentType0, NumMedia } = req.body;
  const phone = From || 'unknown';
  let reply   = '';

  try {
    const text     = (Body || '').trim();
    const lower    = text.toLowerCase().trim();
    const hasMedia = parseInt(NumMedia || 0) > 0;

    if (hasMedia && MediaUrl0) {
      reply = await analyzeBankStatement(MediaUrl0, MediaContentType0);

    } else if (['resumen', 'ver resumen', 'summary'].includes(lower)) {
      reply = await cmdResumen();

    } else if (['deudas', 'ver deudas', 'tdc'].includes(lower)) {
      reply = await cmdDeudas();

    } else if (['metas', 'ver metas', 'objetivos'].includes(lower)) {
      reply = await cmdMetas();

    } else if (['historial', 'movimientos'].includes(lower)) {
      reply = await cmdHistorial();

    } else if (['calendario', 'eventos', 'agenda'].includes(lower)) {
      reply = await cmdCalendario();

    } else if (['ayuda', 'help', 'menu', 'inicio', 'start', 'hola'].includes(lower)) {
      reply = cmdAyuda();

    } else {
      // ── CLAUDE maneja todo lo demás ────────────────────────────────────────
      if (!history[phone]) history[phone] = [];

      const sysPrompt = await buildSystemPrompt();
      history[phone].push({ role: 'user', content: text });

      // Mantener últimas 20 mensajes en contexto
      if (history[phone].length > 20) history[phone].splice(0, 2);

      const result = await ai.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 900,
        system:     sysPrompt,
        messages:   history[phone],
      });

      const rawReply = result.content[0].text;
      const { cleanText, saveData, metaData, calData } = extractAndStrip(rawReply);

      history[phone].push({ role: 'assistant', content: cleanText });

      // Persistir en Supabase si Claude detectó algo
      const actions = [];
      if (saveData)  actions.push(saveMovimiento(saveData));
      if (metaData)  actions.push(handleMeta(metaData));
      if (calData)   actions.push(handleCalendar(calData));

      if (actions.length) await Promise.all(actions);

      if (saveData) {
        const icon = saveData.tipo === 'INGRESO' ? '💰' : '💸';
        reply = cleanText + `\n\n${icon} _Registrado: ${saveData.concepto || saveData.descripcion || saveData.categoria} · ${fmt(saveData.monto)}_`;
      } else if (metaData) {
        reply = cleanText + '\n\n🎯 _Meta actualizada_';
      } else if (calData) {
        reply = cleanText + '\n\n📅 _Evento agendado_';
      } else {
        reply = cleanText;
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
    reply = '❌ Algo salió mal. Intenta de nuevo o escribe *ayuda*.';
  }

  if (reply && From) {
    try {
      await twl.messages.create({ from: WA_FROM, to: From, body: reply });
    } catch (err) {
      console.error('Twilio send error:', err);
    }
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'FinanceOS WhatsApp running ✅', version: '2.0', ts: new Date().toISOString() })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinanceOS WhatsApp v2 — puerto ${PORT}`));
