/* Auditor de layout (desborde / solape / texto fuera de su caja).
 *
 * Uso: abre la app (local o producción), inicia sesión y pega este archivo completo en la consola.
 * Después, con la ventana al ancho que quieras revisar (375, 768, 1024, 1209, 1366, 1536, 1813):
 *     const r = await __vistas(); console.table(Object.entries(r).filter(([,v]) => v.length));
 * Cero filas = ninguna vista tiene problemas. Revisa SIEMPRE varios anchos: el error de "widget que se
 * monta sobre la lista" solo aparecía en ~1200 px y no en pantallas más grandes o más chicas.
 *
 * Qué detecta:
 *   desborde   — un hijo se sale de su contenedor directo (ej. KPI más ancho que su columna)
 *   solape     — dos hermanos en flujo se pisan, contando lo que sobresale de cada uno
 *   texto-fuera — un texto no cabe en su propia caja
 *
 * Causas típicas y su remedio (ya aplicado en toda la app):
 *   - grid-template-columns con "1fr" pelón → usar minmax(0,1fr) (la pista no baja del ancho de su contenido)
 *   - cifras grandes dentro de widgets angostos → tipografía fluida (cqi) + white-space:nowrap
 *   - container-type:inline-size en un elemento de ancho automático → colapsa a 0 px
 */
window.__audit = (root) => {
  const desc = el => {
    const c = (el.className && el.className.baseVal === undefined ? String(el.className) : '').trim().split(/\s+/).slice(0, 2).join('.');
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 26);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${c ? '.' + c : ''}${t ? ' «' + t + '»' : ''}`;
  };
  const vis = el => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.display === 'contents' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const out = [];
  if (!root) return [{ t: 'sin-raiz' }];
  const all = [...root.querySelectorAll('*')].filter(e => !(e instanceof SVGElement && e.tagName !== 'svg') && vis(e));
  const skip = e => e.closest('.tbl-scroll,.gx-tabs,[data-noaudit],svg,.tbl-filters,.ico-badge');
  for (const el of all) {
    if (skip(el)) continue;
    const cs = getComputedStyle(el);
    if (['fixed', 'absolute'].includes(cs.position)) continue;
    const p = el.parentElement; if (!p || !root.contains(p) && p !== root) continue;
    const pcs = getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(pcs.overflowX) || ['inline'].includes(pcs.display)) continue;
    const r = el.getBoundingClientRect(), b = p.getBoundingClientRect();
    const por = Math.max(r.right - b.right, b.left - r.left);
    if (por > 2 && r.width <= b.width * 3 + 50) out.push({ t: 'desborde', el: desc(el), por: Math.round(por), en: desc(p).slice(0, 44) });
  }
  const padres = new Set(all.map(e => e.parentElement).filter(Boolean));
  padres.forEach(p => {
    if (skip(p)) return;
    const hijos = [...p.children].filter(c => vis(c) && !['absolute', 'fixed'].includes(getComputedStyle(c).position) && !(c instanceof SVGElement));
    const ext = c => {
      const r = c.getBoundingClientRect(); let L = r.left, R = r.right;
      c.querySelectorAll('*').forEach(d => { if (d.closest('.tbl-scroll,svg') || ['fixed', 'absolute'].includes(getComputedStyle(d).position)) return; const q = d.getBoundingClientRect(); if (q.width > 1) { L = Math.min(L, q.left); R = Math.max(R, q.right); } });
      return { L, R, T: r.top, B: r.bottom };
    };
    for (let i = 0; i < hijos.length; i++) for (let j = i + 1; j < hijos.length; j++) {
      const a = ext(hijos[i]), b = ext(hijos[j]);
      const w = Math.min(a.R, b.R) - Math.max(a.L, b.L), h = Math.min(a.B, b.B) - Math.max(a.T, b.T);
      if (w > 6 && h > 6) out.push({ t: 'solape', a: desc(hijos[i]).slice(0, 40), b: desc(hijos[j]).slice(0, 40), px: Math.round(w) + '×' + Math.round(h) });
    }
  });
  for (const el of all) {
    if (skip(el) || el.children.length) continue;
    const cs = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.textOverflow !== 'ellipsis' && cs.overflowX === 'visible' && cs.display !== 'inline')
      out.push({ t: 'texto-fuera', el: desc(el), sobra: el.scrollWidth - el.clientWidth });
  }
  return out.slice(0, 40);
};
// Recorre pestañas, módulos/hojas de Inicio y las 6 gráficas de Análisis.
window.__vistas = async () => {
  const res = {};
  const esperar = ms => new Promise(x => setTimeout(x, ms));
  const cerrar = async () => { if (document.getElementById('dash-sheet').classList.contains('open')) { cerrarHoja(); await esperar(350); } };
  window.requestAnimationFrame = f => setTimeout(f, 0);   // en pestañas en segundo plano rAF no corre
  await cerrar(); go('dashboard'); await esperar(500);
  for (const t of ['dashboard', 'movimientos', 'presupuesto', 'calendario', 'nidito', 'deudas', 'negocios']) {
    go(t); await esperar(1000);
    res['tab:' + t] = window.__audit(document.getElementById('tab-' + t)).filter(h => !(h.t === 'desborde' && /mini-fab|\.q-dash/.test(h.el)));
  }
  go('dashboard'); await esperar(500);
  for (const k of ['movimientos', 'nidito', 'presupuesto', 'calendario', 'deuda', 'cuentas', 'despensa', 'notas', 'wishlist', 'consejos']) {
    dashEmoji(k); document.getElementById('dash-sheet').classList.add('open'); await esperar(1300);
    res['hoja:' + k] = window.__audit(document.querySelector('.ds-panel'));
    await cerrar(); go('dashboard'); await esperar(300);
  }
  dashEmoji('analisis'); document.getElementById('dash-sheet').classList.add('open'); await esperar(900);
  for (const [k] of GX_TABS) { gxTab(k); await esperar(700); res['analisis:' + k] = window.__audit(document.querySelector('.ds-panel')); }
  await cerrar();
  return res;
};
