-- migration_v12: Wishlist (lista de deseos) — tabla `wishlist`
-- Aplicada directamente contra el proyecto Supabase (cufglaeiqiffdodygqgd) el 2026-10-07
-- vía MCP. Este archivo documenta lo ya aplicado; no es necesario volver a correrlo salvo
-- para reproducir el esquema en otro proyecto/entorno.
--
-- Ciclo de un deseo: pendiente → agendado (gasto presupuestado en external_refs.budget_q de
-- la quincena elegida, con _id 'wl-<id>') → comprado. El servidor concilia al listar.

create table if not exists public.wishlist (
  id uuid primary key default gen_random_uuid(),
  user_phone text not null,
  nombre text not null default '',
  precio numeric(12,2) not null default 0,
  prioridad text not null default 'media' check (prioridad in ('alta','media','baja')),
  categoria text not null default 'OTROS',
  enlace text not null default '',
  notas text not null default '',
  estado text not null default 'pendiente' check (estado in ('pendiente','agendado','comprado')),
  quincena_key text,                -- 'YYYY-MM-A' (días 10–24) | 'YYYY-MM-B' (25 a 9 del mes siguiente)
  comprado_at timestamptz,
  orden bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz            -- borrado lógico
);
create index if not exists idx_wishlist_phone on public.wishlist(user_phone) where deleted_at is null;

-- Mismo patrón que el resto de tablas de la app: SUPABASE_KEY es la anon key, así que sin una
-- política explícita todo insert/select falla con "violates row-level security policy".
alter table public.wishlist enable row level security;
create policy service_all_wishlist on public.wishlist
  for all to public using (true) with check (true);
