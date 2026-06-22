# FinanceOS WhatsApp — PWA financiera para parejas

App de finanzas personales integrada con WhatsApp, con soporte para múltiples usuarios y IA (Gemini).

## Estructura

- **`server.js`** — Backend (Express.js + Supabase)
- **`public/index.html`** — PWA frontend (single-file, vanilla JS)
- **`tests/integration.test.js`** — Suite de integración (node:test)
- **`migration_v8.sql`** — Schema para Nidito v8
- **`migration_v10.sql`** — Schema para Negocios y Proyectos

## Pestaña Negocios y Proyectos

### Descripción
Pestaña para gestionar proyectos empresariales/negocios con tracking de:
- **Transacciones** — Ingresos/gastos por proyecto
- **Deudores** — Clientes que deben (con pago parcial)
- **Acreedores** — Proveedores a los que debe (con pago parcial)
- **Inversiones** — Capital invertido con seguimiento de rendimiento
- **Bloques (Canvas)** — Notas, listas, tablas, recordatorios y gráficas personalizadas
- **Gráficas** — Flujo de caja, distribución por categoría, aging de cartera

**Reflejo en Dashboard:**
- Cada transacción con `reflejo_personal='RETIRO'` suma como ingreso del usuario
- Cada transacción con `reflejo_personal='APORTE'` suma como gasto del usuario
- El neto personal (retiros - aportes) aparece en la pestaña y en un card del Dashboard

### Endpoints REST

#### Proyectos
- **POST /api/negocios** — Crear proyecto (req: `phone`, `nombre`, `tipo`, `estado`, `fecha_inicio`, `fecha_vencimiento`, `monto_meta`, `capital_inicial`)
- **GET /api/negocios/:phone** — Listar proyectos del usuario
- **GET /api/negocios/proyecto/:id/resumen** — KPIs (ingresos, gastos, saldo neto, por cobrar, por pagar, inversiones totales)
- **PUT /api/negocios/proyecto/:id** — Actualizar proyecto
- **DELETE /api/negocios/proyecto/:id** — Eliminar proyecto y sus datos relacionados

#### Transacciones
- **POST /api/negocios/proyecto/:id/transacciones** — Registrar transacción (auto-calcula `quincena_key`)
- **GET /api/negocios/proyecto/:id/transacciones** — Listar transacciones
- **PUT /api/negocios/transaccion/:id** — Actualizar
- **DELETE /api/negocios/transaccion/:id** — Eliminar

#### Deudores (Por Cobrar)
- **POST /api/negocios/proyecto/:id/deudores** — Agregar cliente/deuda (req: `nombre`, `monto_original`, `concepto`, `fecha_vencimiento`)
- **GET /api/negocios/proyecto/:id/deudores** — Listar deudores
- **POST /api/negocios/deudor/:id/pago** — Registrar cobro parcial (req: `monto`) → recalcula `estado` automáticamente
- **PUT /api/negocios/deudor/:id** — Actualizar deudor
- **DELETE /api/negocios/deudor/:id** — Eliminar

#### Acreedores (Por Pagar)
- **POST /api/negocios/proyecto/:id/acreedores** — Agregar proveedor/deuda (req: `nombre`, `monto_original`, `concepto`, `fecha_vencimiento`)
- **GET /api/negocios/proyecto/:id/acreedores** — Listar acreedores
- **POST /api/negocios/acreedor/:id/pago** — Registrar pago parcial (req: `monto`) → recalcula `estado` automáticamente
- **PUT /api/negocios/acreedor/:id** — Actualizar acreedor
- **DELETE /api/negocios/acreedor/:id** — Eliminar

#### Inversiones
- **POST /api/negocios/proyecto/:id/inversiones** — Crear inversión (req: `nombre`, `monto_invertido`, `tipo_inversion`, `estado`)
- **GET /api/negocios/proyecto/:id/inversiones** — Listar inversiones
- **PUT /api/negocios/inversion/:id** — Actualizar
- **DELETE /api/negocios/inversion/:id** — Eliminar

#### Canvas (Bloques)
- **POST /api/negocios/proyecto/:id/bloques** — Crear bloque (req: `tipo` ∈ NOTA|LISTA|TABLA|RECORDATORIO|GRAFICA, `titulo`, `contenido`)
  - NOTA: contenido es string (soporta links)
  - LISTA: contenido es `[{texto, marcado}]`
  - TABLA: contenido es `{columns: [...], rows: [[...], [...]]}`
  - RECORDATORIO: contenido es `{texto, fecha}`
  - GRAFICA: contenido es `{fuente: flujo|categorias|cartera, tipo: bar|line|doughnut}`
- **GET /api/negocios/proyecto/:id/bloques** — Listar bloques ordenados por `orden`
- **PUT /api/negocios/bloque/:id** — Actualizar (soporta shape-validation de contenido por tipo)
- **DELETE /api/negocios/bloque/:id** — Eliminar

#### Gráficas
- **GET /api/negocios/proyecto/:id/grafica?fuente=flujo|categorias|cartera** — Obtener datos para Chart.js
  - `flujo` — Ingresos vs gastos por quincena (barras)
  - `categorias` — Suma de gastos por categoría (dona)
  - `cartera` — Por cobrar vs por pagar (barras)

#### Dashboard
- **GET /api/dashboard/:phone** — Incluye campos:
  - `negocios.proyectos` — Array de proyectos
  - `negocios.retiros_quincena` — Suma de ingresos con `reflejo_personal=RETIRO` esta quincena
  - `negocios.aportes_quincena` — Suma de egresos con `reflejo_personal=APORTE` esta quincena
  - `negocios.neto_personal` — `retiros_quincena - aportes_quincena`
  - `negocios.eventos` — Array de 90-day eventos (VENCIMIENTO_COBRO, VENCIMIENTO_PAGO, INVERSION_OBJETIVO, RECORDATORIO)

### Estados de Pago
- **PENDIENTE** — Monto pagado = 0
- **PARCIAL** — 0 < Monto pagado < Monto original
- **PAGADO** — Monto pagado = Monto original

Se recalculan automáticamente en PUT (deudor/acreedor) y POST (pago).

### Aging de Cartera
Basado en `fecha_vencimiento`:
- **Vigente** — Vencimiento en el futuro
- **v1_30** — Vencido hace 1-30 días
- **v31_60** — Vencido hace 31-60 días
- **v60_mas** — Vencido hace 60+ días

Se expone en el endpoint `/api/negocios/proyecto/:id/resumen`.

### Pestaña Nidito — Metas y Presupuesto Compartido

### Descripción
Pestaña para gestionar metas/proyectos conjuntos (parejas) con asignaciones quinzenales y presupuesto compartido.

**Estructura visual:**
1. **Dinerito** — Card con monto quincenal disponible + selector de quincena (A/B)
2. **Proyectos** — Acordeones expandibles con:
   - Fechas (inicio/fin)
   - Presupuesto y asignaciones por persona
   - Comentarios + adjuntos (imágenes/PDFs)
3. **Metas** — Tres secciones por duración (corto/mediano/largo plazo)

### Endpoints REST

#### Items (Proyectos/Metas)
- **GET /api/nidito/items** — Listar items con asignaciones anidadas (filtrable por `?tipo=&estado=&phone=`)
- **GET /api/nidito/items/:id** — Detalle de un item
- **POST /api/nidito/items** — Crear item (req: `user_phone`, `tipo`, `titulo`, `presupuesto_total`, `estado`, `fecha_inicio`, `fecha_fin`)
- **PATCH /api/nidito/items/:id** — Actualizar item
- **DELETE /api/nidito/items/:id** — Soft-delete (marca `deleted_at`)

#### Asignaciones Quinzenales
- **PUT /api/nidito/items/:id/asignaciones** — Upsert asignación por persona (req: `user_phone`, `monto_total_asignado`, `monto_quincenal`)
  - Devuelve `warn` si asignación total supera presupuesto

#### Comentarios
- **GET /api/nidito/items/:id/comentarios** — Listar comentarios
- **POST /api/nidito/items/:id/comentarios** — Crear comentario (req: `user_phone`, `cuerpo`, `adjuntos: [{url, nombre, tipo}]`)

#### Dinerito (Presupuesto Quinzenal)
- **GET /api/nidito/dinerito?phone=X&quincena=YYYY-MM-A** — Obtener monto disponible
- **PUT /api/nidito/dinerito** — Upsert monto (req: `user_phone`, `quincena_key`, `monto`)

#### Utilidades
- **GET /api/nidito/quincena?fecha=YYYY-MM-DD** — Calcular quincena de una fecha
  - Retorna: `{ key: 'YYYY-MM-A|B', inicio: 'YYYY-MM-DD', fin: 'YYYY-MM-DD' }`
  - Edge case: días 01-09 pertenecen a quincena **B anterior** (ej: 2026-06-05 → 2026-05-B)

#### Dashboard
- **GET /api/dashboard/:phone** — Panel principal
  - Incluye: `nidito_compromiso` (suma de monto_quincenal asignado) y `nidito_dinerito` (monto actual)

### Upload de Adjuntos

Flow firmado (Supabase Storage):
1. **POST /api/nidito/upload-url** — Obtiene signed upload URL (req: `nombre`, `tipo`, `itemId`)
   - Respuesta: `{ uploadUrl, path }`
2. **PUT {uploadUrl}** — Browser sube archivo directamente a Supabase Storage (raw body)
3. **POST /api/nidito/upload-confirm** — Obtiene signed download URL de 10 años (req: `path`, `nombre`, `tipo`)
   - Respuesta: `{ url, path, nombre, tipo }`
4. **POST /api/nidito/items/:id/comentarios** — Adjunta a comentario incluye `adjuntos` array

**Tipos permitidos:** `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf` (máx 10 MB)

### RLS (Row Level Security)

Todas las tablas de Nidito v8 tienen RLS con política `FOR ALL USING (true)` — service role accede sin restricción; el control de acceso es responsabilidad de la app.

## Migración v8 (Nidito)

Archivo: **`migration_v8.sql`**

Tablas:
- **nidito_items** — Proyectos/metas (uuid, tipo, título, presupuesto, estado, fechas, `deleted_at` soft-delete)
- **nidito_asignaciones** — Montos asignados por persona a cada item (UNIQUE `item_id,user_phone`)
- **nidito_comentarios** — Comentarios con adjuntos JSONB
- **nidito_dinerito** — Presupuesto quinzenal por persona (UNIQUE `user_phone,quincena_key`)

Storage:
- Bucket **nidito-adjuntos** (privado, 10 MB max)

### Cómo aplicar en producción

1. **Supabase Dashboard** → SQL Editor
2. Copy-paste contenido de `migration_v8.sql`
3. **Run** (botón verde)
4. Verificar en Tables: `nidito_items`, `nidito_asignaciones`, `nidito_comentarios`, `nidito_dinerito` creadas
5. Verificar en Storage → Buckets: `nidito-adjuntos` creado
6. Deploy app (incluye los nuevos endpoints y frontend)

## Migración v10 (Negocios y Proyectos)

Archivo: **`migration_v10.sql`**

Tablas (6 tablas, todas con RLS `FOR ALL USING (true)`, control en app):
- **neg_proyectos** — Proyectos empresariales (uuid, user_phone FK, nombre, tipo ∈ NEGOCIO|EMPRENDIMIENTO|PROYECTO|INVERSION|FREELANCE, estado ∈ ACTIVO|PAUSADO|CERRADO, fechas, monto_meta, capital_inicial)
- **neg_transacciones** — Transacciones (ingresos/gastos, auto-calcula `quincena_key`, soporta `reflejo_personal` ∈ RETIRO|APORTE)
- **neg_deudores** — Clientes/deudas por cobrar (estado auto-recalculado: PENDIENTE|PARCIAL|PAGADO)
- **neg_acreedores** — Proveedores/deudas por pagar (mismo sistema de estados)
- **neg_inversiones** — Capital invertido con rendimiento esperado
- **neg_bloques** — Canvas: notas, listas, tablas, recordatorios, gráficas (contenido JSONB validado por tipo)

### Cómo aplicar en producción

1. **Supabase Dashboard** → SQL Editor
2. Copy-paste contenido de `migration_v10.sql`
3. **Run** (botón verde)
4. Verificar en Tables: 6 tablas `neg_*` creadas con RLS
5. Deploy app con endpoints `/api/negocios/*`

### Notas de Implementación

**RETIRO vs APORTE:**
- Transacción con `reflejo_personal='RETIRO'` (ingreso del proyecto) → suma como retiro neto del usuario (ingreso personal)
- Transacción con `reflejo_personal='APORTE'` (aporte a proyecto) → suma como aporte neto del usuario (egreso personal)
- **Neto personal** = Σ retiros - Σ aportes (por quincena)
- Aparece en dashboard y card "Negocios" del dashboard

**Validación de bloques:**
- NOTA: contenido es string; soporta links auto-detectados
- LISTA: contenido es `[{texto, marcado}]`; UI permite togglear items
- TABLA: contenido es `{columns: [...], rows: [[...], [...]]}` con scroll horizontal en móvil
- RECORDATORIO: contenido es `{texto, fecha}`; se sincroniza a negEventos del dashboard
- GRAFICA: contenido es `{fuente: flujo|categorias|cartera, tipo: bar|line|doughnut}`; renderiza con mkC()

**Aging de cartera:**
- Calculado en `/api/negocios/proyecto/:id/resumen` a partir de `fecha_vencimiento` en deudores/acreedores
- Categorías: vigente, v1_30, v31_60, v60_mas

## Helpers

### `getQuincena(fecha)`
Calcula la quincena para una fecha dada.

```javascript
getQuincena('2026-06-15') → { key: '2026-06-A', inicio: '2026-06-10', fin: '2026-06-24' }
getQuincena('2026-06-05') → { key: '2026-05-B', inicio: '2026-05-25', fin: '2026-06-09' }
getQuincenaActual()        → quincena de hoy
```

Formato `quincena_key`: `YYYY-MM-A` (días 10-24) | `YYYY-MM-B` (días 25-09 siguiente)

## Tests

Suite: **`tests/integration.test.js`** (28 tests, node:test runner)

Corre:
```bash
node tests/integration.test.js
```

Incluye:
- T1-T17: Webhook, movimientos, IA (Gemini), edge cases
- T18-T27: Nidito CRUD, asignaciones, dinerito, quincena helpers
- T28: Dashboard nidito.total_quincenal con soft-delete de items

**Requisito:** Servidor debe estar escuchando en `http://localhost:3000` (o `PORT=...`)

## Deployment

- **Local:** `node server.js` (puerto 3000 default, o `PORT=3001`)
- **Railway:** `railway up` (auto-detecta Node.js, ejecuta `node server.js`)

Build: `.env` con `SUPABASE_URL` y `SUPABASE_KEY`

## Versión

v7.0 (Negocios y Proyectos v10 — 28/28 tests, 26 endpoints, 6 tablas, canvas con 5 tipos bloques, 3 gráficas)
