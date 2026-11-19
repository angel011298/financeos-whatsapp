// ── COMPRAS DESDE GMAIL ──────────────────────────────────────────────────────
// Un Apps Script en el Gmail de la persona (ver public/index.html → "Conectar Gmail") busca cada 10 min los correos de
// compras, recibos, cargos y reembolsos y los manda a POST /api/correo/ingest con un token firmado (HMAC). Aquí se leen
// (lectores exactos para Amazon, Mercado Libre, apps y bancos; Gemini solo cuando el lector no cuadra el total; si
// tampoco, se propone el total del correo) y quedan "pendientes" en correo_compras. La app los muestra en un pop-up
// para que la persona registre (un movimiento por producto), corrija u omita. Nada se registra sin su confirmación.
const crypto = require('crypto');

const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// ── HTML → texto con renglones (las celdas de una fila quedan en el mismo renglón, separadas por │) ──
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', iexcl: '¡', iquest: '¿',
  bull: '•', middot: '·', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»',
  reg: '', copy: '', trade: '', hellip: '…', times: '×', deg: '°', euro: '€', dollar: '$', zwnj: '', zwj: '', shy: '' };
function decodeEnt(s) {
  return s.replace(/&#(\d+);?/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);?/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/&([aeiouAEIOU])(acute|grave|uml|circ);/g, (_, v, k) => (v + ({ acute: '́', grave: '̀', uml: '̈', circ: '̂' })[k]).normalize('NFC'))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENT ? ENT[n] : m));
}
function htmlATexto(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head|title|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|tbody|section|article|center|ul|ol)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' │ ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEnt(s).replace(/[​-‏⁠﻿͏]/g, '');
  return s.split('\n')
    .map(l => l.replace(/[ \t ]+/g, ' ').replace(/(\s*│\s*)+/g, ' │ ').replace(/^[\s│|]+|[\s│|]+$/g, '').trim())
    .filter(l => l && /[\p{L}\p{N}$]/u.test(l)).join('\n');
}

// ── Montos ──
const RE_MONTO = /(-|−|–)?\s*(?:MXN|MX\$|US\$|\$)\s?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])|(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})\s?(?:MXN|pesos)\b/gi;
function parseMonto(txt) {
  let t = String(txt || '').replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');   // 1.299,50 (formato con puntos)
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');                                  // 299,50
  else t = t.replace(/,/g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
function montosDe(linea) {
  const out = [];
  for (const m of String(linea).matchAll(RE_MONTO)) {
    const v = parseMonto(m[2] || m[3]);
    if (v != null && v > 0 && v < 1e7) out.push({ v, neg: !!m[1], idx: m.index });
  }
  return out;
}

// ── Remitentes ──
function fuenteDe(from, asunto) {
  const f = norm(from), a = norm(asunto);
  if (/amazon\./.test(f)) return 'amazon';
  if (/mercadolibre|mercadolivre/.test(f)) return 'mercadolibre';
  if (/mercadopago/.test(f)) return 'mercadopago';
  if (/uber/.test(f)) return /eats/.test(f + a) ? 'ubereats' : 'uber';
  if (/didi/.test(f)) return /food/.test(f + a) ? 'didifood' : 'didi';
  if (/rappi/.test(f)) return 'rappi';
  if (/banamex|citibanamex|citi\.com/.test(f)) return 'banamex';
  if (/revolut/.test(f)) return 'revolut';
  if (/pluxee|sodexo/.test(f)) return 'pluxee';
  return 'generico';
}
const COMERCIO = { amazon: 'Amazon', mercadolibre: 'Mercado Libre', mercadopago: 'Mercado Pago', uber: 'Uber', ubereats: 'Uber Eats',
  didi: 'DiDi', didifood: 'DiDi Food', rappi: 'Rappi', banamex: 'Banamex', revolut: 'Revolut', pluxee: 'Pluxee' };
const ES_BANCO = f => f === 'banamex' || f === 'revolut' || f === 'pluxee';
function nombreRemitente(from) {
  const m = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
  let n = (m ? m[1] : String(from || '').split('@')[1] || '').trim();
  n = n.replace(/\b(no-?reply|noreply|notificaciones|notifications|info|hola|ventas|pedidos|orders?)\b/gi, '').replace(/\.(com|mx|net|org)(\.mx)?$/i, '').trim();
  return n.slice(0, 60) || 'Comercio';
}

// ── ¿Qué tipo de correo es? ──
// Solo cuentan las compras hechas y cobradas: publicidad, recomendaciones ("te puede gustar"), avisos de envío o
// entrega, alertas de cuenta, depósitos, transferencias entre cuentas propias y retiros en cajero se descartan.
const RE_PROMO = /oferta|ofertas|promo|% de descuento|% off|\bhasta \d+ ?%|\d+ ?msi\b|meses sin intereses|cupon|newsletter|novedades|te extranamos|olvidaste|carrito|recomend|te (puede|podria|pueden) (gustar|interesar)|encontramos algo|vistazo|descubre|aprovecha|no te quedes|arrancaron|comienzan|cuenta regresiva|buen fin|hot sale|black friday|cyber|dominguito|mesa de regalos|gratis|prueba (gratis|gratuita)|suscri|califica|valoraras|opina|resena|encuesta|colabora|inicio de sesion|contrasena|verifica|codigo|seguridad|restablec|estado de cuenta|alta de cuenta|activacion|activada|bienvenid|limite de|beneficiario|cambia tus datos|netkey|acceso|tu paquete|en camino|enviado|en proceso de entrega|en reparto|rastrea|ha sido enviado|fue enviado|enviamos tu|se envio|entregado|entregamos|llego|llegara|llega hoy|recoger|pregunta|webinar|evento|invitacion|you're expected/;
const RE_SENAL = /pedido|compra|compraste|order|recibo|receipt|factura|pago|pagaste|cargo|confirmacion|gracias por|tu viaje|viaje con|tu orden|ticket|comprobante|transaccion|consumo/;
const RE_CANCELA = /se cancel(o|aron)|cancelamos|(pedido|compra|orden) cancelad|cancelacion de (tu |la )?(pedido|compra|orden)/;
const RE_REEMBOLSO = /reembolso|reintegro|refund|te devolvimos|devolvimos tu dinero|devolucion (de tu dinero|aprobada|procesada)/;
const ES_APP = f => /^(rappi|ubereats|didifood|uber|didi)$/.test(f);
function remitenteLocal(from) { const m = String(from || '').match(/<?([^<>\s"]+)@/); return norm(m ? m[1] : ''); }
function clasificar(asunto, lineas, fuente, remitente) {
  const a = norm(asunto), ini = norm(lineas.slice(0, 14).join(' ')).slice(0, 1200), loc = remitenteLocal(remitente);
  if (RE_REEMBOLSO.test(a) || (!ES_BANCO(fuente) && RE_REEMBOLSO.test(ini) && !RE_PROMO.test(a))) return 'reembolso';
  if (RE_CANCELA.test(a) || (!ES_BANCO(fuente) && RE_CANCELA.test(ini) && /pedido|compra|orden/.test(ini))) return 'cancelacion';

  if (fuente === 'amazon') {
    // Amazon: solo la confirmación del pedido ("Pedido: …", "Gracias por tu compra"). Envíos, entregas,
    // recomendaciones, promociones (noreply/store-news) y mensajes de cuenta NO son compras.
    // El aviso "Enviado: …" trae lo cobrado en ese envío: se guarda en reserva por si la confirmación no cubre ese pedido.
    if (/^enviado\b/.test(a) && (loc === 'shipment-tracking' || /tu paquete fue enviado/.test(ini))) return 'envio';
    if (/^(noreply|no-reply|store-news|marketing|marketplace-messages|account-update|shipment-tracking|order-update)$/.test(loc)) return 'ignorar';
    if (/^pedido:|^tu pedido de amazon|confirmacion de (tu )?pedido|gracias por tu (compra|pedido)/.test(a) || loc === 'auto-confirm' || /gracias por tu compra/.test(ini) && !RE_PROMO.test(a)) return 'compra';
    return 'ignorar';
  }
  if (ES_BANCO(fuente)) {
    const t = a + ' ' + ini;
    if (/deposito|abono|recibiste|te enviaron|transferencia recibida|nomina|te depositaron/.test(t)) return 'ignorar';
    if (/dis\.?\s?efe|disposicion de efectivo|retiro (en|de) cajero|cajero automatico|\batm\b/.test(t)) return 'ignorar';
    if (/estatus (rechazad|declinad|fallid|no exitos|cancelad)|operacion (rechazada|declinada|no exitosa)/.test(t)) return 'ignorar';
    if (/estado de cuenta|alta de cuenta|activacion|acceso|beneficiario|cambia tus datos|netkey|seguridad|codigo|contrasena|bienvenid/.test(a)) return 'ignorar';
    // Traspasos entre cuentas propias (Banamex ⇄ Revolut, ahorro…)
    if (/traspaso|cuentas? propias?|entre (mis|tus|sus) cuentas|misma cuenta|a tu cuenta revolut|a revolut|desde revolut|de revolut|revolut bank|recarga (de|a) (tu )?cuenta|ahorro propio/.test(norm(lineas.join(' ')))) return 'ignorar';
    // "Enviaste $X a <tu mismo nombre>" = transferencia a ti mismo
    const hola = (lineas.join('\n').match(/hola,?\s+([\p{L}]+)/iu) || [])[1], dest = (lineas.join('\n').match(/enviaste\s+\S+\s+a\s+([\p{L}]+)/iu) || [])[1];
    if (hola && dest && norm(hola) === norm(dest)) return 'ignorar';
    if (/retiro\/compra|compra|cargo|pagaste|enviaste|pago (en|a|de)|consumo|transaccion/.test(t)) return 'compra';
    return 'ignorar';
  }
  if (/rechazad|declinad|no se pudo (procesar|completar)|pago fallido|intenta de nuevo/.test(a)) return 'ignorar';
  // Apps de comida y viajes: su recibo llega como "Tu pedido de X fue entregado" o "Tu viaje …"
  if (ES_APP(fuente) && /(total pagado|total|cargo neto|pagaste|cobramos)/.test(ini) && /pedido|orden|viaje|recibo|entregado|gracias/.test(a + ' ' + ini) && !/oferta|promo|cupon|descuento de|% /.test(a)) return 'compra';
  if (RE_PROMO.test(a) && !/(confirmacion|recibo|factura|comprobante) de (tu )?(pedido|compra|pago)|gracias por tu (compra|pedido)|compraste/.test(a)) return 'ignorar';
  if (/^(noreply|no-reply|store-news|marketing|promo(s|ciones)?|newsletter|news|ofertas)$/.test(loc) && !/compraste|tu compra|recibo|comprobante|pagaste/.test(a)) return 'ignorar';
  if (RE_SENAL.test(a)) return 'compra';
  if (fuente !== 'generico' && RE_SENAL.test(ini)) return 'compra';
  return 'ignorar';
}
const pedidosDe = texto => [...new Set(String(texto).match(/\b\d{3}-\d{7}-\d{7}\b/g) || [])];

// ── Pedido, medio de pago ──
function pedidoDe(texto, fuente) {
  if (fuente === 'amazon') { const m = texto.match(/\b(\d{3}-\d{7}-\d{7})\b/); if (m) return m[1]; }
  const m = texto.match(/(?:compra|pedido|venta|orden|order|operaci[oó]n|folio|recibo|referencia|transacci[oó]n)\s*(?:n[uú]m(?:ero)?\.?|no\.?|#|id)?\s*:?\s*#?\s*([A-Z0-9][A-Z0-9-]{5,24})\b/i);
  return m && /\d{4}/.test(m[1]) ? m[1] : null;
}
function medioHintDe(texto, fuente) {
  if (ES_BANCO(fuente)) { const t4 = (texto.match(/(?:terminaci[oó]n|termina(?:da)? en|con terminaci[oó]n|\*{2,}|•{2,}|x{3,})\s*(\d{4})\b/i) || [])[1]; return fuente + (t4 ? ' ' + t4 : ''); }
  const t = norm(texto);
  const tarj = texto.match(/(visa|master\s?card|amex|american express|carnet)[^\n]{0,40}?(?:terminaci[oó]n|termina(?:da)? en|\*+|•+|x{2,}|-)\s*(\d{4})\b/i)
    || texto.match(/(tarjeta|d[eé]bito|cr[eé]dito)[^\n]{0,30}?(?:terminaci[oó]n|termina(?:da)? en|\*+|•+)\s*(\d{4})\b/i);
  if (tarj) return norm(tarj[1]).replace(/\s+/g, '').replace('americanexpress', 'amex') + ' ' + tarj[2];
  // Rappi: después de "Cargo neto $X" viene un renglón solo con la terminación de la tarjeta ("0513")
  const rap = texto.match(/cargo neto\s*\n\s*\$?[\d,.]+\s*\n\s*(\d{4})\s*\n/i);
  if (rap) return 'tarjeta ' + rap[1];
  if (/dinero (disponible )?en (tu )?(cuenta de )?mercado pago|saldo (en|de) mercado pago|con mercado pago/.test(t)) return 'mercado pago';
  if (/paypal/.test(t)) return 'paypal';
  if (/\boxxo\b|pago en efectivo/.test(t)) return 'efectivo';
  if (/meses sin intereses|\bmsi\b/.test(t)) return 'credito';
  return null;
}
const MEDIO_DE_HINT = h => {
  const t = norm(h);
  if (/banamex/.test(t)) return 'Débito Banamex';
  if (/revolut/.test(t)) return 'Débito Revolut';
  if (/pluxee|vales/.test(t)) return 'Pluxee';
  if (/^efectivo/.test(t)) return 'efectivo';
  if (/mercado pago|paypal|credito/.test(t)) return 'Otros';
  return null;
};

// ── Categoría sugerida (las de US) ──
const CAT_REGLAS = [
  ['Alicia', /\balicia\b/],
  ['Transporte', /\b(uber(?! ?eats)|didi(?! ?food)|cabify|taxi|gasolina|pemex|metro|metrobus|estacionamiento|caseta|peaje|boleto de autobus|ado)\b/],
  ['Comida', /\b(uber ?eats|didi ?food|rappi|restaurante|starbucks|tim ?hort\w*|cafe|pizza|burger|hamburguesa|tacos?|sushi|comida|food|kfc|mcdonald|domino|little caesars|subway|bebida|snack|galletas|chocolate|dulces)\b/],
  ['Despensa', /\b(wal ?mart|oxxo|7 ?eleven|soriana|chedraui|superama|la comer|costco|sams|bodega aurrera|despensa|supermercado|abarrotes|leche|huevo|frutas?|verduras?|cereal|arroz|frijol|aceite|atun|papel higienico|servilletas)\b/],
  ['Hogar', /\b(hogar|casa|cocina|limpieza|detergente|jabon (para|de) (ropa|trastes)|cloro|mueble|lampara|foco|sarten|olla|colchon|almohada|toalla|sabana|cortina|organizador|home depot|ikea|ikano|herramienta|taladro|extension|multicontacto|filtro|escoba|trapeador|cubeta|mascota|croquetas|arena para gato)\b/],
  ['Ocio', /\b(netflix|spotify|disney|hbo|max|prime video|youtube|cine|cinepolis|cinemex|juego|videojuego|playstation|ps5|xbox|nintendo|switch|steam|libro|kindle|concierto|ticketmaster|boletos?|lego|juguete|figura|funko|apple music|crunchyroll)\b/],
  ['Personales', /\b(ropa|hm mx\w*|h ?& ?m|zara|pull ?& ?bear|bershka|c ?& ?a|liverpool|suburbia|sanborns|farmacias?|benavides|guadalajara|playera|camisa|pantalon|jeans|sudadera|chamarra|tenis|zapatos|calcetines|boxer|shampoo|acondicionador|crema|perfume|desodorante|cepillo|rastrillo|farmacia|medicamento|vitaminas?|suplemento|proteina|maquillaje|audifonos|funda|cargador|cable usb|mochila|reloj|lentes|corte de cabello|barberia|gimnasio|gym)\b/],
];
function catSugerida(nombre, comercio, fuente) {
  const t = norm(`${nombre || ''} ${comercio || ''}`);
  for (const [c, re] of CAT_REGLAS) if (re.test(t)) return c;
  if (fuente === 'uber' || fuente === 'didi') return 'Transporte';
  if (fuente === 'ubereats' || fuente === 'didifood' || fuente === 'rappi') return 'Comida';
  return 'OTROS';
}

// ── Lector exacto por renglones ──
const RE_CORTE = /(te (podria|puede|pueden) (interesar|gustar)|ofertas (inspiradas|para ti|del dia)|comprar nuevamente|productos sustituidos|ya estas antojado|recomendad|tambien te (puede|podria)|productos relacionados|inspirado en|basado en tu|clientes que (compraron|vieron)|sigue comprando|seguir comprando|descarga la app|siguenos|redes sociales|aviso de privacidad|terminos y condiciones|preguntas frecuentes|centro de ayuda|este correo (fue|se) (enviado|genero)|no respondas)/;
const RE_TOTAL_FUERTE = /\b(total (del|de tu|de la) (pedido|compra|orden|cargo)|total pagado|total a pagar|total cobrado|importe total|monto total|grand total|order total|total \(iva incluido\)|total con iva|pagaste|cargo neto|monto del cargo|importe del cargo|cobramos)\b/;
const RE_TOTAL = /\b(total|importe|monto|cargo por|compra por|pago por|pago de|por un (monto|importe) de)\b/;
const RE_SUB = /\b(sub ?total|suma parcial|total (de|del) (los )?(productos?|articulos?)|^productos?|^articulos?|valor de los productos)\b/;
const RE_ENVIO = /\b(envio|envios|shipping|costo de entrega|cargo de entrega|tarifa de entrega|delivery)\b/;
const RE_DESC = /\b(descuento|descuentos|ahorro|ahorraste|ahorras|promocion|cupon|bonificacion|rebaja|discount|cashback aplicado)\b/;
const RE_IMP = /\b(iva|impuesto|impuestos|ieps|tax|retencion)\b/;
const RE_PROPINA = /\b(propina|tip)\b/;
const RE_TARIFA = /\b(tarifa de servicio|cargo por servicio|costo de servicio|comision|service fee|cuota de servicio|tarifa de plataforma)\b/;
const RE_RUIDO = /\b(meses|msi|mensualidad|mensualidades|cuotas?|saldo|disponible|limite|puntos|cashback|precio unitario|antes|ahorra hasta|desde \$|envio gratis en|compra minima|credito|pago minimo|precio regular|precio de lista|p\.u\.|valor|cotizacion|tipo de cambio)\b/;
const limpiaNombre = s => String(s || '').replace(/│/g, ' ').replace(/\b(cantidad|cant\.?|qty|unidades?)\s*:?\s*\d{1,3}\b/gi, ' ')
  .replace(/\b(vendido|enviado) por\b.*$/i, '').replace(/\bcondici[oó]n:?\s*\w+/i, '').replace(/\bprecio:?\s*$/i, '')
  .replace(/[:•·\-–|]+\s*$/, '').replace(/^\s*[:•·\-–|]+/, '').replace(/\s+/g, ' ').trim().slice(0, 140);
function cantidadDe(s) {
  const m = String(s).match(/\b(?:cantidad|cant\.?|qty|unidades?)\s*:?\s*(\d{1,3})\b/i) || String(s).match(/^\s*(\d{1,2})\s*[x×]\s+\S/) || String(s).match(/\s[x×]\s?(\d{1,2})\s*$/);
  const n = m ? parseInt(m[1], 10) : 1;
  return n > 0 && n < 100 ? n : 1;
}

function lectorExacto(lineas) {
  const items = [], totales = [], subs = [];
  let envio = 0, descuento = 0, etiquetas = [];
  for (let i = 0; i < lineas.length; i++) {
    const L = lineas[i], nL = norm(L);
    if (RE_CORTE.test(nL) && (items.length || totales.length)) break;
    const ms = montosDe(L);
    if (!ms.length) {
      if (/\p{L}{3}/u.test(L) && L.length < 220) { etiquetas.push(L); if (etiquetas.length > 3) etiquetas.shift(); }
      continue;
    }
    const m = ms[ms.length - 1];
    let label = L.replace(RE_MONTO, ' ').replace(/[│|]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Renglón con solo "Cantidad: 1  $599.00" o solo el precio: el nombre del producto está en un renglón de arriba
    // (Amazon: "Nombre…" / "Cantidad: 1" / "$ 260.00")
    if (!/\p{L}{3}/u.test(limpiaNombre(label))) {
      let k = etiquetas.length - 1;
      while (k >= 0 && !/\p{L}{3}/u.test(limpiaNombre(etiquetas[k]))) k--;
      label = k >= 0 ? etiquetas.slice(k).join(' ') + (/\p{L}{3}/u.test(label) ? ' ' + label : '') : label;
    }
    const n = norm(label);
    etiquetas = [];
    if (RE_TOTAL_FUERTE.test(n)) { totales.push({ v: m.v, fuerte: true, i }); continue; }
    if (RE_SUB.test(n)) { subs.push(m.v); continue; }
    if (RE_ENVIO.test(n)) { if (!/gratis/.test(n)) envio = r2(envio + m.v); continue; }
    if (RE_DESC.test(n) || m.neg) { descuento = r2(descuento + m.v); continue; }
    if (RE_IMP.test(n)) continue;
    if (RE_TOTAL.test(n) && !/\p{L}{4,}.*\p{L}{4,}.*\p{L}{4,}/u.test(n.replace(RE_TOTAL, ''))) { totales.push({ v: m.v, fuerte: false, i }); continue; }
    if (RE_RUIDO.test(n)) continue;
    if (RE_PROPINA.test(n)) { items.push({ nombre: 'Propina', cantidad: 1, precio: m.v, i, extra: true }); continue; }
    if (RE_TARIFA.test(n)) { items.push({ nombre: 'Tarifa de servicio', cantidad: 1, precio: m.v, i, extra: true }); continue; }
    const nombre = limpiaNombre(label);
    if (nombre.length < 3 || /^(ver|comprar|rastrear|detalles|precio|importe)\b/i.test(nombre)) continue;
    if (/\b\d{1,2}:\d{2}\b|^\d{1,2} de \p{L}+\.? de \d{4}|^-?\d+ ?%$/u.test(nombre)) continue;   // fechas/horas o "-10%" no son productos
    items.push({ nombre, cantidad: cantidadDe(L + ' ' + label), precio: m.v, i });
  }
  const fuertes = totales.filter(t => t.fuerte);
  const total = fuertes.length ? Math.max(...fuertes.map(t => t.v)) : (totales.length ? Math.max(...totales.map(t => t.v)) : null);
  return { items, total, subtotal: subs.length ? Math.max(...subs) : null, envio, descuento, iTotal: (fuertes[0] || totales[0] || {}).i };
}
const cuadra = (items, envio, descuento, total) => total != null && items.length > 0 && Math.abs(r2(items.reduce((a, x) => a + x.precio, 0) + envio - descuento) - total) <= 1.01;
function elegirItems(lx) {
  const { items, envio, descuento, total, subtotal, iTotal } = lx;
  const sinDup = arr => arr.filter((x, k) => arr.findIndex(y => y.nombre === x.nombre && y.precio === x.precio) === k);
  const antes = iTotal != null ? items.filter(x => x.i < iTotal) : items;
  const opciones = [items, sinDup(items), antes, sinDup(antes), items.filter(x => !x.extra)];
  for (const op of opciones) if (cuadra(op, envio, descuento, total)) return { items: op, exacto: true };
  if (subtotal != null) for (const op of opciones) if (op.length && Math.abs(r2(op.reduce((a, x) => a + x.precio, 0)) - subtotal) <= 1.01) return { items: op, exacto: total == null || Math.abs(r2(subtotal + envio - descuento) - total) <= 1.01 };
  return { items: sinDup(antes.length ? antes : items), exacto: false };
}

// Avisos de banco: un solo cargo (o abono). "Compra por $1,234.50 en WALMART…", "Pagaste $X a Y".
function lectorBanco(lineas, fuente) {
  const txt = lineas.join('\n');
  let total = null, comercio = null;
  for (const L of lineas) {
    const ms = montosDe(L); if (!ms.length) continue;
    const n = norm(L);
    if (/saldo|disponible|limite/.test(n) && !/(cargo|compra|pago|pagaste|abono|deposito|recibiste)/.test(n)) continue;
    total = ms[0].v;
    const c = L.match(/(?:\ben\b|\ba\b|comercio:?|establecimiento:?|beneficiario:?|de parte de|de)\s+([A-Z0-9][A-Za-z0-9 .*&'\-]{2,40}?)(?:\s+(?:el|con|por|desde|a las|,|\.)|$)/);
    if (c) comercio = c[1].trim();
    break;
  }
  if (!comercio) { const c = txt.match(/(?:comercio|establecimiento|negocio|beneficiario|concepto)\s*:?\s*([^\n│]{3,40})/i); if (c) comercio = c[1].trim(); }
  return { total, comercio };
}

// ── Gemini (solo si el lector exacto no cuadra) ──
let _gemPausa = 0;
async function geminiCompra(deps, { asunto, remitente, texto, phone }) {
  const { genAI, geminiWithRetry, logUsage } = deps;
  if (!genAI || !process.env.GEMINI_API_KEY || Date.now() < _gemPausa) return null;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
    const prompt = `Eres un lector de recibos. Del correo de abajo extrae la compra en JSON, sin texto extra:
{"es_compra":true|false,"tipo":"compra"|"reembolso"|"ingreso","comercio":"","pedido":null,"items":[{"nombre":"","cantidad":1,"precio":0}],"envio":0,"descuento":0,"total":0,"medio":null}
Reglas: "precio" es el importe total de ese renglón en pesos (cantidad × unitario). Ignora productos recomendados, publicidad y montos de saldo, puntos o meses sin intereses. "descuento" es positivo. "medio" es la forma de pago tal como aparece (p. ej. "Visa 1234", "Mercado Pago") o null. Si es una promoción, un aviso de envío o no hay un pago real, es_compra=false.
Remitente: ${remitente}
Asunto: ${asunto}
Correo:
${String(texto).slice(0, 12000)}`;
    const r = await Promise.race([geminiWithRetry(() => model.generateContent(prompt), 1), new Promise(res => setTimeout(() => res(null), 25000))]);
    if (!r) return null;
    try { logUsage && logUsage(phone, 'gemini-2.5-flash', r.response.usageMetadata, 'correo'); } catch {}
    const j = JSON.parse(String(r.response.text()).replace(/^```(?:json)?|```$/g, '').trim());
    return j && typeof j === 'object' ? j : null;
  } catch (e) {
    if (/429|quota|exhausted/i.test(e.message || '')) _gemPausa = Date.now() + 60 * 60 * 1000;
    console.error('[correo] gemini:', e.message);
    return null;
  }
}

// Texto del correo: el HTML convertido; si el script tuvo que recortar el HTML (pedidos enormes), el texto plano
// completo es más confiable.
function textoDe(m) {
  const h = m.html ? htmlATexto(m.html) : '', t = String(m.text || '').trim();
  const recortado = m.html && (m.html_recortado || String(m.html).length >= 149990);
  return (recortado && t ? t : h) || t;
}

// Amazon pinta los centavos aparte ("$ 350 07" = $350.07)
const centavos = L => L.replace(/((?:MXN|MX\$|\$)\s?\d{1,3}(?:,\d{3})*) (\d{2})\s*$/, '$1.$2');

// Cuando el correo solo da el total (Amazon, Rappi…), la diferencia contra la suma de productos es envío/tarifas
// (si falta) o descuento (si sobra). Solo si la diferencia es razonable.
function ajustar(lx) {
  const suma = r2(lx.items.reduce((a, x) => a + x.precio, 0)), t = lx.total;
  if (!t || !lx.items.length || lx.envio || lx.descuento) return null;
  const d = r2(t - suma);
  if (Math.abs(d) <= 1.01) return { items: lx.items, envio: 0, descuento: 0, total: t };
  if (d > 0 && d <= suma * 0.6) return { items: lx.items, envio: d, descuento: 0, total: t };
  if (d < 0 && -d <= suma * 0.6) return { items: lx.items, envio: 0, descuento: -d, total: t };
  return null;
}

// Confirmación de Amazon: puede traer varios pedidos ("Pedido n.º …" en cada uno) con su propio "Total".
function lectorAmazon(lineas) {
  const grupos = []; let cur = null;
  for (const L of lineas) {
    const p = (L.match(/\b(\d{3}-\d{7}-\d{7})\b/) || [])[1];
    if (p) { if (!cur || cur.pedido !== p) { cur = grupos.find(g => g.pedido === p) || null; if (!cur) { cur = { pedido: p, lineas: [] }; grupos.push(cur); } } continue; }
    if (cur && !cur.cerrado) cur.lineas.push(L);
    if (cur && /^total\b/i.test(norm(L).replace(/[│|]/g, ' ').trim()) && montosDe(L).length) cur.cerrado = true;
  }
  if (!grupos.length) return null;
  // Si el correo llegó recortado, los pedidos sin "Total" quedan incompletos: se dejan fuera y los cubren sus
  // avisos de "Enviado" (cada uno trae lo que se cobró). Solo si ningún pedido está completo se usa lo que haya.
  const completos = grupos.filter(g => g.cerrado);
  const usar = completos.length ? completos : grupos;
  let items = [], envio = 0, descuento = 0, total = 0, exacto = true;
  for (const g of usar) {
    const lx = lectorExacto(g.lineas);
    if (!lx.items.length) continue;
    // Amazon muestra el precio unitario junto a "Cantidad: N"
    lx.items = lx.items.map(x => ({ ...x, precio: r2(x.precio * (x.cantidad || 1)) }));
    const a = cuadra(lx.items, lx.envio, lx.descuento, lx.total) ? { items: lx.items, envio: lx.envio, descuento: lx.descuento, total: lx.total } : ajustar(lx);
    let usa = a;
    if (!a) {
      exacto = false;
      const suma = r2(lx.items.reduce((s, x) => s + x.precio, 0)), d = lx.total ? r2(lx.total - suma) : 0;
      // El "Total" del correo es lo cobrado: si faltan productos en la lista se agrega la diferencia como renglón
      usa = d > 0 ? { items: [...lx.items, { nombre: 'Otros productos del pedido', cantidad: 1, precio: d }], envio: 0, descuento: 0, total: lx.total }
        : d < 0 ? { items: lx.items, envio: 0, descuento: -d, total: lx.total }
        : { items: lx.items, envio: 0, descuento: 0, total: suma };
    }
    const nota = usar.length > 1 ? `Pedido ${g.pedido}` : null;
    items.push(...usa.items.map(x => (nota ? { ...x, nota } : x)));
    envio = r2(envio + usa.envio); descuento = r2(descuento + usa.descuento); total = r2(total + usa.total);
  }
  if (!items.length) return null;
  return { items, envio, descuento, total, exacto, pedidos: (completos.length ? completos : []).map(g => g.pedido) };
}

// ── Tickets en foto (chat) ──
// Gemini lee el ticket renglón por renglón; las rebajas/promociones se aplican al producto de arriba y la suma de
// los importes finales DEBE dar el total pagado. Si no cuadra se vuelve a pedir con la diferencia; si aun así no
// cuadra, se agrega un renglón de diferencia marcado para revisar (nunca se registra algo que no sume el total).
const CATS_US = ['Despensa', 'Comida', 'Hogar', 'Personales', 'Ocio', 'Transporte', 'Alicia', 'OTROS'];
const PROMPT_TICKET = `Eres un lector experto de tickets de compra mexicanos (Walmart, Soriana, Oxxo, Costco, Chedraui, farmacias, restaurantes…).
Lee la foto y devuelve SOLO este JSON:
{"es_ticket":true|false,"comercio":"","sucursal":"","fecha":"YYYY-MM-DD","hora":"HH:MM",
 "items":[{"texto_ticket":"","nombre":"","cantidad":1,"precio_unitario":0,"importe":0,"descuento":0,"importe_final":0,"categoria":""}],
 "subtotal":0,"impuestos":0,"total":0,"ahorro":0,"forma_pago":"efectivo|tarjeta|vales|otro","tarjeta_tipo":"","tarjeta_terminacion":""}
Reglas:
- Un renglón por producto. "importe" = cantidad × precio unitario (p. ej. "56.00 x 8" → 448.00).
- Las líneas de rebaja, promoción, "COMBINA", "2x$…", "Rebaja", "DESC", cupón o ahorro con monto negativo NO son productos:
  su monto va en "descuento" (positivo) del producto que está JUSTO ARRIBA, e "importe_final" = importe − descuento.
  Si el ticket ya muestra el total neto del renglón (p. ej. 199.00 y abajo "Rebaja… 163.00"), usa ese neto.
- En México los precios del ticket YA incluyen IVA/IEPS: el desglose de impuestos no se suma a los productos.
  Solo si el ticket deja claro que los precios son sin IVA (suma de productos + impuestos = total), reparte el impuesto en "importe_final".
- La suma de todos los "importe_final" debe ser EXACTAMENTE el TOTAL pagado del ticket. Revísalo antes de responder.
- "texto_ticket" = la descripción tal cual viene (con código si lo trae). "nombre" = nombre claro en español, expandiendo
  abreviaturas cuando se entienda ("SC DESL 1." → "Leche Santa Clara deslactosada 1 L", "ELVIVE SH" → "Shampoo Elvive",
  "AC GRANA 4" → "Acondicionador Grana 4"); si no se entiende, deja el texto del ticket en minúsculas capitalizadas.
- "categoria" de: ${CATS_US.join(', ')} (Despensa = súper/abarrotes/lácteos/limpieza de cocina; Hogar = limpieza de casa, detergentes,
  artículos para la casa; Personales = higiene, cuidado personal, ropa, farmacia, cosméticos; Ocio = juguetes, juegos, entretenimiento;
  Comida = comida preparada, restaurante, botanas y dulces para consumo inmediato).
- "fecha" del ticket (formato DD/MM/AA en México). "tarjeta_terminacion" = últimos dígitos visibles (p. ej. "**98" → "98").
- Si la foto no es un ticket o recibo de compra, es_ticket=false.`;

async function geminiTicket(deps, phone, b64, mime, extra, hasta, orden) {
  const { genAI, logUsage } = deps;
  const partes = [{ inlineData: { mimeType: mime || 'image/jpeg', data: b64 } }, PROMPT_TICKET + (extra ? '\n\n' + extra : '')];
  // Gemini a veces responde 503 "alta demanda": se reintenta con pausa y, si sigue, con otro modelo de visión
  // gemini-flash-latest = el Flash vigente (Google lo actualiza solo); 2.5-flash y flash-lite como respaldo
  const intentos = orden || [['gemini-2.5-flash', 0], ['gemini-3-flash-preview', 0], ['gemini-flash-latest', 0], ['gemini-flash-lite-latest', 0], ['gemini-3.1-flash-lite', 0], ['gemini-2.5-flash', 2000]];
  const limite = hasta || Date.now() + 100000;
  let ultimo;
  for (const [nombre, pausa] of intentos) {
    if (pausa) await new Promise(s => setTimeout(s, pausa));
    if (Date.now() > limite) break;
    try {
      // Razonamiento acotado: sin él se equivoca en fechas y rebajas; sin tope tarda más de un minuto
      const gc = { responseMimeType: 'application/json', temperature: 0, ...(/2\.5-flash$/.test(nombre) ? { thinkingConfig: { thinkingBudget: 4096 } } : {}) };
      const model = genAI.getGenerativeModel({ model: nombre, generationConfig: gc });
      const r = await Promise.race([model.generateContent(partes), new Promise((_, rej) => setTimeout(() => rej(new Error('La lectura tardó demasiado')), Math.max(5000, Math.min(45000, limite - Date.now()))))]);
      try { logUsage && logUsage(phone, nombre, r.response.usageMetadata, 'ticket'); } catch {}
      return JSON.parse(String(r.response.text()).replace(/^```(?:json)?|```$/g, '').trim());
    } catch (e) {
      ultimo = e;
      if (!/503|500|404|not found|no longer available|overload|high demand|unavailable|429|quota|exhausted|fetch failed|ECONNRESET|tard/i.test(e.message || '')) throw e;
      console.error(`[ticket] ${nombre}: ${String(e.message).slice(0, 90)}`);
    }
  }
  throw new Error(/429|quota|exhausted/i.test(ultimo?.message || '') ? 'Se agotó el cupo de lectura de fotos por hoy' : 'El lector de fotos está saturado, intenta en un minuto');
}

function normTicket(j) {
  const items = (Array.isArray(j.items) ? j.items : []).map(x => {
    const cant = Math.max(1, Number(x.cantidad) || 1), imp = r2(Number(x.importe) || (Number(x.precio_unitario) || 0) * cant);
    const desc = r2(Math.abs(Number(x.descuento) || 0));
    // La cuenta la hace US, no la IA: importe − promoción (la IA solo transcribe cantidades, precios y rebajas)
    let fin = imp > 0 ? r2(imp - desc) : r2(Number(x.importe_final));
    if (!(fin > 0)) fin = r2(Number(x.importe_final));
    // Sin el código de barras ni el "40.00 x 2" que a veces se cuela: solo la descripción del ticket
    const texto = String(x.texto_ticket || '').replace(/^\s*\d{6,14}\s*/, '').replace(/\s+-?\d+[.,]\d{2}\s*[x×]\s*\d+.*$/i, '').replace(/\s+(rebaja|combina)\b.*$/i, '').trim().slice(0, 60);
    return { texto, nombre: limpiaNombre(x.nombre || x.texto_ticket || ''), cantidad: cant,
      unit: r2(Number(x.precio_unitario) || imp / cant), importe: imp, descuento: desc, precio: fin,
      categoria: CATS_US.includes(x.categoria) ? x.categoria : null };
  }).filter(x => x.nombre && x.precio > 0);
  return { ...j, items, total: r2(Number(j.total) || 0), suma: r2(items.reduce((a, x) => a + x.precio, 0)) };
}

async function leerTicket(deps, phone, b64, mime) {
  const fin = Date.now() + 150000;   // todo (1a lectura + corrección) en menos de 2.5 min
  let t = normTicket(await geminiTicket(deps, phone, b64, mime, null, fin - 70000));
  if (t.es_ticket === false || !t.items.length) return { es_ticket: false };
  if (t.total && Math.abs(t.suma - t.total) > 0.05 && fin - Date.now() > 25000) {
    // Segunda vuelta con la diferencia: casi siempre es una rebaja mal asignada o una cantidad mal leída
    try {
      const t2 = normTicket(await geminiTicket(deps, phone, b64, mime,
        `ATENCIÓN: en una primera lectura la suma de los productos dio ${t.suma.toFixed(2)} y el TOTAL del ticket es ${t.total.toFixed(2)} ` +
        `(diferencia ${(t.total - t.suma).toFixed(2)}). Vuelve a leer con cuidado cada precio (dígito por dígito), cantidades, ` +
        `rebajas/COMBINA y productos omitidos o repetidos. Lectura anterior: ` +
        JSON.stringify(t.items.map(x => [x.texto, x.cantidad, x.importe, x.descuento])) +
        (t.impuestos ? ` Pista: si el ticket marca productos con IVA (letra "A" o similar), el IVA impreso permite ubicar en qué grupo está el error.` : ''),
        // La corrección la hace un modelo más fino (lee mejor dígitos borrosos: 8 vs 6, 3 vs 8)
        fin, [['gemini-3-flash-preview', 0], ['gemini-flash-latest', 0], ['gemini-2.5-flash', 0]]));
      if (t2.items.length && Math.abs(t2.suma - t2.total) < Math.abs(t.suma - t.total)) t = t2;
    } catch (e) { console.error('[ticket] 2a lectura:', e.message); }
  }
  if (!t.total) t.total = t.suma;
  t.cuadra = Math.abs(t.suma - t.total) <= 0.05;
  return t;
}

const fechaMX = iso => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(iso)); } catch { return null; } };

// Lee un correo → fila para correo_compras (estado 'ignorado' si no es una compra)
async function leerCorreo(deps, phone, msg) {
  const asunto = String(msg.subject || '').slice(0, 300), remitente = String(msg.from || '').slice(0, 200);
  const texto = textoDe(msg);
  const lineas = texto.split('\n').map(s => centavos(s.trim())).filter(Boolean).slice(0, 1500);
  const fuente = fuenteDe(remitente, asunto);
  const fila = { user_phone: phone, msg_id: String(msg.id).slice(0, 120), cuenta: String(msg.cuenta || '').slice(0, 120) || null, remitente, asunto,
    fecha_correo: msg.date ? new Date(msg.date).toISOString() : new Date().toISOString(), fuente, texto: texto.slice(0, 60000) };
  const pedido = pedidoDe(texto, fuente);
  let tipo = clasificar(asunto, lineas, fuente, remitente);
  // Los descartados guardan su número de pedido: un aviso de envío confirma que ese pedido sí siguió adelante
  if (tipo === 'ignorar') return { ...fila, tipo: 'compra', estado: 'ignorado', parser: 'filtro', pedido, comercio: null, items: [], total: null };
  if (tipo === 'cancelacion') return { ...fila, tipo: 'compra', estado: 'ignorado', parser: 'cancelacion', pedido, comercio: COMERCIO[fuente] || nombreRemitente(remitente), items: [], total: null };
  let comercio = COMERCIO[fuente] || nombreRemitente(remitente);
  if (fuente === 'generico' && /amazon/i.test(asunto)) comercio = 'Amazon';
  const medio_hint = medioHintDe(texto, fuente);
  let items = [], total = null, envio = 0, descuento = 0, parser = 'exacto';

  const amz = fuente === 'amazon' && (tipo === 'compra' || tipo === 'envio') ? lectorAmazon(lineas) : null;
  if (tipo === 'envio') {
    // En reserva (estado 'envio'): conciliar() lo propone solo si ninguna confirmación completa cubre ese pedido
    if (!amz || !amz.total) return { ...fila, tipo: 'compra', estado: 'ignorado', parser: 'filtro', pedido, comercio: null, items: [], total: null };
    const its = amz.items.map(x => ({ nombre: x.nombre, cantidad: x.cantidad || 1, precio: r2(x.precio), categoria: catSugerida(x.nombre, comercio, fuente) }));
    return { ...fila, tipo: 'compra', comercio, pedido, pedidos: pedido ? [pedido] : [], items: its, total: r2(amz.total), envio: amz.envio, descuento: amz.descuento,
      medio_hint, parser: 'envio', estado: 'envio' };
  }
  if (amz) {
    items = amz.items; envio = amz.envio; descuento = amz.descuento; total = amz.total; parser = amz.exacto ? 'exacto' : 'aprox';
  } else if (ES_BANCO(fuente) || tipo === 'reembolso' || tipo === 'ingreso') {
    const b = lectorBanco(lineas, fuente);
    total = b.total;
    if (b.comercio && ES_BANCO(fuente)) comercio = b.comercio;
    const etiqueta = tipo === 'reembolso' ? `Reembolso ${comercio}` : tipo === 'ingreso' ? `Depósito ${COMERCIO[fuente] || ''}`.trim()
      : ES_BANCO(fuente) && comercio === COMERCIO[fuente] ? `Cargo ${comercio} (sin comercio)` : comercio;
    if (total) items = [{ nombre: etiqueta, cantidad: 1, precio: total }];
  } else {
    const lx = lectorExacto(lineas), el = elegirItems(lx);
    items = el.items; envio = lx.envio; descuento = lx.descuento; total = lx.total;
    if (!el.exacto) {
      const a = ES_APP(fuente) ? ajustar(lx) : null;   // apps de comida: el recibo da productos + "Total pagado"
      if (a) ({ items, envio, descuento, total } = a); else parser = 'aprox';
    }
  }

  if (!amz && (parser === 'aprox' || !total || !items.length)) {
    const g = await geminiCompra(deps, { asunto, remitente, texto, phone });
    if (g && g.es_compra === false) return { ...fila, tipo: 'compra', estado: 'ignorado', parser: 'gemini' };
    if (g && Array.isArray(g.items)) {
      const gi = g.items.map(x => ({ nombre: limpiaNombre(x.nombre), cantidad: Math.max(1, parseInt(x.cantidad, 10) || 1), precio: r2(x.precio) })).filter(x => x.nombre && x.precio > 0);
      const gt = Number(g.total) || null, ge = r2(g.envio), gd = r2(g.descuento);
      if (gi.length && (cuadra(gi, ge, gd, gt) || !total)) { items = gi; total = gt || r2(gi.reduce((a, x) => a + x.precio, 0) + ge - gd); envio = ge; descuento = gd; parser = 'gemini'; }
      if (g.tipo === 'reembolso' || g.tipo === 'ingreso') tipo = g.tipo;
      if (g.comercio && fuente === 'generico') comercio = String(g.comercio).slice(0, 60);
    }
  }
  if (!total && items.length) total = r2(items.reduce((a, x) => a + x.precio, 0) + envio - descuento);
  if (!total) return { ...fila, tipo, estado: 'ignorado', parser: 'sin-monto', comercio, pedido };
  if (!items.length) { items = [{ nombre: comercio, cantidad: 1, precio: total }]; parser = 'total'; }
  if (parser !== 'exacto' && parser !== 'gemini' && !cuadra(items, envio, descuento, total)) {
    // Ni el lector ni la IA cuadran: se propone el total del correo como un solo renglón (con los productos en la nota)
    const nota = items.filter(x => !x.extra).map(x => x.nombre).slice(0, 6).join(' · ');
    items = [{ nombre: `${comercio}${pedido ? ' · pedido ' + pedido : ''}`, cantidad: 1, precio: total, nota }];
    envio = 0; descuento = 0; parser = 'total';
  }
  items = items.map(x => ({ nombre: x.nombre, cantidad: x.cantidad || 1, precio: r2(x.precio), categoria: tipo === 'compra' ? catSugerida(x.nombre, comercio, fuente) : 'OTROS', ...(x.nota ? { nota: x.nota } : {}) }));
  const pedidos = amz ? amz.pedidos : (pedido ? [pedido] : []);
  return { ...fila, tipo, comercio, pedido: amz && amz.pedidos.length ? amz.pedidos[0] : pedido, pedidos, items, total: r2(total), envio: r2(envio), descuento: r2(descuento), medio_hint, parser, estado: 'pendiente' };
}

module.exports = function montarCorreo(app, deps) {
  const { sb, SHARE_SECRET, pushA, medioCanonDe, canonCategoria, aplicarImpactoCuentas, conReintentos, learnPattern, esGhost } = deps;
  const firmar = phone => crypto.createHmac('sha256', SHARE_SECRET).update('correo:' + String(phone)).digest('base64url');
  const tokenOk = (phone, tok) => { const a = Buffer.from(String(tok || '')), b = Buffer.from(firmar(phone)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

  app.use('/api/correo', (req, res, next) => (esGhost(req) && req.method !== 'GET')
    ? res.status(403).json({ success: false, error: 'Modo fantasma: solo lectura' }) : next());

  // Token para el script de Gmail (el script lo manda en cada sincronización)
  app.post('/api/correo/token', async (req, res) => {
    const phone = req.body?.user_phone;
    if (!phone) return res.status(400).json({ success: false, error: 'Falta user_phone' });
    res.json({ success: true, token: firmar(phone) });
  });

  // Lee en segundo plano los correos recibidos (estado 'procesando'): así el script de Gmail recibe respuesta al
  // instante aunque haya que consultar a Gemini. Si el servidor se reinicia a la mitad, GET /pendientes lo retoma.
  const _cola = new Set();
  async function procesarCola(phone) {
    if (_cola.has(phone)) return;
    _cola.add(phone);
    const listos = [];
    try {
      for (let vuelta = 0; vuelta < 10; vuelta++) {
        const { data: rows } = await sb.from('correo_compras').select('id, msg_id, cuenta, remitente, asunto, fecha_correo, texto')
          .eq('user_phone', phone).eq('estado', 'procesando').order('fecha_correo', { ascending: true }).limit(20);
        if (!(rows || []).length) break;
        for (const r of rows) {
          // El mismo correo llegó a dos de tus cuentas de Gmail (copia, reenvío automático): solo cuenta una vez
          if (r.cuenta) {
            const t = new Date(r.fecha_correo).getTime();
            const { data: gemelo } = await sb.from('correo_compras').select('id').eq('user_phone', phone).neq('cuenta', r.cuenta).neq('estado', 'procesando')
              .eq('remitente', r.remitente).eq('asunto', r.asunto).gte('fecha_correo', new Date(t - 180e3).toISOString()).lte('fecha_correo', new Date(t + 180e3).toISOString()).limit(1);
            if ((gemelo || []).length) { await sb.from('correo_compras').update({ estado: 'duplicado', parser: 'otra-cuenta' }).eq('id', r.id); continue; }
          }
          let f;
          try { f = await leerCorreo(deps, phone, { id: r.msg_id, from: r.remitente, subject: r.asunto, date: r.fecha_correo, text: r.texto, cuenta: r.cuenta }); }
          catch (e) { console.error('[correo] leer:', e.message); f = { estado: 'ignorado', parser: 'error' }; }
          // Mismo pedido en otro correo (confirmación + "enviado" + factura): solo el primero queda pendiente
          if (f.estado === 'pendiente' && f.pedido) {
            const { data: dup } = await sb.from('correo_compras').select('id').eq('user_phone', phone).eq('pedido', f.pedido).eq('tipo', f.tipo)
              .in('estado', ['pendiente', 'registrado', 'omitido']).neq('id', r.id).limit(1);
            if ((dup || []).length) f.estado = 'duplicado';
          }
          const { user_phone: _p, msg_id: _m, texto: _t, ...upd } = f;
          await sb.from('correo_compras').update(upd).eq('id', r.id);
          if (f.estado === 'pendiente') listos.push({ ...f, id: r.id });
        }
      }
      const prom = await conciliar(phone);
      listos.push(...prom);
      if (listos.length) {
        const { data: siguen } = await sb.from('correo_compras').select('id').in('id', listos.map(x => x.id)).eq('estado', 'pendiente');
        const ok = new Set((siguen || []).map(x => x.id));
        listos.splice(0, listos.length, ...listos.filter(x => ok.has(x.id)));
      }
    } catch (e) { console.error('[correo] cola:', e.message); }
    finally { _cola.delete(phone); }
    if (listos.length && pushA) {
      const f = listos[listos.length - 1], extra = listos.length > 1 ? ` y ${listos.length - 1} más` : '';
      const n = (f.items || []).length;
      pushA(phone, { title: f.tipo === 'reembolso' ? '↩️ Reembolso detectado' : f.tipo === 'ingreso' ? '💰 Depósito detectado' : '📨 Compra detectada',
        body: `${f.comercio} · ${n > 1 ? n + ' productos · ' : ''}$${Number(f.total).toLocaleString('es-MX', { minimumFractionDigits: 2 })}${extra}`, tag: 'compras', url: '/?ir=compras' }, true).catch(() => {});
    }
  }

  // Pedidos cancelados: si llega la cancelación (o el reembolso completo) de un pedido que sigue pendiente, ese pedido
  // deja de proponerse. Amazon a veces cancela "los pedidos recientes" sin decir cuál: se cancelan los confirmados
  // en las 36 h previas que nunca tuvieron aviso de envío/entrega.
  async function conciliar(phone) {
    try {
      const desde = new Date(Date.now() - 60 * 864e5).toISOString();
      const { data: rows } = await sb.from('correo_compras').select('id, fuente, tipo, pedido, pedidos, estado, parser, asunto, fecha_correo, texto, total, comercio, items')
        .eq('user_phone', phone).gte('fecha_correo', desde).limit(2000);
      const todas = rows || [];
      const promovidos = [];

      // 1) Amazon: cada pedido debe quedar cubierto. Si ninguna confirmación completa lo trae (correo recortado o
      //    pedido hecho antes de conectar), se proponen sus avisos de "Enviado" (lo cobrado en cada envío).
      const cubiertos = new Set();
      for (const r of todas) if (r.fuente === 'amazon' && r.tipo === 'compra' && r.parser !== 'envio' && ['pendiente', 'registrado', 'omitido', 'cancelado', 'duplicado'].includes(r.estado))
        ((r.pedidos && r.pedidos.length) ? r.pedidos : r.pedido ? [r.pedido] : []).forEach(p => cubiertos.add(p));
      const aPend = [], aDup = [];
      for (const r of todas.filter(x => x.parser === 'envio')) {
        if (r.estado === 'envio' && r.pedido && !cubiertos.has(r.pedido)) { aPend.push(r.id); promovidos.push(r); }
        else if (r.estado === 'pendiente' && r.pedido && cubiertos.has(r.pedido)) aDup.push(r.id);
      }
      if (aPend.length) await sb.from('correo_compras').update({ estado: 'pendiente' }).in('id', aPend).eq('estado', 'envio');
      if (aDup.length) await sb.from('correo_compras').update({ estado: 'envio' }).in('id', aDup).eq('estado', 'pendiente');
      aPend.forEach(id => { const r = todas.find(x => x.id === id); if (r) r.estado = 'pendiente'; });

      // 2) Traspasos a cuentas propias sin concepto (Banamex "Retiro/Compra" sin comercio): si otro banco avisó que
      //    recibiste/depositaste el mismo monto en ±2 días, es un traspaso entre tus cuentas y no se propone.
      const recibos = todas.filter(r => ES_BANCO(r.fuente) && /recibiste|dep[oó]sito|abono|recarga|te enviaron|transferencia recibida/i.test(String(r.asunto) + ' ' + String(r.texto).slice(0, 1500)));
      const traspasos = [];
      for (const r of todas.filter(x => x.estado === 'pendiente' && ES_BANCO(x.fuente) && x.tipo === 'compra' && /sin comercio/.test(String(((x.items || [])[0] || {}).nombre)))) {
        const t = new Date(r.fecha_correo).getTime(), v = Number(r.total);
        const par = recibos.find(o => o.id !== r.id && Math.abs(new Date(o.fecha_correo).getTime() - t) <= 2 * 864e5
          && montosDe(String(o.texto).slice(0, 3000)).some(m => Math.abs(m.v - v) <= 0.5));
        if (par) traspasos.push(r.id);
      }
      if (traspasos.length) await sb.from('correo_compras').update({ estado: 'ignorado', parser: 'traspaso' }).in('id', traspasos).eq('estado', 'pendiente');

      const pend = todas.filter(r => r.estado === 'pendiente' && !traspasos.includes(r.id));
      const cancelar = new Set();
      for (const c of todas.filter(r => r.parser === 'cancelacion')) {
        const peds = pedidosDe(c.texto).concat(c.pedido ? [c.pedido] : []);
        if (peds.length) { pend.filter(r => r.tipo === 'compra' && peds.includes(r.pedido)).forEach(r => cancelar.add(r.id)); continue; }
        const tc = new Date(c.fecha_correo).getTime();
        for (const r of pend) {
          const tr = new Date(r.fecha_correo).getTime();
          if (r.tipo !== 'compra' || r.fuente !== c.fuente || !r.pedido || tr > tc || tc - tr > 36 * 3600e3) continue;
          const siguio = todas.some(o => o.id !== r.id && o.pedido === r.pedido && /enviado|entrega|entregado|en reparto/.test(norm(o.asunto)));
          if (!siguio) cancelar.add(r.id);
        }
      }
      for (const rf of pend.filter(r => r.tipo === 'reembolso' && r.pedido)) {
        const compra = pend.find(r => r.tipo === 'compra' && r.pedido === rf.pedido && Math.abs(Number(r.total) - Number(rf.total)) <= 1);
        if (compra) { cancelar.add(compra.id); cancelar.add(rf.id); }
      }
      if (cancelar.size) await sb.from('correo_compras').update({ estado: 'cancelado', resuelto_at: new Date().toISOString() }).in('id', [...cancelar]).eq('estado', 'pendiente');
      return promovidos.filter(r => !cancelar.has(r.id));
    } catch (e) { console.error('[correo] conciliar:', e.message); return []; }
  }

  // Ticket en foto desde el chat → tarjeta "por revisar" (la misma de Compras del correo). Si el banco ya avisó
  // ese mismo cargo (mismo total, ±3 días), el ticket lo sustituye: así no se registra dos veces.
  async function ticketDesdeFoto(phone, b64, mime) {
    const msg_id = 'ticket:' + crypto.createHash('sha1').update(String(b64)).digest('hex').slice(0, 24);
    const { data: ya } = await sb.from('correo_compras').select('id, estado, comercio, total, fecha_correo, items, parser').eq('user_phone', phone).eq('msg_id', msg_id).maybeSingle();
    if (ya) return { id: ya.id, estado: ya.estado, comercio: ya.comercio, total: Number(ya.total), n: (ya.items || []).length, fecha: fechaMX(ya.fecha_correo), cuadra: ya.parser === 'ticket', repetido: true };
    const t = await leerTicket(deps, phone, b64, mime);
    if (!t.es_ticket) return { es_ticket: false };
    const nombreCom = s => String(s || '').trim().toLowerCase().replace(/(^|\s)\p{L}/gu, m => m.toUpperCase()).slice(0, 60);
    const comercio = nombreCom(t.comercio) || 'Ticket';
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(t.fecha || '')) ? t.fecha : fechaMX(new Date().toISOString());
    const hora = /^\d{1,2}:\d{2}$/.test(String(t.hora || '')) ? t.hora.padStart(5, '0') : '12:00';
    const $ = n => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let items = t.items.map(x => {
      const partes = [x.texto && norm(x.texto) !== norm(x.nombre) ? x.texto : '', x.cantidad > 1 ? `${x.cantidad} × ${$(x.unit)}` : '',
        x.descuento > 0 ? `${$(x.importe)} − ${$(x.descuento)} de promoción` : ''].filter(Boolean);
      return { nombre: x.nombre, cantidad: x.cantidad, precio: x.precio, categoria: x.categoria || catSugerida(x.nombre, comercio, 'generico'), ...(partes.length ? { nota: partes.join(' · ') } : {}) };
    });
    let descuento = 0;
    const dif = r2(t.total - t.suma);
    if (!t.cuadra) {
      if (dif > 0) items.push({ nombre: 'Diferencia para cuadrar con el total', cantidad: 1, precio: dif, categoria: 'OTROS', nota: 'Revisa qué producto falta o se leyó mal' });
      else descuento = -dif;
    }
    // Medio de pago: terminación de la tarjeta del ticket, o el aviso del banco del mismo cargo
    const term = String(t.tarjeta_terminacion || '').replace(/\D/g, '');
    let medio_hint = /vale/i.test(t.forma_pago || '') ? 'pluxee' : /efectivo/i.test(t.forma_pago || '') && !term ? 'efectivo' : term ? 'tarjeta ' + term : null;
    const f0 = new Date(fecha + 'T12:00:00Z');
    const { data: bancos } = await sb.from('correo_compras').select('id, fuente, comercio, total, fecha_correo, medio_hint').eq('user_phone', phone).eq('estado', 'pendiente').eq('tipo', 'compra')
      .gte('fecha_correo', new Date(f0 - 4 * 864e5).toISOString()).lte('fecha_correo', new Date(+f0 + 4 * 864e5).toISOString());
    const banco = (bancos || []).find(b => ES_BANCO(b.fuente) && Math.abs(Number(b.total) - t.total) <= 1);
    if (banco) {
      if (banco.medio_hint) medio_hint = banco.medio_hint;   // es el mismo cargo: lo pagó esa cuenta
      await sb.from('correo_compras').update({ estado: 'duplicado', resuelto_at: new Date().toISOString() }).eq('id', banco.id).eq('estado', 'pendiente');
    }
    const texto = [`Ticket ${comercio}${t.sucursal ? ' · ' + t.sucursal : ''} · ${fecha} ${hora}`,
      ...t.items.map(x => `${x.texto || x.nombre} │ ${x.cantidad} × ${x.unit} │ ${x.importe}${x.descuento ? ' │ −' + x.descuento : ''} │ ${x.precio}`),
      `Subtotal ${t.subtotal || ''} │ Impuestos ${t.impuestos || ''} │ Total ${t.total} │ Ahorro ${t.ahorro || 0}`, `Pago: ${t.forma_pago || ''} ${t.tarjeta_tipo || ''} ${term}`].join('\n');
    const fila = { user_phone: phone, msg_id, cuenta: 'chat', remitente: 'Foto del chat', asunto: `Ticket · ${items.length} productos${t.ahorro ? ' · ahorraste ' + $(t.ahorro) : ''}`,
      fecha_correo: new Date(`${fecha}T${hora}:00-06:00`).toISOString(), fuente: 'ticket', tipo: 'compra', comercio, items, total: r2(t.total), envio: 0, descuento: r2(descuento),
      medio_hint, parser: t.cuadra ? 'ticket' : 'aprox', estado: 'pendiente', texto, pedidos: [] };
    const { data: row, error } = await sb.from('correo_compras').insert(fila).select('id').single();
    if (error) throw new Error(error.message);
    return { id: row.id, comercio, total: r2(t.total), n: items.length, fecha, cuadra: t.cuadra, dif, ahorro: r2(t.ahorro || 0),
      reemplaza: banco ? { comercio: banco.comercio, total: Number(banco.total) } : null };
  }

  // El script de Gmail entrega correos. Se guardan tal cual (ya en texto) y se leen después; los ya vistos se ignoran.
  app.post('/api/correo/ingest', async (req, res) => {
    try {
      const { phone, token, cuenta } = req.body || {};
      if (!phone || !tokenOk(phone, token)) return res.status(401).json({ success: false, error: 'Token inválido' });
      const mensajes = (Array.isArray(req.body.mensajes) ? req.body.mensajes : []).filter(m => m && m.id).slice(0, 80);
      const filas = mensajes.map(m => ({ user_phone: phone, msg_id: String(m.id).slice(0, 120), cuenta: String(cuenta || '').slice(0, 120) || null,
        remitente: String(m.from || '').slice(0, 200), asunto: String(m.subject || '').slice(0, 300),
        fecha_correo: m.date && !isNaN(new Date(m.date)) ? new Date(m.date).toISOString() : new Date().toISOString(),
        fuente: fuenteDe(m.from, m.subject), estado: 'procesando',
        texto: textoDe(m).slice(0, 60000) }));
      if (filas.length) {
        const { error } = await sb.from('correo_compras').upsert(filas, { onConflict: 'user_phone,msg_id', ignoreDuplicates: true });
        if (error) return res.status(500).json({ success: false, error: error.message });
      }
      // Una fila por cuenta de Gmail conectada (puede haber varias por persona: principal, secundaria…)
      const cta = String(cuenta || '').trim().toLowerCase().slice(0, 120);
      const { data: s0 } = await sb.from('correo_sync').select('recibidos').eq('user_phone', phone).eq('cuenta', cta).maybeSingle();
      await sb.from('correo_sync').upsert({ user_phone: phone, cuenta: cta, ultimo_sync: new Date().toISOString(), recibidos: (s0?.recibidos || 0) + filas.length }, { onConflict: 'user_phone,cuenta' });
      res.json({ success: true, recibidos: filas.length });
      setImmediate(() => procesarCola(phone));
    } catch (e) { console.error('[correo] ingest:', e.message); res.status(500).json({ success: false, error: e.message }); }
  });

  // Pendientes de revisar (+ posibles duplicados contra Movimientos y entre correos) y estado de la conexión
  app.get('/api/correo/pendientes', async (req, res) => {
    try {
      const phone = req.query.phone;
      if (!phone) return res.status(400).json({ success: false, error: 'Falta phone' });
      const [{ data: rows }, { data: sync }, { data: u }] = await Promise.all([
        sb.from('correo_compras').select('id, cuenta, remitente, asunto, fecha_correo, fuente, tipo, pedido, comercio, items, total, envio, descuento, medio_hint, parser')
          .eq('user_phone', phone).eq('estado', 'pendiente').order('fecha_correo', { ascending: false }).limit(60),
        sb.from('correo_sync').select('cuenta, ultimo_sync, recibidos').eq('user_phone', phone).order('ultimo_sync', { ascending: false }),
        sb.from('usuarios').select('external_refs').eq('telefono', phone).maybeSingle()]);
      const lista = rows || [];
      sb.from('correo_compras').select('id', { count: 'exact', head: true }).eq('user_phone', phone).eq('estado', 'procesando')
        .then(({ count }) => { if (count) procesarCola(phone); }, () => {});
      const aprendidos = (u?.external_refs || {}).correo_medios || {};
      let movs = [];
      if (lista.length) {
        const fechas = lista.map(r => fechaMX(r.fecha_correo)).filter(Boolean).sort();
        const d0 = new Date(fechas[0] + 'T12:00:00Z'); d0.setUTCDate(d0.getUTCDate() - 4);
        const { data } = await sb.from('movimientos').select('id, concepto, monto, fecha, tipo').eq('user_phone', phone).gte('fecha', d0.toISOString().slice(0, 10)).limit(2000);
        movs = data || [];
      }
      const dias = (a, b) => Math.abs((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 864e5);
      const out = [];
      for (const r of lista) {
        const fecha = fechaMX(r.fecha_correo);
        const tipoMov = r.tipo === 'compra' ? 'GASTO' : 'INGRESO';
        // Ticket: solo el total (con 20 productos, algún precio suelto coincidiría con cualquier gasto de la semana)
        const montos = r.fuente === 'ticket' ? [Number(r.total)] : [Number(r.total), ...(r.items || []).map(x => Number(x.precio))];
        const dupMov = movs.find(m => m.tipo === tipoMov && dias(m.fecha, fecha) <= 3 && montos.some(v => Math.abs(Number(m.monto) - v) <= 1));
        // Aviso del banco por el mismo cargo que un pedido (Amazon pagado con Banamex) → posible duplicado
        const dupCorreo = ES_BANCO(r.fuente) || r.fuente === 'mercadopago'
          ? lista.find(o => o.id !== r.id && !ES_BANCO(o.fuente) && o.fuente !== 'mercadopago' && o.tipo === r.tipo && Math.abs(Number(o.total) - Number(r.total)) <= 1 && dias(fechaMX(o.fecha_correo), fecha) <= 3) : null;
        // Lo aprendido por tarjeta manda; si el correo no dice con qué se pagó (Amazon), lo aprendido por comercio
        let medio = (r.medio_hint && aprendidos[r.medio_hint]) || (!r.medio_hint && r.comercio && aprendidos['comercio:' + norm(r.comercio)]);
        if (!medio) medio = MEDIO_DE_HINT(r.medio_hint || '') || 'débito';
        out.push({ ...r, fecha, medio_sugerido: await medioCanonDe(phone, medio),
          posible_dup: dupMov ? { tipo: 'mov', concepto: dupMov.concepto, monto: Number(dupMov.monto), fecha: dupMov.fecha }
            : dupCorreo ? { tipo: 'correo', concepto: dupCorreo.comercio, monto: Number(dupCorreo.total), fecha: fechaMX(dupCorreo.fecha_correo) } : null });
      }
      const cuentas = sync || [];   // la más reciente primero; `sync` se conserva para clientes viejos
      res.json({ success: true, data: out, sync: cuentas[0] || null, cuentas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Registrar en Movimientos lo que la persona confirmó (un movimiento por renglón)
  app.post('/api/correo/:id/registrar', async (req, res) => {
    try {
      const { user_phone, fecha, medio_pago, items } = req.body || {};
      if (!user_phone) return res.status(400).json({ success: false, error: 'Falta user_phone' });
      const { data: row } = await sb.from('correo_compras').select('*').eq('id', req.params.id).eq('user_phone', user_phone).maybeSingle();
      if (!row) return res.status(404).json({ success: false, error: 'No se encontró el correo' });
      if (row.estado !== 'pendiente') return res.status(409).json({ success: false, error: 'Este correo ya se había registrado u omitido' });
      const sel = (Array.isArray(items) ? items : []).map(x => ({ ...x, monto: r2(x.monto) })).filter(x => x.monto > 0 && String(x.concepto || '').trim());
      if (!sel.length) return res.status(400).json({ success: false, error: 'No hay renglones para registrar' });
      const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : fechaMX(row.fecha_correo);
      const medio = await medioCanonDe(user_phone, medio_pago);
      const tipoMov = row.tipo === 'compra' ? 'GASTO' : 'INGRESO';
      const desc = (row.fuente === 'ticket' ? `🧾 ${row.comercio || 'Ticket'} · ticket` : `📨 ${row.comercio || 'Correo'}${row.pedido ? ' · pedido ' + row.pedido : ''}`).slice(0, 120);
      const creados = [];
      for (const x of sel) {
        const d = { tipo: x.tipo === 'INGRESO' || x.tipo === 'GASTO' ? x.tipo : tipoMov, categoria: canonCategoria(x.categoria || 'OTROS'),
          concepto: String(x.concepto).trim().slice(0, 140), descripcion: desc, monto: x.monto, medio_pago: x.medio_pago ? await medioCanonDe(user_phone, x.medio_pago) : medio,
          fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(x.fecha || '')) ? x.fecha : f, comentarios: String(x.comentarios || '').slice(0, 400) };
        const { data, error } = await conReintentos(() => sb.from('movimientos').insert({ ...d, user_phone }).select().single());
        if (error || !data?.id) {
          if (creados.length) await sb.from('correo_compras').update({ movimiento_ids: creados.map(c => c.id) }).eq('id', row.id);
          return res.status(400).json({ success: false, error: (error?.message || 'no se pudo guardar') + (creados.length ? ` (se guardaron ${creados.length} de ${sel.length})` : ''), data: creados });
        }
        if (d.tipo === 'GASTO') { try { await learnPattern(user_phone, d); } catch {} }
        await aplicarImpactoCuentas(user_phone, null, data);
        creados.push(data);
      }
      await sb.from('correo_compras').update({ estado: 'registrado', resuelto_at: new Date().toISOString(), movimiento_ids: creados.map(c => c.id) }).eq('id', row.id);
      const llave = row.medio_hint || (row.comercio && !ES_BANCO(row.fuente) ? 'comercio:' + norm(row.comercio) : null);
      if (llave && medio_pago) {   // aprende: la próxima vez esa tarjeta (o ese comercio, si el correo no lo dice) sugiere este medio
        const { data: u } = await sb.from('usuarios').select('external_refs').eq('telefono', user_phone).maybeSingle();
        const refs = { ...(u?.external_refs || {}) };
        if ((refs.correo_medios || {})[llave] !== medio) {
          refs.correo_medios = { ...(refs.correo_medios || {}), [llave]: medio };
          await sb.from('usuarios').update({ external_refs: refs }).eq('telefono', user_phone);
        }
      }
      res.json({ success: true, data: creados });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/correo/:id/omitir', async (req, res) => {
    try {
      const { user_phone } = req.body || {};
      const { data, error } = await sb.from('correo_compras').update({ estado: 'omitido', resuelto_at: new Date().toISOString() })
        .eq('id', req.params.id).eq('user_phone', user_phone).eq('estado', 'pendiente').select('id');
      if (error) return res.status(400).json({ success: false, error: error.message });
      res.json({ success: true, omitidos: (data || []).length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Vuelve a leer los correos guardados con el lector actual (al mejorar los lectores no hace falta tocar el script)
  app.post('/api/correo/releer', async (req, res) => {
    try {
      const { user_phone, todos } = req.body || {};
      if (!user_phone) return res.status(400).json({ success: false, error: 'Falta user_phone' });
      let q = sb.from('correo_compras').select('id, msg_id, cuenta, remitente, asunto, fecha_correo, texto, estado').eq('user_phone', user_phone)
        .order('fecha_correo', { ascending: true }).limit(400);
      q = todos ? q.in('estado', ['pendiente', 'ignorado', 'duplicado', 'cancelado', 'envio']) : q.eq('estado', 'pendiente');
      const { data: rows } = await q;
      let n = 0;
      const resumen = {};
      for (const r of rows || []) {
        const f = await leerCorreo(deps, user_phone, { id: r.msg_id, from: r.remitente, subject: r.asunto, date: r.fecha_correo, text: r.texto, cuenta: r.cuenta });
        if (f.estado === 'pendiente' && f.pedido) {   // mismo pedido ya pendiente/registrado/omitido en otro correo
          const { data: dup } = await sb.from('correo_compras').select('id').eq('user_phone', user_phone).eq('pedido', f.pedido).eq('tipo', f.tipo)
            .in('estado', ['pendiente', 'registrado', 'omitido']).neq('id', r.id).limit(1);
          if ((dup || []).length) f.estado = 'duplicado';
        }
        const { user_phone: _p, msg_id: _m, texto: _t, ...upd } = f;
        await sb.from('correo_compras').update(upd).eq('id', r.id);
        resumen[f.estado] = (resumen[f.estado] || 0) + 1;
        n++;
      }
      await conciliar(user_phone);
      res.json({ success: true, releidos: n, resumen });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Una tarjeta por revisar en concreto (la abre el chat al leer un ticket)
  app.get('/api/correo/uno/:id', async (req, res) => {
    try {
      const phone = req.query.phone;
      const { data: r } = await sb.from('correo_compras').select('id, cuenta, remitente, asunto, fecha_correo, fuente, tipo, pedido, comercio, items, total, envio, descuento, medio_hint, parser, estado')
        .eq('id', req.params.id).eq('user_phone', phone).maybeSingle();
      if (!r) return res.status(404).json({ success: false, error: 'No se encontró' });
      const { data: u } = await sb.from('usuarios').select('external_refs').eq('telefono', phone).maybeSingle();
      const apr = (u?.external_refs || {}).correo_medios || {};
      const medio = (r.medio_hint && apr[r.medio_hint]) || (!r.medio_hint && r.comercio && apr['comercio:' + norm(r.comercio)]) || MEDIO_DE_HINT(r.medio_hint || '') || 'débito';
      const fecha = fechaMX(r.fecha_correo);
      const { data: movs } = await sb.from('movimientos').select('concepto, monto, fecha').eq('user_phone', phone).eq('tipo', 'GASTO')
        .gte('fecha', new Date(new Date(fecha + 'T12:00:00Z') - 3 * 864e5).toISOString().slice(0, 10)).lte('fecha', new Date(+new Date(fecha + 'T12:00:00Z') + 3 * 864e5).toISOString().slice(0, 10));
      const dm = (movs || []).find(m => Math.abs(Number(m.monto) - Number(r.total)) <= 1);
      res.json({ success: true, data: { ...r, fecha, medio_sugerido: await medioCanonDe(phone, medio),
        posible_dup: dm ? { tipo: 'mov', concepto: dm.concepto, monto: Number(dm.monto), fecha: dm.fecha } : null } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  return { ticketDesdeFoto };
};
module.exports._test = { leerTicket, normTicket, htmlATexto, leerCorreo,lectorExacto, elegirItems, clasificar, fuenteDe, medioHintDe, catSugerida, montosDe };
