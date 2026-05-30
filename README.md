# FinanceOS WhatsApp

Bot personal de WhatsApp para gestión financiera, impulsado por Claude AI.

## Setup rápido

1. Clona el repo
2. `npm install`
3. Copia `.env.example` a `.env` y rellena las variables
4. En Supabase → SQL Editor, ejecuta `schema.sql`
5. `npm start`
6. Expón el puerto con ngrok (local) o despliega en Railway (producción)
7. En Twilio Sandbox Settings → "When a message comes in" → pega `https://tu-url/webhook`

## Comandos disponibles

| Mensaje | Acción |
|---|---|
| `ayuda` | Ver menú completo |
| `resumen` | Resumen financiero del día |
| `deudas` | Estado de TDC con progreso |
| `metas` | Objetivos de ahorro |
| `historial` | Últimos 10 movimientos |
| Cualquier texto | Claude responde con contexto financiero |
| Foto o PDF | Análisis del estado de cuenta |

## Stack

Node.js · Express · Twilio · Claude API · Supabase · Railway
