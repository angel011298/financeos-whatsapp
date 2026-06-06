// FinanceOS WhatsApp — server.js v4 (IA Autodidacta + Calendario + Dashboard)
// Stack: Express + Twilio + Claude Sonnet 4.6 + Gemini 1.5 + Supabase
// Deploy: Railway.app

require('dotenv').config();
const express = require('express');
const path    = require('path');
const twilio  = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const WebSocket  = require('ws');
const Anthropic  = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CLIENTS ────────────────────────────────────────────────────────────────
const sb    = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: WebSocket } });
const ai    = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const twl   = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM;

const history = {};

// ── HELPERS ────────────────────────────────────────────────────────────────
const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-MX');
const hoy = () => new Date().toISOString().split('T')[0];
const mes  = () => hoy().substring(0, 7);

const CATEGORIAS   = ['Hogar','Comida','TDC','Despensa','Hormiga','Ocio','Personales','Platina','Pasajes','OTROS'];
const MEDIOS_PAGO  = ['efectivo','TDC BBVA','TDC HEY','TDC Liverpool','TDC AMEX','TDC NU','TDC Rappi','TDC Palacio','transferencia','débito'];

// ── USER ───────────────────────────────────────────────────────────────────
async function getOrCreateUser(phone) {
  let { data: u } = await sb.from('usuarios').select('*').eq('telefono', phone).single();
  if (!u) {
    const { data: n } = await sb.from('usuarios').insert([{ telefono: phone, role: 'USER_B', ai_preference: 'CLAUDE' }]).select().single();
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
        body: `🔔 *Recordatorio FinanceOS*\nMañana: *${ev.titulo}*\n📅 ${ev.fecha}${ev.hora ? ' a las ' + ev.hora : ''}\n${ev.descripcion || ''}`
      });
      await sb.from('calendario').update({ notificado: true }).eq('id', ev.id);
    } catch (e) { console.error('reminder err:', e.message); }
  }
}

// ── DB ACTION EXECUTOR ─────────────────────────────────────────────────────
async function executeDbAction(phone, arg) {
  const { tabla, accion, id, datos } = arg;
  try {
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

  const [tdcR, movsR, metasR, calR, patrR, prspR] = await Promise.all([
    sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
    sb.from('movimientos').select('*').eq('user_phone', phone).order('created_at', { ascending: false }).limit(60),
    sb.from('metas').select('*').eq('user_phone', phone),
    sb.from('calendario').select('*').eq('user_phone', phone).gte('fecha', today).order('fecha').limit(10),
    sb.from('patrones_ia').select('*').eq('user_phone', phone).order('contador', { ascending: false }).limit(10),
    sb.from('presupuesto').select('*').eq('user_phone', phone).eq('mes', mesStr),
  ]);

  const tdcs = tdcR.data || [], movs = movsR.data || [], metas = metasR.data || [];
  const eventos = calR.data || [], patrones = patrR.data || [], presp = prspR.data || [];

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

  return `Eres FinanceOS, el asesor financiero personal inteligente de Ángel.
Hoy: ${today} | Mes: ${mesStr}

REGLAS DE ORO:
- Habla con naturalidad. NO eres un bot robótico. Eres un asesor que conoce bien a Ángel.
- Para WhatsApp: máx 4 párrafos cortos. Usa emojis con moderación.
- DETECTA PATRONES: Si gasta mucho en algo comparado con historial, avísale proactivamente.
- TIENES PODER DE ACCIÓN: usa la herramienta 'modificar_plataforma' automáticamente cuando el usuario registre un gasto, ingreso, pago TDC o evento de calendario.
- Si el usuario dice algo como "gasté X en Y" o "pagué Z" o "recuérdame en N días/meses" → EJECUTA la herramienta sin preguntar primero.

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

DEUDAS TDC:
${tdcs.map(t => `  [${t.id}] ${t.nombre} (${t.estado}): pago ${fmt(t.a_pagar)} saldo ${fmt(Math.max(0, (t.a_pagar || 0) - (t.pagado || 0)))}`).join('\n') || '  Sin TDC'}

ÚLTIMOS 10 MOVIMIENTOS:
${movs.slice(0, 10).map(m => `  [${m.id}] ${m.fecha} ${m.tipo} ${m.categoria} "${m.concepto||''}" ${fmt(m.monto)} ${m.medio_pago||''}`).join('\n') || '  Sin movimientos'}

METAS: ${metas.map(m => `[${m.id}] ${m.nombre}: ${fmt(m.actual)}/${fmt(m.meta)}`).join(' | ') || 'Sin metas'}

PRÓXIMOS EVENTOS:
${eventos.map(e => `  [${e.id}] ${e.fecha}: ${e.titulo}`).join('\n') || '  Calendario vacío'}

PATRONES (top conceptos recurrentes):
${patrones.map(p => `  ${p.concepto_clave}: promedio ${fmt(p.monto_promedio)}, ${p.contador}x, último ${p.ultima_vez}, medio: ${p.medio_pago_usual||'?'}`).join('\n') || '  Sin patrones aún'}
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
  description: "Crea, edita o elimina registros en: movimientos, metas, calendario, tdc, presupuesto.",
  input_schema: {
    type: "object",
    properties: {
      tabla:  { type: "string", enum: ["movimientos","metas","calendario","tdc","presupuesto"] },
      accion: { type: "string", enum: ["crear","editar","eliminar"] },
      id:     { type: "string", description: "ID a editar/eliminar" },
      datos:  { type: "object", description: "Campos a insertar/actualizar. Para movimientos: tipo, categoria, concepto, comentarios, monto, medio_pago, fecha. Para calendario: titulo, fecha, hora, tipo, descripcion, recurrente." }
    },
    required: ["tabla","accion"]
  }
};

const geminiTools = [{ functionDeclarations: [{ name: "modificar_plataforma", description: "Crea, edita o elimina registros.", parameters: { type: "OBJECT", properties: { tabla: { type: "STRING" }, accion: { type: "STRING" }, id: { type: "STRING" }, datos: { type: "OBJECT" } }, required: ["tabla","accion"] } }] }];

// ── LLM ENGINE ─────────────────────────────────────────────────────────────
async function callIA(user, sysPrompt, text, phone) {
  if (!history[phone]) history[phone] = [];
  history[phone].push({ role: 'user', content: text });
  if (history[phone].length > 20) history[phone].splice(0, 2);

  if (user.ai_preference === 'GEMINI') {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro', tools: geminiTools });
    const gHist = history[phone].map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] }));
    const chat = model.startChat({ history: gHist.slice(0, -1), systemInstruction: sysPrompt });
    const res = await chat.sendMessage(text);
    const calls = res.response.functionCalls();
    if (calls?.length) {
      const dbRes = await executeDbAction(phone, calls[0].args);
      const res2 = await chat.sendMessage([{ functionResponse: { name: "modificar_plataforma", response: { result: dbRes } } }]);
      const reply = res2.response.text();
      history[phone].push({ role: 'assistant', content: reply });
      return reply;
    }
    const reply = res.response.text();
    history[phone].push({ role: 'assistant', content: reply });
    return reply;
  }

  // Claude
  const msg = await ai.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: sysPrompt, tools: [toolsSchema], messages: history[phone] });
  if (msg.stop_reason === 'tool_use') {
    const tc = msg.content.find(c => c.type === 'tool_use');
    const txt0 = msg.content.find(c => c.type === 'text')?.text || '';
    const dbRes = await executeDbAction(phone, tc.input);
    history[phone].push({ role: 'assistant', content: msg.content });
    history[phone].push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: tc.id, content: dbRes }] });
    const msg2 = await ai.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: sysPrompt, tools: [toolsSchema], messages: history[phone] });
    const reply = msg2.content[0].text;
    history[phone].push({ role: 'assistant', content: reply });
    return (txt0 ? txt0 + '\n' : '') + reply;
  }
  const reply = msg.content[0].text;
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
      await sb.from('usuarios').insert([{ telefono: phone, role: 'USER_B', ai_preference: 'CLAUDE' }]);
    }
    const [tdc, movs, metas, user, cal, pat, presp] = await Promise.all([
      sb.from('tdc').select('*').eq('user_phone', phone).order('prioridad'),
      sb.from('movimientos').select('*').eq('user_phone', phone).order('fecha', { ascending: false }).limit(500),
      sb.from('metas').select('*').eq('user_phone', phone),
      sb.from('usuarios').select('*').eq('telefono', phone).single(),
      sb.from('calendario').select('*').eq('user_phone', phone).order('fecha'),
      sb.from('patrones_ia').select('*').eq('user_phone', phone).order('contador', { ascending: false }),
      sb.from('presupuesto').select('*').eq('user_phone', phone),
    ]);
    res.json({ success: true, data: { tdc: tdc.data, movs: movs.data, metas: metas.data, user: user.data, calendario: cal.data, patrones: pat.data, presupuesto: presp.data } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Lista todos los usuarios (para ghost mode del admin)
app.get('/api/usuarios', async (req, res) => {
  try {
    const { data } = await sb.from('usuarios').select('telefono, nombre, role, ai_preference');
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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

app.post('/api/send-whatsapp-invite', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });
    const msg = `Hola 👋 Desde *FinanceOS*\n\nPara conectarte al bot y gestionar tus gastos, responde a este mensaje o envía:\n\n*join everywhere-shot*\n\nLuego podrás hablar conmigo naturalmente: "gasté 250 en comida", "pago mínimo BBVA", etc.`;
    await twl.messages.create({ from: WA_FROM, to: phone, body: msg });
    res.json({ success: true, message: 'Invitación enviada a WhatsApp' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── WEBHOOK ────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  const { Body, From, MediaUrl0 } = req.body;
  const phone = From || 'unknown';
  let reply = '';
  try {
    const text = (Body || '').trim();
    const lower = text.toLowerCase().trim();
    const user = await getOrCreateUser(phone);
    await checkAndSendReminders(phone).catch(() => {});

    if (['resumen','summary'].includes(lower))               reply = await cmdResumen(phone);
    else if (['deudas','tdc'].includes(lower))               reply = await cmdDeudas(phone);
    else if (['historial','movimientos'].includes(lower))    reply = await cmdHistorial(phone);
    else if (['calendario','agenda','eventos'].includes(lower)) reply = await cmdCalendario(phone);
    else if (['ayuda','hola','help'].includes(lower))
      reply = `🤖 *FinanceOS v4* (${user.ai_preference})\n\n*Comandos:* resumen · deudas · historial · calendario · ayuda\n\n*Habla natural:*\n"Gasté 250 en comida con Alicia"\n"Pagué mínimo BBVA $2700"\n"Recuérdame cambiar cepillo en 3 meses"\n"Recibí $8000 de sueldo"\n"Agrega 500 de pasajes en efectivo"`;
    else {
      const sys = await buildSystemPrompt(user);
      reply = await callIA(user, sys, text + (MediaUrl0 ? `\n[Adjunto: ${MediaUrl0}]` : ''), phone);
    }
  } catch (err) {
    console.error('Webhook err:', err);
    reply = '❌ Algo salió mal. Intenta de nuevo.';
  }
  if (reply && From) {
    try { await twl.messages.create({ from: WA_FROM, to: From, body: reply }); }
    catch (e) { console.error('Twilio err:', e.message); }
  }
});

app.get('/api/health', (_req, res) => res.json({ status: 'FinanceOS v4 ✅' }));

// ── SEED ADMIN AL STARTUP ──────────────────────────────────────────────────
// Si ADMIN_PHONE está definido, asigna automáticamente los registros huérfanos
// (TDC y metas sin user_phone) al admin. Configura en Railway env vars:
// ADMIN_PHONE=whatsapp:+521XXXXXXXXXX
async function seedAdminOnStartup() {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) return;
  try {
    await sb.from('usuarios').upsert(
      [{ telefono: adminPhone, role: 'ADMIN_A', ai_preference: 'CLAUDE' }],
      { onConflict: 'telefono' }
    );
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
  console.log(`FinanceOS v4 — puerto ${PORT}`);
  await seedAdminOnStartup();
});
