-- v13 (2026-10-09): forma de pago en la Wishlist, emoji en el Nidito y categoría "Alicia".
-- Ya aplicada en Supabase (cufglaeiqiffdodygqgd) vía MCP; se deja aquí como registro.

-- Wishlist: forma de pago del deseo ('' | 'efectivo' | 'tarjeta_debito' | 'pluxee'), la misma terna
-- que "Gastos esta quincena". Viaja al gasto agendado y define el medio al palomearlo.
alter table public.wishlist add column if not exists forma_pago text not null default '';

-- Nidito: emoji elegido en el asistente de creación (si es null se usa el del tipo).
alter table public.nidito_items add column if not exists emoji text;

-- Categoría "Alicia" (sustituye a "Hormiga", que no tenía registros):
--   todo gasto que mencione a Alicia (comentario, concepto o descripción) pasa a "Alicia";
--   lo que hubiera en "Hormiga" pasa a "OTROS".
update public.movimientos set categoria = 'Alicia'
 where deleted_at is null and tipo = 'GASTO'
   and (coalesce(comentarios,'') || ' ' || coalesce(concepto,'') || ' ' || coalesce(descripcion,'')) ~* '\malicia\M';
update public.movimientos set categoria = 'OTROS' where categoria = 'Hormiga';
update public.presupuesto set categoria = 'OTROS' where categoria = 'Hormiga';
update public.wishlist    set categoria = 'OTROS' where categoria = 'Hormiga';
-- Los gastos planeados (external_refs.budget_q / gastos_esperados) que mencionan a Alicia se
-- reclasifican con un script aparte sobre el JSON (ver commit).
