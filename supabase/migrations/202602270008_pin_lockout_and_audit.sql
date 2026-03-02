-- Add PIN lockout columns and an audit log table.
set search_path = public, auth;

alter table public.profiles
  add column if not exists pin_failed_attempts integer not null default 0,
  add column if not exists pin_locked_until timestamptz;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  action text not null,
  resource_type text,
  resource_id text,
  ip text,
  success boolean not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_user_id_created_at
  on public.audit_logs (user_id, created_at desc);

alter table public.audit_logs enable row level security;

create policy "Users can read own audit logs"
on public.audit_logs
for select
using (user_id = auth.uid());

