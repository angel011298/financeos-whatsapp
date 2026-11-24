// ── US ⇄ Google (Gmail y Calendar) ──────────────────────────────────────────────────────────────────────────────────
// Todo llega por el script de Apps Script de cada cuenta de Gmail (v3, el mismo de «Compras del correo»), con su token:
//  1) Índice de correos: recibos de suscripciones, promociones y códigos de descuento → el chat contesta sobre tu correo
//     («¿qué día se paga Disney?», «¿cuánto pago de Google?», «¿qué promociones tengo en Amazon?», «¿qué códigos tengo?»).
//     Las cifras se calculan aquí (faqCorreo); la IA no inventa nada.
//  2) Calendario en ambos sentidos: los eventos del Google Calendar de cada cuenta entran a US (origen 'google') y lo que
//     creas, cambias o borras en US se copia a Google. Un trigger en la base marca google_sync='pendiente'/'borrar' en
//     cada cambio hecho en US; la sincronización escribe google_updated, así el trigger sabe que ese cambio vino de Google.
//     Los eventos nuevos de US van a la cuenta principal (cal_principal en correo_sync); las instancias de series creadas
//     en Google son de solo lectura en US.
'use strict';

const DIA = 864e5;
const r2 = n => Math.round(n * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Marcas conocidas (por remitente o por cómo las nombras en el chat)
const MARCAS = [
  [/amazon/i, 'Amazon'], [/mercado ?libre/i, 'Mercado Libre'], [/mercado ?pago/i, 'Mercado Pago'],
  [/disney/i, 'Disney+'], [/\bhbo|hbomax|\bmax\.com|warnermedia|\bwbd\b/i, 'HBO Max'], [/netflix/i, 'Netflix'], [/spotify/i, 'Spotify'],
  [/youtube/i, 'YouTube'], [/google|gemini/i, 'Google'], [/apple|itunes|icloud/i, 'Apple'], [/anthropic|claude/i, 'Claude'],
  [/openai|chat ?gpt/i, 'ChatGPT'], [/\bipsy\b/i, 'IPSY'], [/uber/i, 'Uber'], [/\bdidi\b/i, 'DiDi'], [/rappi/i, 'Rappi'],
  [/liverpool/i, 'Liverpool'], [/walmart|\bwally\b/i, 'Walmart'], [/costco/i, 'Costco'], [/sam'?s club/i, "Sam's Club"], [/coppel/i, 'Coppel'],
  [/shein/i, 'Shein'], [/\btemu\b/i, 'Temu'], [/vercel/i, 'Vercel'], [/microsoft|xbox/i, 'Microsoft'], [/playstation/i, 'PlayStation'],
  [/paramount/i, 'Paramount+'], [/crunchyroll/i, 'Crunchyroll'], [/\bvix\b/i, 'ViX'], [/totalplay/i, 'Totalplay'], [/\bizzi\b/i, 'izzi'],
  [/telcel/i, 'Telcel'], [/at&t|att\.com/i, 'AT&T'], [/banamex|citibanamex/i, 'Banamex'], [/revolut/i, 'Revolut'], [/\bbbva\b/i, 'BBVA'],
  [/santander/i, 'Santander'], [/\bnu\b ?(mexico|méxico)|nubank/i, 'Nu'], [/starbucks/i, 'Starbucks'], [/cin[eé]polis/i, 'Cinépolis'],
  [/cinemex/i, 'Cinemex'], [/ticketmaster/i, 'Ticketmaster'], [/feverup|\bfever\b/i, 'Fever'], [/airbnb/i, 'Airbnb'], [/booking\.com/i, 'Booking'],
  [/aerom[eé]xico/i, 'Aeroméxico'], [/volaris/i, 'Volaris'], [/viva ?aerobus/i, 'Viva Aerobus'], [/linkedin/i, 'LinkedIn'],
  [/duolingo/i, 'Duolingo'], [/canva/i, 'Canva'], [/adobe/i, 'Adobe'], [/notion/i, 'Notion'], [/github/i, 'GitHub'], [/pluxee/i, 'Pluxee'],
  [/sephora/i, 'Sephora'], [/nike/i, 'Nike'], [/adidas/i, 'Adidas'], [/zara\b/i, 'Zara'], [/h&m|\bhm\.com/i, 'H&M'], [/oxxo/i, 'OXXO'],
];
function comercioDe(from) {
  const f = String(from || '');
  const nombre = ((f.match(/^\s*"?([^"<]+?)"?\s*</) || [])[1] || '').trim();
  const via = nombre.match(/a trav[eé]s de\s+(.+)$/i);   // «Pluxee México a través de LinkedIn» → Pluxee
  const quien = via ? nombre.slice(0, via.index).trim() : nombre;
  for (const [re, n] of MARCAS) if (re.test(quien) || (!via && re.test(f))) return n;
  const dom = (f.match(/@([\w.-]+)/) || [])[1] || '';
  if (quien && !/no.?reply|noreply|notific|^info$|^hola$|^hello$|news|^team$|support|soporte|servicio al cliente/i.test(quien)) return quien.slice(0, 60);
  const base = dom.split('.').filter(x => !/^(mail|email|e|em\d*|news|info|mx|com|net|org|co|www|send|mailer|notifications?|m|mkt|marketing|correo)$/i.test(x))[0];
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : (quien || dom || 'Desconocido');
}

const RE_MONTO = /(?:MXN|MX\$|US\$|USD|\$)\s?(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|(\d{1,3}(?:,\d{3})*\.\d{2})\s?(?:MXN|pesos)/i;
function montoDe(asunto, texto) {
  const clave = /(total|cargo|importe|monto|pagaste|precio|cobro|cobramos|charged|amount|you paid|pago de|se cobr|renovaci|suscripci|membres|plan )/i;
  const lineas = [asunto, ...String(texto || '').split(/\n+/).slice(0, 250)];
  for (const l of lineas) {
    if (!clave.test(l || '')) continue;
    const m = String(l).match(RE_MONTO); if (!m) continue;
    const v = parseFloat((m[1] || m[2]).replace(/[,\s]/g, ''));
    if (v > 0 && v < 1e6) return r2(v);
  }
  return null;
}

// Códigos de descuento: una palabra EN MAYÚSCULAS (con letras, 4–20) justo después de «código/cupón/code/usa…»
const NO_CODIGO = /^(HTTPS?|HTML|WWW|MXN|USD|PARA|CON|DEL|LOS|LAS|AQUI|AHORA|HOY|ESTE|ESTA|TODO|TODOS|GRATIS|ENVIO|EXTRA|CLIC|CLICK|VER|MAS|AL|EN|TU|SU|DE|EL|LA|QR|PIN|OTP|SMS|CVV|NIP|RFC|CURP|APP|WEB|COMPRA|PEDIDO|ORDEN)$/;
function codigosDe(asunto, texto) {
  const t = `${asunto || ''}\n${String(texto || '').slice(0, 8000)}`, out = new Set();
  const re = /(c[oó]digo|cup[oó]n|promo ?code|code|usa(?:ndo)?|aplica|ingresa|canjea)\s*(?:de descuento|promocional|promo)?\s*(?::|es|el)?\s*["“'«(]?\s*([A-Za-z0-9][A-Za-z0-9_-]{3,19})\b/gi;
  let m;
  while ((m = re.exec(t)) && out.size < 6) {
    const c = m[2], antes = t.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    if (c !== c.toUpperCase() || !/[A-Z]/.test(c) || NO_CODIGO.test(c)) continue;
    if (/verific|segurid|acceso|confirm|postal|rastreo|seguimiento|autoriza|referencia|cliente|socio|tarjeta/.test(antes + m[1].toLowerCase())) continue;
    if (!/\d/.test(c) && c.length < 5) continue;
    out.add(c);
  }
  return [...out];
}

const MESES = { ene: 1, enero: 1, jan: 1, january: 1, feb: 2, febrero: 2, february: 2, mar: 3, marzo: 3, march: 3, abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5, jun: 6, junio: 6, june: 6, jul: 7, julio: 7, july: 7, ago: 8, agosto: 8, aug: 8, august: 8, sep: 9, sept: 9, septiembre: 9,
  september: 9, oct: 10, octubre: 10, october: 10, nov: 11, noviembre: 11, november: 11, dic: 12, diciembre: 12, dec: 12, december: 12 };
function vigenciaDe(asunto, texto, fechaCorreo) {
  const t = norm(`${asunto || ''} ${String(texto || '').slice(0, 8000)}`), base = new Date(fechaCorreo);
  const ok = (y, mo, d) => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    let yy = y || base.getUTCFullYear(); if (yy < 100) yy += 2000;
    let f = new Date(Date.UTC(yy, mo - 1, d));
    if (!y && f < base - 2 * DIA) f = new Date(Date.UTC(yy + 1, mo - 1, d));
    return f.toISOString().slice(0, 10);
  };
  const clave = '(vigente|vigencia|valido|valida|validez|hasta el|hasta|expira|vence|termina|caduca|aplica hasta|valid until|valid through|ends|expires)';
  let m = t.match(new RegExp(clave + '[^.\\n]{0,30}?(\\d{1,2})(?: de)? (' + Object.keys(MESES).join('|') + ')\\b\\.?(?: de| del)? ?(\\d{4})?'));
  if (m) return ok(m[4] ? +m[4] : null, MESES[m[3]], +m[2]);
  m = t.match(new RegExp(clave + '[^.\\n]{0,30}?(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?'));
  if (m) return ok(m[4] ? +m[4] : null, +m[3], +m[2]);
  return null;
}

function tipoDe(asunto, texto, promo, codigos) {
  const a = norm(asunto);
  if (/(recibo|receipt|factura|invoice|tu pago|your payment|pago recibido|payment received|cargo|cobro|renovacion|renewal|se renovo|suscripcion|subscription|membresia|membership|tu plan|your plan|order confirmation)/.test(a)) return 'recibo';
  if (codigos.length) return 'codigo';
  if (promo || /(oferta|descuento|promocion|% off|rebaja|cupon|buen fin|black friday|cyber|hot sale|gratis|envio gratis|solo hoy|ultimas horas|liquidacion|outlet|sale\b)/.test(a)) return 'promo';
  return 'otro';
}

module.exports = function montarGoogle(app, deps) {
  const { sb, tokenOk, hoy, fmt, esGhost } = deps;
  const ghost = req => !!(esGhost && esGhost(req));

  // ── 1) ÍNDICE DE CORREOS ─────────────────────────────────────────────────────────────────────────────────────────────
  app.post('/api/correo/indice', async (req, res) => {
    try {
      if (ghost(req)) return res.status(403).json({ success: false, error: 'Modo fantasma: solo lectura' });
      const { phone, token, cuenta } = req.body || {};
      if (!phone || !tokenOk(phone, token)) return res.status(401).json({ success: false, error: 'Token inválido' });
      const cta = String(cuenta || '').trim().toLowerCase().slice(0, 120) || null;
      const filas = (Array.isArray(req.body.mensajes) ? req.body.mensajes : []).filter(m => m && m.id).slice(0, 60).map(m => {
        const fecha = m.date && !isNaN(new Date(m.date)) ? new Date(m.date).toISOString() : new Date().toISOString();
        const asunto = String(m.subject || '').slice(0, 300), texto = String(m.text || '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, 6000);
        const codigos = codigosDe(asunto, texto), tipo = tipoDe(asunto, texto, !!m.promo, codigos);
        return { user_phone: phone, cuenta: cta, msg_id: String(m.id).slice(0, 120), remitente: String(m.from || '').slice(0, 200),
          comercio: comercioDe(m.from), asunto, fecha, tipo, codigos,
          monto: tipo === 'recibo' ? montoDe(asunto, texto) : null,
          vigencia: tipo === 'recibo' ? null : vigenciaDe(asunto, texto, fecha), texto: texto.slice(0, 4000) };
      });
      if (filas.length) {
        const { error } = await sb.from('correo_indice').upsert(filas, { onConflict: 'user_phone,msg_id', ignoreDuplicates: true });
        if (error) return res.status(500).json({ success: false, error: error.message });
      }
      if (cta) await sb.from('correo_sync').update({ indice_at: new Date().toISOString() }).eq('user_phone', phone).eq('cuenta', cta);
      res.json({ success: true, recibidos: filas.length });
    } catch (e) { console.error('[google] indice:', e.message); res.status(500).json({ success: false, error: e.message }); }
  });

  // ── Preguntas sobre el correo (chat) ─────────────────────────────────────────────────────────────────────────────────
  const _fechaCorta = iso => { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z'); return `${d.getUTCDate()} ${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][d.getUTCMonth()]}`; };
  function marcaEn(texto) {
    for (const [re, n] of MARCAS) if (re.test(texto)) return n;
    return null;
  }
  async function comercioMencionado(phone, text) {
    const m = marcaEn(text); if (m) return m;
    const t = ` ${norm(text)} `;
    const { data } = await sb.from('correo_indice').select('comercio').eq('user_phone', phone).order('fecha', { ascending: false }).limit(3000);
    const vistos = [...new Set((data || []).map(x => x.comercio).filter(Boolean))].sort((a, b) => b.length - a.length);
    return vistos.find(c => norm(c).length >= 3 && t.includes(` ${norm(c)} `)) || null;
  }
  // ¿Cuándo y cuánto se cobra un servicio? Recibos del correo + movimientos + gastos fijos con día
  async function cobrosDe(phone, comercio) {
    const desde = new Date(Date.now() - 400 * DIA).toISOString();
    const [{ data: rec }, { data: movs }, { data: u }] = await Promise.all([
      sb.from('correo_indice').select('fecha, monto, asunto').eq('user_phone', phone).eq('comercio', comercio).eq('tipo', 'recibo').gte('fecha', desde).order('fecha', { ascending: false }).limit(60),
      sb.from('movimientos').select('fecha, monto, concepto').eq('user_phone', phone).eq('tipo', 'GASTO').is('deleted_at', null).gte('fecha', desde.slice(0, 10)).limit(5000),
      sb.from('usuarios').select('external_refs').eq('telefono', phone).maybeSingle()]);
    const re = (MARCAS.find(([, n]) => n === comercio) || [new RegExp(comercio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')])[0];
    const cargos = [];
    (rec || []).forEach(r => { if (r.monto > 0) cargos.push({ fecha: String(r.fecha).slice(0, 10), monto: Number(r.monto), fuente: 'correo' }); });
    (movs || []).filter(m => re.test(String(m.concepto || '').replace(/^\[ppto\]\s*/i, ''))).forEach(m => {
      if (!cargos.some(c => Math.abs(new Date(c.fecha) - new Date(m.fecha)) <= 3 * DIA && Math.abs(c.monto - Number(m.monto)) <= 1)) cargos.push({ fecha: m.fecha, monto: Number(m.monto), fuente: 'mov' });
    });
    cargos.sort((a, b) => b.fecha.localeCompare(a.fecha));
    const fijo = ((u?.external_refs || {}).gastos_esperados || []).find(g => re.test(g.descripcion || '') && (g.dias || []).length);
    return { cargos, fijo };
  }
  async function faqCorreo(phone, text) {
    const t = norm(text);
    if (!t || t.length > 300) return null;
    const codigos = /\b(codigos?|cupon(es)?|claves? de descuento|codigos? de descuento|codigos? promocionales?)\b/.test(t);
    const promos = !codigos && /\b(promociones?|promos?|ofertas?|descuentos?|rebajas?|buen fin|black friday)\b/.test(t);
    const dia = /\b(que dia|cuando|en que fecha|fecha)\b.*\b(pag|cobr|renuev|vence|carg)/.test(t) || /\bdia de (pago|cobro|corte|renovacion)\b/.test(t);
    // «¿cuánto pago de Google?» / «¿cuánto me cobra Disney?» (no «¿cuánto gasté en Amazon?», eso es gasto por periodo: faqFinanciero)
    const cuanto = /\bcuanto\b.*\b(pago|pagas|pagamos|me cobra|me cobran|cobra|cobran|cuesta|le pago)\b/.test(t) && !/\bgast/.test(t);
    const correo = /\b(correos?|e-?mails?|mails?|gmail|me llego|me llegaron|bandeja)\b/.test(t);
    if (!(codigos || promos || dia || cuanto || correo)) return null;
    const { count } = await sb.from('correo_indice').select('id', { count: 'exact', head: true }).eq('user_phone', phone);
    const comercio = await comercioMencionado(phone, text);
    const hoyS = hoy();

    if ((dia || cuanto) && comercio && !codigos && !promos) {
      const { cargos, fijo } = await cobrosDe(phone, comercio);
      if (!cargos.length && !fijo) return count ? `No encontré cobros de *${comercio}* en tus correos ni en tus movimientos del último año.` : null;
      const dias = cargos.map(c => +c.fecha.slice(8, 10)), moda = dias.sort((a, b) => dias.filter(x => x === b).length - dias.filter(x => x === a).length)[0];
      const diaCobro = fijo ? fijo.dias[0] : moda, ult = cargos[0];
      const anio = cargos.filter(c => c.fecha >= new Date(Date.now() - 365 * DIA).toISOString().slice(0, 10));
      const tot = anio.reduce((a, c) => a + c.monto, 0);
      const prox = (() => { const b = new Date(hoyS + 'T12:00:00Z'); let d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), diaCobro)); if (d < b) d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, diaCobro)); return d.toISOString().slice(0, 10); })();
      const fuentes = [cargos.some(c => c.fuente === 'correo') && 'tus recibos en Gmail', cargos.some(c => c.fuente === 'mov') && 'tus movimientos', fijo && 'tus gastos fijos'].filter(Boolean).join(', ');
      const lineas = [`📅 *${comercio}* se cobra alrededor del *día ${diaCobro}* de cada mes${fijo ? ` (gasto fijo de ${fmt(fijo.monto)})` : ''}.`];
      if (ult) lineas.push(`Último cargo: ${_fechaCorta(ult.fecha)} · *${fmt(ult.monto)}*.`);
      lineas.push(`Próximo: ≈ ${_fechaCorta(prox)}.`);
      if (anio.length > 1) lineas.push(`En los últimos 12 meses: *${fmt(tot)}* en ${anio.length} cargos (≈ ${fmt(tot / Math.max(1, new Set(anio.map(c => c.fecha.slice(0, 7))).size))} al mes).`);
      lineas.push(`_Fuente: ${fuentes}._`);
      return lineas.join('\n');
    }
    if (!count) return codigos || promos || correo
      ? 'Aún no leo tus promociones, códigos ni recibos de suscripciones: actualiza el código del script de Gmail a la versión 3 (US → Compras del correo) en tus cuentas y en unos minutos te contesto.'
      : null;
    if (codigos) {
      let q = sb.from('correo_indice').select('comercio, asunto, fecha, codigos, vigencia').eq('user_phone', phone).neq('codigos', '{}')
        .gte('fecha', new Date(Date.now() - 60 * DIA).toISOString()).order('fecha', { ascending: false }).limit(60);
      if (comercio) q = q.eq('comercio', comercio);
      const { data } = await q;
      const vivos = (data || []).filter(r => !r.vigencia || r.vigencia >= hoyS);
      const vistos = new Set(), lista = [];
      vivos.forEach(r => r.codigos.forEach(c => { if (!vistos.has(c) && lista.length < 12) { vistos.add(c); lista.push({ ...r, c }); } }));
      if (!lista.length) return `No encontré códigos de descuento vigentes${comercio ? ' de *' + comercio + '*' : ''} en tus correos de los últimos 60 días.`;
      return `🎟️ *Códigos de descuento vigentes${comercio ? ' · ' + comercio : ''}*\n` + lista.map(r =>
        `• *${r.c}* — ${r.comercio}: ${r.asunto.slice(0, 70)}${r.vigencia ? ` (vence ${_fechaCorta(r.vigencia)})` : ` (llegó ${_fechaCorta(r.fecha)})`}`).join('\n')
        + '\n_Revisa las condiciones en el correo antes de usarlo._';
    }
    if (promos) {
      let q = sb.from('correo_indice').select('comercio, asunto, fecha, vigencia, codigos').eq('user_phone', phone).in('tipo', ['promo', 'codigo'])
        .gte('fecha', new Date(Date.now() - (comercio ? 30 : 10) * DIA).toISOString()).order('fecha', { ascending: false }).limit(40);
      if (comercio) q = q.eq('comercio', comercio);
      const { data } = await q;
      const vivas = (data || []).filter(r => !r.vigencia || r.vigencia >= hoyS).slice(0, 10);
      if (!vivas.length) return `No encontré promociones${comercio ? ' de *' + comercio + '*' : ''} recientes en tus correos.`;
      return `🛍️ *Promociones${comercio ? ' de ' + comercio : ' recientes'}*\n` + vivas.map(r =>
        `• ${comercio ? '' : r.comercio + ': '}${r.asunto.slice(0, 80)}${r.codigos?.length ? ` · código *${r.codigos[0]}*` : ''}${r.vigencia ? ` (hasta ${_fechaCorta(r.vigencia)})` : ` (${_fechaCorta(r.fecha)})`}`).join('\n');
    }
    if (correo || dia || cuanto) {
      if (!comercio) return null;
      const { data } = await sb.from('correo_indice').select('asunto, fecha, tipo, monto').eq('user_phone', phone).eq('comercio', comercio).order('fecha', { ascending: false }).limit(8);
      if (!(data || []).length) return `No encontré correos de *${comercio}* (reviso recibos, promociones y códigos de los últimos 4 meses).`;
      return `📨 *Últimos correos de ${comercio}*\n` + data.map(r => `• ${_fechaCorta(r.fecha)} · ${r.asunto.slice(0, 80)}${r.monto ? ' · ' + fmt(r.monto) : ''}`).join('\n');
    }
    return null;
  }

  // ── 2) CALENDARIO ⇄ GOOGLE CALENDAR ──────────────────────────────────────────────────────────────────────────────────
  const _principal = new Map();   // phone → { cuenta, t }
  async function cuentaPrincipal(phone) {
    const c = _principal.get(phone); if (c && Date.now() - c.t < 600e3) return c.cuenta;
    const { data } = await sb.from('correo_sync').select('cuenta, recibidos, cal_principal').eq('user_phone', phone);
    let p = (data || []).find(x => x.cal_principal);
    if (!p && (data || []).length) {   // la que más compras ha mandado es la principal
      p = [...data].sort((a, b) => (b.recibidos || 0) - (a.recibidos || 0))[0];
      await sb.from('correo_sync').update({ cal_principal: true }).eq('user_phone', phone).eq('cuenta', p.cuenta);
    }
    const cuenta = p ? p.cuenta : null;
    if (cuenta) _principal.set(phone, { cuenta, t: Date.now() });   // sin cuentas todavía: no se guarda (la primera llega en el siguiente latido)
    return cuenta;
  }
  const _desde60 = () => new Date(Date.now() - 60 * DIA).toISOString().slice(0, 10);
  async function pendientesCal(phone, cta) {
    const esPrin = (await cuentaPrincipal(phone)) === cta;
    const [{ data }, { data: tumbas }] = await Promise.all([
      sb.from('calendario').select('id, titulo, descripcion, fecha, hora, recurrente, google_id, google_cuenta, google_sync, deleted_at')
        .eq('user_phone', phone).in('google_sync', ['pendiente', 'borrar']).limit(300),
      sb.from('calendario_borrados').select('id, google_id, serie').eq('user_phone', phone).eq('google_cuenta', cta).limit(100)]);
    const d60 = _desde60(), filas = data || [];
    const serie = r => !!r.recurrente && r.recurrente !== 'no';
    const ev = r => ({ us_id: r.id, titulo: String(r.titulo || '(sin título)').slice(0, 200), descripcion: String(r.descripcion || '').slice(0, 1000),
      fecha: String(r.fecha).slice(0, 10), hora: r.hora ? String(r.hora).slice(0, 5) : null, recurrente: serie(r) ? r.recurrente : null, serie: serie(r) });
    return {
      crear: filas.filter(r => r.google_sync === 'pendiente' && !r.deleted_at && !r.google_id && (r.google_cuenta ? r.google_cuenta === cta : esPrin) && String(r.fecha) >= d60).slice(0, 60).map(ev),
      actualizar: filas.filter(r => r.google_sync === 'pendiente' && !r.deleted_at && r.google_id && r.google_cuenta === cta).slice(0, 60).map(r => ({ ...ev(r), google_id: r.google_id })),
      borrar: [
        ...filas.filter(r => r.google_sync === 'borrar' && r.google_id && r.google_cuenta === cta).map(r => ({ us_id: r.id, google_id: r.google_id, serie: serie(r) })),
        ...(tumbas || []).map(t => ({ tumba: t.id, google_id: t.google_id, serie: !!t.serie }))].slice(0, 60),
    };
  }
  // Para el latido del script: ¿hay algo de US que copiar a Google en esta cuenta? (así se sincroniza en ≈1 minuto)
  deps.calPendiente = async (phone, cta) => {
    const p = await pendientesCal(phone, cta);
    return !!(p.crear.length || p.actualizar.length || p.borrar.length);
  };

  // Google → US: la lista completa del calendario en la ventana [desde, hasta] (solo cuando cambió)
  async function aplicarFeed(phone, cta, feed, desde, hasta) {
    const { data: filas } = await sb.from('calendario').select('id, titulo, descripcion, fecha, hora, recurrente, google_id, google_updated, google_sync, google_serie, updated_at, deleted_at, origen')
      .eq('user_phone', phone).eq('google_cuenta', cta).not('google_id', 'is', null).limit(5000);
    const esSerieUS = f => !f.google_serie && f.recurrente && f.recurrente !== 'no';
    const llave = f => f.google_serie ? `${f.google_id}|${String(f.fecha).slice(0, 10)}` : f.google_id;
    const mapa = new Map((filas || []).map(f => [llave(f), f]));
    const seriesUS = new Map((filas || []).filter(esSerieUS).map(f => [f.google_id, f]));
    const vistos = new Set(), nuevos = [];
    let cambios = 0;
    const tope = new Date(Date.now() + 90 * DIA).toISOString().slice(0, 10);   // de una serie de Google, solo los próximos 90 días
    for (const e of feed) {
      if (!e || !e.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(e.fecha || ''))) continue;
      if (e.serie && e.fecha > tope && !seriesUS.has(e.id)) continue;
      if (seriesUS.has(e.id)) { vistos.add(e.id); continue; }   // instancia de una serie que creó US: ya está en US como una sola fila
      const k = e.serie ? `${e.id}|${e.fecha}` : e.id; vistos.add(k);
      const datos = { titulo: String(e.titulo || '(sin título)').slice(0, 200), descripcion: String(e.desc || '').slice(0, 1000), fecha: e.fecha, hora: e.allDay ? null : (e.hora || null) };
      const f = mapa.get(k);
      if (!f) {
        nuevos.push({ ...datos, user_phone: phone, tipo: 'evento', recurrente: 'no', origen: 'google', google_id: e.id, google_cuenta: cta,
          google_updated: e.updated || new Date().toISOString(), google_sync: 'ok', google_serie: !!e.serie, editor: phone });
        continue;
      }
      if (f.deleted_at) continue;   // se borró en US: el «borrar» pendiente lo quita de Google
      const gNuevo = e.updated && (!f.google_updated || new Date(e.updated) > new Date(f.google_updated));
      if (!gNuevo) continue;
      if (f.google_sync === 'pendiente' && new Date(f.updated_at || 0) > new Date(e.updated)) continue;   // lo editaste en US después: gana US
      const cambio = datos.titulo !== f.titulo || datos.descripcion !== (f.descripcion || '') || datos.fecha !== String(f.fecha).slice(0, 10)
        || (datos.hora || null) !== (f.hora ? String(f.hora).slice(0, 5) : null);
      await sb.from('calendario').update({ ...(cambio ? datos : {}), google_updated: e.updated, google_sync: 'ok' }).eq('id', f.id);
      if (cambio) cambios++;
    }
    for (let i = 0; i < nuevos.length; i += 200) {
      const { error } = await sb.from('calendario').insert(nuevos.slice(i, i + 200));
      if (error) console.error('[google] cal insert:', error.message);
    }
    // Borrados en Google: lo que estaba sincronizado en la ventana y ya no viene. Con freno por si Google mandó una lista incompleta.
    const enVentana = (filas || []).filter(f => !f.deleted_at && String(f.fecha).slice(0, 10) >= desde && String(f.fecha).slice(0, 10) <= hasta);
    const faltan = enVentana.filter(f => !vistos.has(esSerieUS(f) ? f.google_id : llave(f)));
    let borrados = 0;
    if (faltan.length && !(feed.length === 0 && enVentana.length > 3) && !(faltan.length > 6 && faltan.length > enVentana.length * 0.5)) {
      const ahora = new Date().toISOString();
      for (const f of faltan) {
        await sb.from('calendario').update({ deleted_at: ahora, google_id: null, google_sync: 'ok', google_updated: ahora }).eq('id', f.id);
        borrados++;
      }
    } else if (faltan.length) console.warn(`[google] ${phone} ${cta}: ${faltan.length} eventos faltan en Google — no se borran (posible lista incompleta)`);
    return { nuevos: nuevos.length, cambios, borrados };
  }

  app.post('/api/cal/sync', async (req, res) => {
    try {
      if (ghost(req)) return res.status(403).json({ success: false, error: 'Modo fantasma: solo lectura' });
      const { phone, token, cuenta, eventos, desde, hasta } = req.body || {};
      if (!phone || !tokenOk(phone, token)) return res.status(401).json({ success: false, error: 'Token inválido' });
      const cta = String(cuenta || '').trim().toLowerCase().slice(0, 120);
      if (!cta) return res.status(400).json({ success: false, error: 'Falta la cuenta' });
      let r = null;
      if (Array.isArray(eventos) && /^\d{4}-\d{2}-\d{2}$/.test(desde || '') && /^\d{4}-\d{2}-\d{2}$/.test(hasta || ''))
        r = await aplicarFeed(phone, cta, eventos.slice(0, 3000), desde, hasta);
      const p = await pendientesCal(phone, cta);
      await sb.from('correo_sync').update({ cal_at: new Date().toISOString() }).eq('user_phone', phone).eq('cuenta', cta);
      res.json({ success: true, ...p, aplicado: r });
    } catch (e) { console.error('[google] cal sync:', e.message); res.status(500).json({ success: false, error: e.message }); }
  });

  // El script reporta lo que hizo en Google: ids nuevos, cambios aplicados y borrados
  app.post('/api/cal/hechos', async (req, res) => {
    try {
      if (ghost(req)) return res.status(403).json({ success: false, error: 'Modo fantasma: solo lectura' });
      const { phone, token, cuenta } = req.body || {};
      if (!phone || !tokenOk(phone, token)) return res.status(401).json({ success: false, error: 'Token inválido' });
      const cta = String(cuenta || '').trim().toLowerCase().slice(0, 120), ahora = new Date().toISOString();
      for (const h of (Array.isArray(req.body.hechos) ? req.body.hechos : []).slice(0, 200)) {
        const id = Number(h.us_id); if (!id) continue;
        if (h.falta) {   // ya no existe en Google: se vuelve a crear en el siguiente ciclo
          await sb.from('calendario').update({ google_id: null, google_sync: 'pendiente', google_updated: ahora }).eq('id', id).eq('user_phone', phone);
        } else if (h.google_id && !h.error) {
          await sb.from('calendario').update({ google_id: String(h.google_id).slice(0, 300), google_cuenta: cta, google_updated: h.updated || ahora, google_sync: 'ok' })
            .eq('id', id).eq('user_phone', phone);
        } else if (h.error) console.warn('[google] cal hecho con error', id, String(h.error).slice(0, 120));
      }
      for (const b of (Array.isArray(req.body.borrados) ? req.body.borrados : []).slice(0, 200)) {
        if (!b.ok) continue;
        if (b.tumba) await sb.from('calendario_borrados').delete().eq('id', Number(b.tumba)).eq('user_phone', phone);
        else if (b.us_id) await sb.from('calendario').update({ google_id: null, google_sync: 'ok', google_updated: ahora }).eq('id', Number(b.us_id)).eq('user_phone', phone);
      }
      res.json({ success: true });
    } catch (e) { console.error('[google] cal hechos:', e.message); res.status(500).json({ success: false, error: e.message }); }
  });

  // Estado para la app: cuentas conectadas, versión del script y última sincronización del calendario / índice
  app.get('/api/google/estado', async (req, res) => {
    try {
      const phone = req.query.phone;
      if (!phone) return res.status(400).json({ success: false, error: 'Falta phone' });
      const [{ data }, { count }] = await Promise.all([
        sb.from('correo_sync').select('cuenta, version, latido_at, cal_at, indice_at, cal_principal').eq('user_phone', phone),
        sb.from('correo_indice').select('id', { count: 'exact', head: true }).eq('user_phone', phone)]);
      res.json({ success: true, cuentas: data || [], indice: count || 0 });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  return { faqCorreo, cuentaPrincipal };
};
module.exports._test = { comercioDe, montoDe, codigosDe, vigenciaDe, tipoDe };
