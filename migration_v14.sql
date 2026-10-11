-- v14 (2026-10-11): Wishlist compartida entre Ángel y Alicia.
-- Ya aplicada en Supabase (cufglaeiqiffdodygqgd) vía MCP; se deja aquí como registro.

-- compartido: el dueño decide qué deseos ve su pareja (por defecto, ninguno).
alter table public.wishlist add column if not exists compartido boolean not null default false;
-- origen_id: si el deseo es una copia ("Agregar a mi lista") de uno que compartió la pareja.
alter table public.wishlist add column if not exists origen_id uuid;
create index if not exists wishlist_compartido_idx on public.wishlist (user_phone) where compartido and deleted_at is null;
create index if not exists wishlist_origen_idx on public.wishlist (origen_id) where origen_id is not null;
