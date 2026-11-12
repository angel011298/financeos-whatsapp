# Segundo Cerebro (US) — Plan maestro

Última actualización: 2026-11-11. Documento vivo: se actualiza al cerrar cada fase.

## Objetivo
US deja de ser solo una app de finanzas y se vuelve el contexto permanente de Ángel: finanzas, negocios (YaEntre,
CIFRA, Certifik PLD, FinanceOS), impuestos, documentos, calendario, notas y código, conectados entre sí y disponibles
para un chat con expertos y para avisos proactivos. Alicia sigue viendo solo lo que se comparte.

## Decisiones tomadas (cuestionario, 2026-11)
| Tema | Decisión |
|---|---|
| Quién usa lo nuevo | Solo Ángel; Alicia solo lo compartido |
| Plan de Claude | Pro (USD 20/mes) → lo pesado corre como tareas programadas con esa cuenta, no por API |
| IA en la app | Gemini gratis (sin facturación). Sin llave de Anthropic. Tope mensual: **$0** |
| Respaldo si Gemini cae | Solo proveedores gratuitos (Groq, OpenRouter free, Mistral), aceptando que usan los datos |
| Debe funcionar sin Gemini | Chat de texto + lectura de estados de cuenta y documentos del SAT |
| Google | Dos cuentas personales (enfoques distintos). Calendario en ambos sentidos. **Todo** Drive y **todo** Gmail |
| GitHub | Todos los repos, todo (commits, issues, PRs, despliegues) |
| Laptop / iPhone | Carpeta sincronizada con Drive |
| Notas | Notas de US + Apple Notas |
| Contador de plataformas | YaEntre, CIFRA, Certifik PLD y demás; cobro planeado por Stripe; aún sin cobros reales |
| Situación fiscal | Sueldos y salarios; próximo registro en RESICO; sin facturas; e.firma en renovación |
| Bancos | Banamex (nómina), Revolut (ahorro); BBVA, Nu, Hey, Rappicard, AMEX inhabilitadas por deuda. **Captura manual** |
| Chat | Selector para elegir experto |
| Avisos proactivos | Push de la PWA + correo |
| Hosting | US en Render (gratis); YaEntre en Vercel |
| Prioridad | 1) Contexto total · 2) Contador de plataformas · 3) Inversiones · 4) Google y GitHub conectados · después lo demás |

## Fase 0 — Seguridad (requisito antes de meter Gmail, Drive, SAT o tokens)
Hallazgo: el servidor confía en el número de teléfono que manda el navegador (`/api/dashboard/:phone`,
`/api/update-refs`, etc.). Quien conozca el número de Ángel puede leer y modificar todo. El candado PIN 3142 es
solo del navegador. Con Gmail/Drive/SAT adentro esto no es aceptable.
- Sesión firmada (cookie HttpOnly) emitida al entrar: Ángel con PIN validado en servidor + límite de intentos;
  Alicia con su enlace `?t=` (ya firmado con HMAC) canjeado por sesión.
- Todas las rutas `/api/*` toman la identidad de la sesión, nunca del cuerpo/URL. Modo fantasma solo con sesión de admin.
- Tokens de Google/GitHub cifrados en la base (AES con llave en variable de entorno), nunca en el cliente.
- Correr el "prompt de seguridad" pendiente (Ángel lo tiene; aún no se ha corrido).

## Fase 1 — Contexto total (dentro de US, sin conectores externos)
- **Expediente** (`contexto_total`): resumen compacto y regenerado de TODO lo de US (cuentas y saldos,
  presupuesto, movimientos por mes, deudas TDC, metas, wishlist, negocios, nidito, calendario, notas, perfil fiscal).
  Se guarda en Supabase y lo leen el chat, los expertos y las tareas programadas.
- **Perfil permanente**: hechos que no salen de las tablas (situación fiscal, RESICO, e.firma, bancos inhabilitados,
  plataformas y su forma de cobro). Editable desde la app.
- **Chat con selector de experto**: Finanzas · Contador/SAT · Inversiones · Negocios/Plataformas · Código. Mismo
  expediente, distinto rol y reglas.
- **Respaldo de IA $0**: cadena Gemini → Groq → OpenRouter (modelos free) → respuestas exactas sin IA (`faqFinanciero`).
  Lectura de estados de cuenta y CFDI XML sin IA (parser propio); PDF con texto vía extractor local.

## Fase 2 — Contador de plataformas
- Tabla de plataformas (YaEntre, CIFRA, Certifik PLD…) con estado, costo de operación (Render/Vercel/Supabase/dominios)
  y, cuando existan, ingresos de Stripe (webhook o lectura con llave restringida de solo lectura).
- Vista RESICO: ingresos acumulados vs. tope, ISR estimado mensual, recordatorios de declaración. CFDI emitidos/recibidos
  cuando la e.firma esté vigente (descarga masiva del SAT).

## Fase 3 — Inversiones
- Seguimiento de Revolut ahorro (tasa 15 %), metas y deudas: registro, rendimiento y proyecciones con datos reales.
  Sin recomendaciones automáticas de compra/venta.

## Fase 4 — Conectores (coordinación de contexto permanente)
| Fuente | Cómo | Qué alimenta |
|---|---|---|
| Google Calendar (2 cuentas) | OAuth, sincronización en ambos sentidos | Calendario de US |
| Gmail (2 cuentas) | OAuth solo lectura + etiquetas; filtros CFDI/estados de cuenta/recibos | Contador, Movimientos (propuestas) |
| Drive (2 cuentas) | OAuth solo lectura; índice de archivos + texto | Expediente, Documentos |
| Carpeta laptop/iPhone | Carpeta sincronizada con Drive → entra por Drive | Documentos |
| GitHub (todos los repos) | Token de solo lectura (fine-grained) | Contexto de proyectos, despliegues |
| Apple Notas | Exportación periódica a la carpeta sincronizada | Notas |
| Avisos | Push PWA + correo | Proactivos |
- Trabajo pesado (indexar Drive/Gmail, resúmenes) en tareas programadas de Claude (plan Pro), que escriben el
  resultado en Supabase; la app solo lee.

## Lo que necesita Ángel (no lo puede hacer el asistente)
1. Pegar o volver a pasar el "prompt de seguridad" y aprobar el cambio de inicio de sesión (Fase 0).
2. Crear el proyecto de Google Cloud y el cliente OAuth (pantalla de consentimiento en modo prueba con sus 2 correos).
3. Crear un token de GitHub de solo lectura y cargarlo como variable de entorno en Render.
4. Llave restringida de Stripe (solo lectura) cuando haya cobros.

## Estado
- [x] Cuestionario respondido (2026-11)
- [x] Base financiera coherente: balance/remanente único, Presupuesto, métodos de pago homologados desde cuentas (d0a024c)
- [ ] Fase 0 — Seguridad
- [ ] Fase 1 — Contexto total
- [ ] Fase 2 — Contador de plataformas
- [ ] Fase 3 — Inversiones
- [ ] Fase 4 — Conectores
