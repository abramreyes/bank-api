-- Ledger-based transaction engine for wallet transfers.

alter table public.transactions
  add column if not exists sender_wallet_id uuid references public.wallets (wallet_id) on delete set null,
  add column if not exists recipient_wallet_id uuid references public.wallets (wallet_id) on delete set null,
  add column if not exists status text not null default 'posted' check (status in ('pending', 'posted', 'failed')),
  add column if not exists reference text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_transactions_sender_wallet_id on public.transactions (sender_wallet_id);
create index if not exists idx_transactions_recipient_wallet_id on public.transactions (recipient_wallet_id);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  wallet_id uuid not null references public.wallets (wallet_id) on delete cascade,
  entry_type text not null check (entry_type in ('debit', 'credit')),
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_entries_transaction_id on public.ledger_entries (transaction_id);
create index if not exists idx_ledger_entries_wallet_id_created_at on public.ledger_entries (wallet_id, created_at desc);

alter table public.ledger_entries enable row level security;

create policy "Users can read own ledger entries"
on public.ledger_entries
for select
using (
  wallet_id in (
    select wallet_id from public.wallets where user_id = auth.uid()
  )
);

create or replace function public.post_wallet_transfer(
  p_sender_user_id uuid,
  p_recipient_user_id uuid,
  p_amount numeric,
  p_description text default null
)
returns table (
  transaction_id uuid,
  sender_wallet_id uuid,
  recipient_wallet_id uuid,
  amount numeric,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender_wallet public.wallets%rowtype;
  v_recipient_wallet public.wallets%rowtype;
  v_transaction_id uuid;
  v_amount numeric(14,2);
begin
  if p_sender_user_id is null or p_recipient_user_id is null then
    raise exception 'sender and recipient are required';
  end if;

  if p_sender_user_id = p_recipient_user_id then
    raise exception 'cannot transfer to the same wallet';
  end if;

  v_amount := round(p_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'amount must be greater than 0';
  end if;

  select * into v_sender_wallet
  from public.wallets
  where user_id = p_sender_user_id
  for update;

  if not found then
    raise exception 'sender wallet not found';
  end if;

  select * into v_recipient_wallet
  from public.wallets
  where user_id = p_recipient_user_id
  for update;

  if not found then
    raise exception 'recipient wallet not found';
  end if;

  if v_sender_wallet.status <> 'active' or v_recipient_wallet.status <> 'active' then
    raise exception 'both wallets must be active';
  end if;

  if v_sender_wallet.currency <> v_recipient_wallet.currency then
    raise exception 'wallet currency mismatch';
  end if;

  if v_sender_wallet.balance < v_amount then
    raise exception 'insufficient funds';
  end if;

  update public.wallets
  set balance = balance - v_amount
  where wallet_id = v_sender_wallet.wallet_id;

  update public.wallets
  set balance = balance + v_amount
  where wallet_id = v_recipient_wallet.wallet_id;

  insert into public.transactions (
    account_id,
    amount,
    direction,
    description,
    sender_wallet_id,
    recipient_wallet_id,
    status,
    reference,
    metadata
  )
  values (
    (
      select id
      from public.accounts
      where user_id = p_sender_user_id
      limit 1
    ),
    v_amount,
    'debit',
    p_description,
    v_sender_wallet.wallet_id,
    v_recipient_wallet.wallet_id,
    'posted',
    gen_random_uuid()::text,
    jsonb_build_object(
      'sender_user_id', p_sender_user_id,
      'recipient_user_id', p_recipient_user_id,
      'currency', v_sender_wallet.currency
    )
  )
  returning id, public.transactions.status, public.transactions.created_at
  into v_transaction_id, post_wallet_transfer.status, post_wallet_transfer.created_at;

  insert into public.ledger_entries (transaction_id, wallet_id, entry_type, amount)
  values
    (v_transaction_id, v_sender_wallet.wallet_id, 'debit', v_amount),
    (v_transaction_id, v_recipient_wallet.wallet_id, 'credit', v_amount);

  transaction_id := v_transaction_id;
  sender_wallet_id := v_sender_wallet.wallet_id;
  recipient_wallet_id := v_recipient_wallet.wallet_id;
  amount := v_amount;

  return next;
end;
$$;

grant execute on function public.post_wallet_transfer(uuid, uuid, numeric, text) to authenticated;
