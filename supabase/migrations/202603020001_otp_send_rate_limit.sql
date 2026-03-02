-- Track OTP send attempts so backend can throttle SMS delivery and control provider costs.
set search_path = public, auth;

create table if not exists public.otp_send_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  ip text,
  phone text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_otp_send_attempts_user_created_at
  on public.otp_send_attempts (user_id, created_at desc);

create index if not exists idx_otp_send_attempts_ip_created_at
  on public.otp_send_attempts (ip, created_at desc);

create index if not exists idx_otp_send_attempts_phone_created_at
  on public.otp_send_attempts (phone, created_at desc);

-- This table is only written/read by trusted backend code (service role key).
