# Inventario de UI — financeos-whatsapp

> Paso 0 del rediseño `feat/ui-minimal-responsive`. Objetivo: dejar por escrito CADA función, handler y endpoint por pantalla ANTES de tocar estilos, para garantizar que el rediseño (solo presentación) no rompe ninguna función. Refs de línea sobre `public/index.html` (7524 líneas) en su estado actual (`master` @ 5622c9b).
>
> **Regla que gobierna todo:** solo cambia markup/CSS. No se renombran ni borran IDs, clases usadas por JS, funciones, handlers ni `data-*`. No se toca `server.js`, `.sql`, endpoints, esquema, `S` (estado global), `CATS`, `MEDIOS` ni `CAT_CLR`.

---

## 0. Arquitectura general

- **SPA de un solo archivo:** todo el HTML/CSS/JS vive en `public/index.html`. El HTML de cada pestaña se genera con template strings dentro de funciones `render*` y se inyecta en `.innerHTML`.
- **Estado global `S`** (no tocar): `S.tab`, `S.periodo{tipo,offset}`, `S.data`, `S.phone`, `S.ct{}` (tipo de gráfica por id), `S._secCollapsed{}`, `S._notasT{}`, etc.
- **Despacho de pestañas** (`renderTab`, línea 1749-1756):
  `{ dashboard:rDash, movimientos:rMovimientos, nidito:rNidito, deudas:rDeudas, presupuesto:rPresp, calendario:rCal, chat:rChat, negocios:rNegocios }[t]`
  - ⚠️ **Objetivos vive DENTRO de Presupuesto** (`rObjs` se llama desde `rPresp`) — NO existe `#tab-objetivos`. (El brief menciona `#tab-objetivos`; el real es sección de Presupuesto.)
  - Movimientos se reutiliza en Dashboard (`rMovs`) además de su pestaña (`rMovimientos`).
- **Cambio de pestaña** `go(t)` (1735): limpia `.active` de `.tab`, `nav a`, `.mobile-nav a`; activa `tab-<t>`, `n-<t>`, `mn-<t>`, `rl-<t>`; togglea `body.chat-mode`; llama `renderTab(t)`.
- **PWA:** `sw.js` + `manifest.json` (raíz de `/public`). Al cambiar CSS hay que subir la versión de caché del SW.

## 1. Superficies de navegación (globales)

| Superficie | Contenedor | Items (handler) |
|---|---|---|
| Sidebar escritorio | `<aside>` · IDs `n-*` (1259-1280) | dashboard, movimientos, presupuesto, nidito(rosa), negocios, calendario, deudas, chat — todos `go('<t>')` |
| Rail escritorio ≥1024px | `.rail-desktop` · IDs `rl-*` (1322-1325) | Inicio, Chat, Movimientos, Plan, Más (`openMobileMore`) |
| Barra inferior móvil | `.mobile-nav` · IDs `mn-*` (1348-1353) | Chat, Inicio, Movimientos, Plan(presupuesto), Más(`openMobileMore`) |
| Hoja "Más" | `#mobile-sheet` (1369-1404) | Deudas, Presupuesto y Metas, Calendario, Negocios, Modo día(`toggleTheme` · `#mn-theme-icon`/`#mn-theme-label`), `#mn-ghost-item`(oculto, `toggleGhost`), `#mn-alicia-link`(oculto, `genAliciaLink`), Salir(`logout`) |
| Botón colapsar sidebar | `#sb-float` (1238) `toggleSidebar()` |
| FAB | `.mini-fab` (3707) `oMov()` — hoy solo dentro de rDash |

Utilidades de navegación/estado: `openMobileMore`/`closeMobileMore` (1529/1533), `toggleTheme` (1517), `toggleSidebar` (1508), `logout` (1605), `toggleGhost`/`exitGhost` + `#ghost-banner` (1611/1636, activado por `?alicia`), `showApp`/`showWelcome`/`closeWelcome` (1570/1596/1601), `confirmPhone`/`showPhoneInput` (1549/1539).

## 2. Modal y hojas (globales)

- **Modal `#ovl`** (1409): `openM(title, bodyHtml, onSave)` (5540), `closeM()` (5538), `saveM()` (5547). Título `#m-title`. Lo usan: `oMov`/`eMov` (5398/5501), `oEvt`/`eEvt` (5503/5520), `oMeta` (5522), `oNidito`→`ndNewItem`/`ndEditItem` (4244/4261), `oAgregarLimitePpto`/`editLimitePpto`/`deleteLimitePpto` (5786/5769/5777), `oDespensa` (5957), `oRetiro` (2541), `editCuenta` (2552), y los `neg*` de Negocios.
- **Hoja `#dash-sheet`** (1357): `abrirHoja(titulo, html, post)` (3508) / `cerrarHoja()` (3520) + focus-trap (`_hojaFocusTrapOn/Off`, `_hojaTrapKeydown`, 3536-3561). La usa `dashEmoji(key)` (3563) para montar componentes existentes en hoja/panel.

## 3. Pestañas

### 3.1 Inicio / Dashboard (`#tab-dashboard`, `rDash` 3632)
- Saludo + `‹ periodo ›` (`navPeriodo` 2286) + píldoras Sem/Quinc/Mes/Trim/Año (`setPeriodo` 2285, sobre `S.periodo`).
- Balance grande + Gastos + Ingresos (widgets con desglose: `toggleDesglose`/`desgloseHTML` 3384/3418).
- Fila de 10 emojis → `dashEmoji(key)` (3563): navegan con `go()` o abren contenido en hoja (Cuentas `rCuentasWidget` 2517, Efectivo `oRetiro` 2541, Análisis gráficos `_analisisHTML/_analisisDraw` 3602/3610 → charts `c-cat`/`c-men`/`c-pat`, Consejos IA `_patronesCard`/`fetchInsights` 3721/3759, Despensa, etc.).
- KPIs editables inline: `editKpiIngresos`/`editKpiGastos` (3240/3272), `inlineEditGastoEsp` (3277).
- Snapshot diario `rDailySnapshot` (3310). Notas por pestaña `_mountNotas`/`toggleNotas`/`notaSave` (2609/2657/2709).
- FAB `.mini-fab` → `oMov('GASTO')`.
- Endpoints: `/api/dashboard/{phone}`, `/api/despensa/{phone}`, `/api/insights`, `/api/quincenal-ia`, `/api/update-refs`.

### 3.2 Movimientos (`#tab-movimientos`, `rMovimientos` 3491 → `rMovs` 4986)
- +Ingreso / +Gasto (`oMov('INGRESO'|'GASTO')` 5398). Presets Hoy/Quincena/Mes/Semestre/Año (`setMovPreset` 4717, `applyMovDates` 4728, `initMovF` 4702).
- Filtros: categoría (`toggleMovCat` 4736), medio (`toggleMovMedio` 4743), búsqueda (`applyMovSearch` 4750), rango de fechas. `getMovFiltradas` (4763).
- Gráfica (`setMovChart`/`renderMovChart` 4757/4780, botones `ctBtns`/`sct` 1857/1862). Excel (`exportTableToExcel`/`exportRowsToExcel` 2013/1991).
- Tabla (`mkTable`/`paintTable`/`toggleTblSort`/`setTblSearch`/`setTblFilter`/`toggleTblFilters` 1954/2019/2030-2044), edición inline `ieMov`/`ieCell` (4914/4872), `movRow` (4847), duplicar `duplicarMov` (4977), revisar `markReviewed`/`toggleUnreadFilter` (5148/5174), cambio de categoría `openCatPicker`/`changeCat` (5184/5218).
- Endpoints: `/api/movimientos`(GET/POST/PUT/DELETE por id), `/api/update-refs`.

### 3.3 Nidito (`#tab-nidito`, `rNidito` 3823)
- Acento rosa `--accent-couple` (#f9a8d4) en título/bordes. Tarjetas por tipo (`_ndPaint` 3849).
- Selector de quincena `_ndQ`/`_ndPrev`/`_ndNext`/`ndPickQ` (3791-3808/4154). Dinerito `ndSaveDin` (4163).
- Ítems: `ndNewItem`/`ndEditItem`/`ndDelItem` (4244/4261/4283), asignaciones `ndSaveAsig` (4172), campos `ndPatchF`/`ndPatchPres` (4185/4197), comentarios `ndLoadCmts`/`ndPostCmt` (4211/4221), adjuntos `ndAttach`/`ndUnstage` (4053/4047), toggle `ndToggle` (4141).
- Endpoints: `/api/nidito/items`, `/api/nidito/dinerito`, `/api/nidito/items/{id}` (+ `/asignaciones`, `/comentarios`), `/api/nidito/upload-url`, `/api/nidito/upload-confirm`.

### 3.4 Deudas TDC (`#tab-deudas`, `rDeudas` 4295)
- Total grande + tarjetas con barra de % pagado, estado, pagado/a pagar, mes objetivo.
- Editar/borrar: `eTDC` (3186), `dTDC` (3205), **edición inline por doble clic** `ieTDC`/`inlineEditTDC` (4932) — en móvil se agregará botón ✎ que llame a la MISMA función.
- Gráficas `c-tdc`/`c-tdc2` (tras botón 📊, `ctBtns`/`sct`).
- Endpoints: `/api/tdc`(POST), `/api/tdc/{id}`(PUT/DELETE).

### 3.5 Presupuesto + Objetivos (`#tab-presupuesto`, `rPresp` 4350 + `rObjs` 4510)
- Resumen Gastado/Límite/Disponible. Filas por categoría con barra y límite editable inline (`editLimitePpto` 5769, `deleteLimitePpto` 5777, `oAgregarLimitePpto` 5786). `/api/presupuesto`.
- **Objetivos** (`rObjs` 4510): 3 stats, franja de capacidad de ahorro, tarjetas de meta con progreso, gráfica `c-meta`. Metas: `oMeta`/`eMeta`/`abonarMeta`/`dMeta`/`inlineEditMeta` (5522/3169/4686/6162/3214), `exportObjetivosAhorro` (4497). `/api/metas`.
- **Despensa** (`rDespensa` 5800, `#despensa-section`): `oDespensa` (5957), `updateDespensaField` (5968), `toggleComprado`/`toggleCompraQ` (6008/5989), `dDespensa`/`limpiarCompradosDespensa` (6018/6027), `agregarDespensaAGastos` (6039), `buscarPreciosDespensa` (6072), `toggleDespensaEnGastos` (6095). `/api/despensa`(+/{id}, /buscar-precios).
- Rebalanceo `loadRebalanceo`/`aplicarRebalanceo` (4407/4432) `/api/rebalanceo`. Nidito en presupuesto `rNiditoPresp` (4447).
- Gráfica `c-prsp` tras botón.

### 3.6 Calendario (`#tab-calendario`, `rCal` 5310)
- `rQuincenaPanel(ctx)` (2727) — panel de quincena reutilizable (gastos/ingresos esperados, IA `loadQIA`/`navQ` 3001/2995, export `exportGastosQuincena`/`exportIngresosQuincena` 2481/2498, posponer `posponerGasto` 3101, marcar pagado `marcarPagado`/`marcarGastoQ` 6105/6132).
- Cuadrícula mensual `_calGridHTML` (5234): hoy invertido, día de cobro 💰. Día `calDay`/`closeCalDay`/`calN` (5332/5378/5386).
- Próximos eventos `_calUpcomingHTML` (5285). Eventos: `oEvt`/`eEvt`/`dEvt` (5503/5520/6161), edición inline `ieCal` (4949).
- Endpoints: `/api/calendario`(+/{id}).

### 3.7 Chat (`#tab-chat`, `rChat` 6940)
- Historial local `_loadChatHistory`/`_chatKey` (6978/6976) — `localStorage 'fos_chat_'+phone`. Burbujas `_appendMsg` (7019), scroll `_scrollChat` (7042), typing `_showTyping`/`_hideTyping` (7074/7083).
- Input auto-grow `autoGrowChat` (7087); Enter en móvil NO envía (`_chatEsMovil` 7096, `sendChat` 7100).
- **Nota de voz:** `toggleRecording`/`_stopRecording`/`_recFallback` (7181/7166/7193), `_blobToWavBase64`/`_blobToBase64` (7235/7280) — **límite 60s / manejo de error 413** en `_askBot` (7134). Foto ticket `enviarFotoTicket` (7111).
- Endpoint del bot: `/api/chat-web` (vía `_askBot`).

### 3.8 Negocios (`#tab-negocios`, `rNegocios` 6169)
- ⚠️ El brief NO menciona esta pestaña; existe y no se toca su lógica. Lista `_negRenderLista` (6183), detalle `negAbrirDetalle`/`_negRenderDetalle`/`negVolverLista` (6245/6253/6456), charts `_negRenderCharts` (6463: `gf*`), bloques (`negNuevoBloque`/`negDelBloque`/`negMoverBloque`/`negToggleListaItem`/`negAddListaItem` 6585-6705), proyectos (`negNuevoProyecto`/`negEditarProyecto`/`negEliminarProyecto` 6721-6787), transacciones/deudores/acreedores/inversiones (`negNueva*`/`negDel*` 6797-6931), pagos `negRegistrarPago` (6883).
- `NEG_TIPO_CLR`/`NEG_TIPO_ICO` (constantes de color/icono — NO tocar los de datos). `/api/negocios/proyecto/{id}/resumen`.

## 4. Utilidades transversales (no romper)
- Formato/fechas: `fmt`, `formatFechaLarga`, `formatQuincena`, `toISO`, `getQuincenaInfo`, `getPeriodoRange`, `filterMovs`, `getIngresos/GastosEsperados` (2090-2273).
- Categorización: `catGasto`/`catBadge` (2289/2308) — usa `CATS`/`CAT_CLR` (NO tocar).
- Tablas ordenables/filtrables: familia `mkTable`/`_tbl*` (1874-2064). Charts: `mkC`/`emptyChart`/`ctBtns`/`sct` (1770-1862, Chart.js). Colapsables: `_initCollapsibles` y familia `_apply*Collapse` (2318-2467).
- API base `api(m,p,b,opts)` (1482); carga `load`/`_startLivePoll` (1646/1668, live-poll 2s); `sendWhatsAppInvite` (1696) `/api/send-whatsapp-invite`; `genAliciaLink` (1716) `/api/share-link`; `setAI` (1689) `/api/preferencia`.

## 5. Endpoints usados (todos se conservan; el rediseño no toca red)
`/api/whoami/{phone}`, `/api/usuarios`, `/api/dashboard/{phone}`, `/api/despensa/{phone}` (+ POST, /{id}, /buscar-precios), `/api/preferencia`, `/api/send-whatsapp-invite`, `/api/share-link`, `/api/update-refs`, `/api/quincenal-ia`, `/api/insights`, `/api/movimientos` (+/{id}), `/api/tdc` (+/{id}), `/api/metas` (+/{id}), `/api/calendario` (+/{id}), `/api/patrones/{id}`, `/api/presupuesto`, `/api/recurrentes`, `/api/nidito/*` (items, dinerito, upload-url, upload-confirm, asignaciones, comentarios), `/api/rebalanceo` (+/apply), `/api/negocios/proyecto/{id}/resumen`, `/api/chat-web`.

---

## 6. Estado de las capturas "antes" (Paso 0.3)
Ver la propuesta en el mensaje de retorno: 8 pestañas × 4 resoluciones × 2 modos = 64 capturas. Propongo capturarlas por pestaña durante la implementación (before/after, commit por pestaña) en vez de 64 baselines al inicio — pendiente de tu confirmación.
