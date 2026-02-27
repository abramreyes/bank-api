create table if not exists public.wallets (
  wallet_id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  balance numeric(14,2) not null default 0,
  status text not null default 'active' check (status in ('active', 'frozen')),
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;

  insert into public.accounts (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

insert into public.wallets (user_id)
select u.id
from auth.users as u
on conflict (user_id) do nothing;

alter table public.wallets enable row level security;

create policy "Users can read own wallet"
on public.wallets
for select
using (auth.uid() = user_id);

drop trigger if exists trg_wallets_updated_at on public.wallets;
create trigger trg_wallets_updated_at
before update on public.wallets
for each row
execute function public.set_timestamp();
