-- FinanceOS seed.sql — idempotente, ejecutar DESPUÉS de todas las migrations
-- Edita el bloque DECLARE con los valores de tu .env antes de ejecutar.
--
-- Variables que debes rellenar:
--   PHONE_ANGEL  → process.env.PHONE_ANGEL  (solo dígitos, ej: 5532005195)
--   PHONE_ALICIA → número de Alicia          (solo dígitos, ej: 5524959599)

DO $$
DECLARE
  phone_angel  text := 'whatsapp:+52PHONE_ANGEL';   -- ← reemplaza PHONE_ANGEL
  phone_alicia text := 'whatsapp:+52PHONE_ALICIA';  -- ← reemplaza PHONE_ALICIA
BEGIN

  -- 1. Usuarios base (ON CONFLICT actualiza modelo e IA sin tocar preferencias manuales)
  INSERT INTO usuarios (telefono, nombre, role, ai_preference, ai_model) VALUES
    (phone_angel,  'Angel',  'ADMIN_A', 'CLAUDE', 'claude-sonnet-4-6'),
    (phone_alicia, 'Alicia', 'USER_B',  'GEMINI', 'gemini-2.5-flash')
  ON CONFLICT (telefono) DO UPDATE SET
    role          = EXCLUDED.role,
    ai_preference = EXCLUDED.ai_preference,
    ai_model      = EXCLUDED.ai_model;

  -- 2. Migrar registros huérfanos (user_phone vacío) al admin
  UPDATE movimientos SET user_phone = phone_angel WHERE user_phone = '' OR user_phone IS NULL;
  UPDATE tdc         SET user_phone = phone_angel WHERE user_phone = '' OR user_phone IS NULL;
  UPDATE metas       SET user_phone = phone_angel WHERE user_phone = '' OR user_phone IS NULL;

  RAISE NOTICE 'seed.sql OK — Angel: %, Alicia: %', phone_angel, phone_alicia;
END $$;
