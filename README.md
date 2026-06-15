# FinanceOS WhatsApp — PWA financiera para parejas

App de finanzas personales integrada con WhatsApp, con soporte para múltiples usuarios y IA (Gemini).

## Estructura

- **`server.js`** — Backend (Express.js + Supabase)
- **`public/index.html`** — PWA frontend (single-file, vanilla JS)
- **`tests/integration.test.js`** — Suite de integración (node:test)
- **`migration_v8.sql`** — Schema para Nidito v8

## Pestaña Nidito — Metas y Presupuesto Compartido

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

## Migración v8

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

v6.1 (última: Nidito v8 — 28/28 tests, dashboard total_quincenal, soft-delete items)
