# FinanceOS WhatsApp

Bot personal de WhatsApp para gestión financiera con IA dual (Claude + Gemini), PWA web y pipeline de routing Haiku/Sonnet/Gemini.

## Setup rápido

1. Clona el repo y ejecuta `npm install`
2. Copia `.env.example` a `.env` y rellena las variables (ver sección abajo)
3. En Supabase → SQL Editor, ejecuta las migraciones en orden:
   `schema.sql` → `migration_v2.sql` → `migration_v3_LISTA.sql` → `migration_v4.sql` → `migration_v5.sql` → `migration_v6.sql` → `seed.sql`
4. `npm start` (o `npm run dev` para nodemon)
5. Expón el puerto con ngrok (local) o despliega en Railway (producción)
6. En Twilio Sandbox → "When a message comes in" → `https://tu-url/webhook`

## Testing

### Integration Tests
```bash
node tests/integration.test.js
```
Ejecuta 17 tests de Sprint 8–9 (webhook, propuestas, soft-delete, expiry, API endpoints).
- **Requiere:** servidor en `http://localhost:3001` (se inicia automáticamente)
- **Requiere:** créditos en `ANTHROPIC_KEY` (consumo ~$0.50/run)
- **Timeout:** 300 s — espera cold start de Haiku + latencia Supabase

### Smoke Test
```bash
npm start  # En otra terminal
node scripts/smoke.js
```
Test con datos reales (TDC y metas de `PHONE_ANGEL`, `PHONE_ALICIA`). Valida flujo completo: gasto → propuesta → confirmación → audit_log → soft-delete.
- **Requiere:** servidor en `http://localhost:3001` (por defecto)
- **Requiere:** `PHONE_ANGEL` y `PHONE_ALICIA` en `.env` (solo dígitos)
- **Producción:** `SMOKE_URL=https://tu-dominio.up.railway.app node scripts/smoke.js`
- **Cleanup:** automático (limpia movimientos de prueba y acciones pendientes)

## Variables de entorno

```env
# Twilio
TWILIO_SID=
TWILIO_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886

# IA
ANTHROPIC_KEY=
GEMINI_API_KEY=

# Supabase
SUPABASE_URL=
SUPABASE_KEY=

# Config
PHONE_ANGEL=521XXXXXXXXXX        # solo dígitos, sin + (ej: 5532005195)
ADMIN_PHONE=whatsapp:+521XXXXXXXXXX
PORT=3000
```

## Comandos WhatsApp

| Mensaje | Acción |
|---|---|
| `ayuda` / `help` | Menú completo |
| `resumen` | Resumen financiero del día y mes |
| `deudas` | Estado TDC con barra de progreso |
| `metas` | Objetivos de ahorro individuales |
| `nidito` | Metas compartidas de pareja |
| `presupuesto` | Avance por categoría (🔴🟡✅) |
| `historial` | Últimos 10 movimientos |
| `borrar ultimo` | Soft-delete del último movimiento |
| `deshacer` | Revierte la última acción (ventana 24 h) |
| `privacidad` | Qué datos se guardan, qué IA los procesa, cómo borrarlos |
| `borrar mis datos` | Doble confirmación → soft-delete masivo + purga en 30 días |
| `1` / `sí` | Confirmar acción pendiente |
| `2` / `editar` | Editar propuesta antes de confirmar |
| `3` / `no` | Cancelar acción pendiente |
| Texto libre | Finn responde con contexto financiero completo |
| Foto de ticket | Haiku extrae monto/comercio/fecha → propuesta de registro |
| PDF (estado de cuenta) | Sonnet analiza banco, cargos, intereses, acción recomendada |
| Nota de voz | Gemini transcribe → mismo flujo que texto |

## Pipeline de mensajes

```
POST /webhook  (Twilio WhatsApp)
       │
       ├─ Comando de palabra clave (resumen / deudas / metas / ...)
       │       └─► respuesta directa — sin llamada a IA
       │
       ├─ Acción pendiente en acciones_pendientes
       │       ├─ "1"/sí  → executeDbAction (confirm)
       │       ├─ "2"     → estado 'editing' + mergeEditIntent
       │       └─ "3"/no  → cancelled
       │
       ├─ Media adjunta
       │       ├─ audio  → Gemini Flash (transcribeAudio) → texto
       │       ├─ imagen → Haiku (extractReceiptInfo)
       │       │                ├─ es recibo → proposeDbAction(REGISTRO)
       │       │                └─ otra cosa → Sonnet (análisis)
       │       └─ PDF    → Sonnet + betas pdfs (estado de cuenta)
       │
       └─ Texto / voz transcrita
               │
               ▼
       extractIntent()  [Haiku · ≤500 tok · ephemeral cache]
               │
       ┌───────┴───────────────────────┐
       │                               │
  REGISTRO / EDICION /         CONSULTA / CHARLA / COMANDO
  ELIMINACION + toolArgs               │
       │                       ┌───────┴────────┐
       ▼                       │                │
  proposeDbAction         callClaude        callGemini
  (sin segundo turno)    [Sonnet · CLAUDE]  [Flash · GEMINI]
       │                       │                │
       ▼                       └────────────────┘
  acciones_pendientes              ▼
  → confirm / auto-confirm    guardarMensaje → historial_chat
```

## Arquitectura de IA

```
Modelo                  Rol                     Cuándo                        Etapa
─────────────────────────────────────────────────────────────────────────────────────
claude-haiku-4-5        Extractor de intent     Cada mensaje de texto / voz   extractor
                        Lector de recibos       Cada imagen entrante           vision

claude-sonnet-4-6       Conversador (Angel)     Solo CONSULTA / CHARLA        conversador
                        Análisis imagen         Imagen que no es recibo        vision
                        Análisis PDF            Estado de cuenta               vision

gemini-2.5-flash        Conversador (Alicia)    Solo CONSULTA / CHARLA        conversador
                        Transcripción audio     Nota de voz (WA y web)         vision
                        Insight quincenal       GET /api/insight-quincenal     conversador
```

**Routing decision (por prioridad):**

1. ¿Es comando de palabra clave? → respuesta directa (sin IA, gratis)
2. ¿Hay `acciones_pendientes` pendiente? → flujo confirm/edit/cancel (sin IA)
3. ¿Es media?
   - Audio → `transcribeAudio()` con Gemini, luego flujo normal
   - Imagen → `extractReceiptInfo()` con Haiku (200 tok); si es recibo → `proposeDbAction`; si no → Sonnet
   - PDF → Sonnet + betas pdfs
4. `extractIntent(text)` con Haiku (caché ephemeral ~5 min):
   - `REGISTRO / EDICION / ELIMINACION` + `toolArgs` → `proposeDbAction` sin segundo turno de IA
   - `CONSULTA / CHARLA / COMANDO` → `callIA()` → Sonnet (CLAUDE) o Gemini Flash (GEMINI)

**Caché de prompts:** el bloque estático del system prompt lleva `cache_control: ephemeral`. Reduce el costo de input ~80 % en requests frecuentes del mismo usuario.

**Costos estimados (precios API, por millón de tokens):**

| Modelo | Input | Output | Cache read |
|---|---|---|---|
| Claude Haiku 4.5 | $1.00 | $5.00 | $0.10 |
| Claude Sonnet 4.6 | $3.00 | $15.00 | $0.30 |
| Gemini 2.5 Flash | $0.15 | $0.60 | — |

El endpoint `GET /api/costos/:mes?phone=` devuelve el costo real del mes basado en `usage_log`. Solo accesible para `ADMIN_A`.

## Migraciones

| Archivo | Contenido |
|---|---|
| `schema.sql` | Tablas base: movimientos, tdc, metas, nidito, despensa |
| `migration_v2.sql` | usuarios, calendario, patrones_ia, presupuesto |
| `migration_v3_LISTA.sql` | historial_chat, tipo_meta, ai_model en usuarios |
| `migration_v4.sql` | soft-delete, acciones_pendientes, audit_log |
| `migration_v5.sql` | Campo `revisado` en movimientos (review queue) |
| `migration_v6.sql` | `usage_log` (tokens + costo por llamada IA) |
| `seed.sql` | Usuarios Angel/Alicia + migración de registros huérfanos |

## Stack

Node.js · Express · Twilio WhatsApp API · Anthropic Claude SDK · Google Generative AI SDK · Supabase (PostgreSQL) · Railway
