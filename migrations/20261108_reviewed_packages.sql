-- Run once in Supabase SQL Editor before deploying the reviewed-package transport.
-- No existing articles or push_runs are changed or deleted.
begin;
create table if not exists public.reviewed_packages (
  version text primary key,
  issue_date date not null,
  content_hash text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.reviewed_deliveries (
  version text not null references public.reviewed_packages(version),
  country text not null check (country in ('kz','uz','kg','tj','az')),
  state text not null check (state in ('preparing','failed','sending','succeeded','uncertain')),
  media_id text,
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (version,country)
);
alter table public.reviewed_packages enable row level security;
alter table public.reviewed_deliveries enable row level security;
revoke all on public.reviewed_packages, public.reviewed_deliveries from anon, authenticated;
grant all on public.reviewed_packages, public.reviewed_deliveries to service_role;
create table if not exists public.push_runs (
  id text primary key,
  started_at timestamptz, finished_at timestamptz,
  running boolean not null default false,
  duration_ms bigint, error text, summary jsonb,
  updated_at timestamptz not null default now()
);
commit;
