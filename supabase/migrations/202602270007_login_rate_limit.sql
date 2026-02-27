-- Track login attempts for database-backed rate limiting.
set search_path = public, auth;

create table if not exists public.login_attempts (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  ip text,
  created_at timestamptz not null default now()
);

create index if not exists idx_login_attempts_email_ip_created_at
  on public.login_attempts (email, ip, created_at desc);

-- This table is only used by the trusted backend (supabase service role / admin key)
-- for counting attempts, so we leave RLS disabled and do not expose it to clients.

