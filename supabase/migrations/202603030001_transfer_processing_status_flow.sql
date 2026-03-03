-- Refine transfer execution flow with explicit processing/completed statuses
-- and transactional error handling inside the ledger engine.

alter table public.transactions
  drop constraint if exists transactions_status_check;

alter table public.transactions
  add constraint transactions_status_check
  check (status in ('pending', 'processing', 'completed', 'failed'));

alter table public.transactions
  alter column status set default 'completed';

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
  v_authenticated_user_id uuid;
  v_locked_wallet public.wallets%rowtype;
  v_error_message text;
begin
  v_authenticated_user_id := auth.uid();

  if v_authenticated_user_id is null then
    raise exception 'authentication required';
  end if;

  if p_sender_user_id is null or p_recipient_user_id is null then
    raise exception 'sender and recipient are required';
  end if;

  if p_sender_user_id <> v_authenticated_user_id then
    raise exception 'sender must match authenticated user';
  end if;

  if p_sender_user_id = p_recipient_user_id then
    raise exception 'cannot transfer to the same wallet';
  end if;

  v_amount := round(p_amount::numeric, 2);

  if v_amount <= 0 then
    raise exception 'amount must be greater than 0';
  end if;

  for v_locked_wallet in
    select *
    from public.wallets
    where user_id in (v_authenticated_user_id, p_recipient_user_id)
    order by wallet_id
    for update
  loop
    if v_locked_wallet.user_id = v_authenticated_user_id then
      v_sender_wallet := v_locked_wallet;
    elsif v_locked_wallet.user_id = p_recipient_user_id then
      v_recipient_wallet := v_locked_wallet;
    end if;
  end loop;

  if v_sender_wallet.wallet_id is null then
    raise exception 'sender wallet not found';
  end if;

  if v_recipient_wallet.wallet_id is null then
    raise exception 'recipient wallet not found';
  end if;

  if v_sender_wallet.status <> 'active' then
    raise exception 'sender wallet is not active';
  end if;

  if v_recipient_wallet.status <> 'active' then
    raise exception 'recipient wallet is not active';
  end if;

  if v_sender_wallet.currency <> v_recipient_wallet.currency then
    raise exception 'wallet currency mismatch';
  end if;

  if v_sender_wallet.balance < v_amount then
    raise exception 'insufficient funds';
  end if;

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
      where user_id = v_authenticated_user_id
      limit 1
    ),
    v_amount,
    'debit',
    p_description,
    v_sender_wallet.wallet_id,
    v_recipient_wallet.wallet_id,
    'processing',
    gen_random_uuid()::text,
    jsonb_build_object(
      'sender_user_id', v_authenticated_user_id,
      'recipient_user_id', p_recipient_user_id,
      'currency', v_sender_wallet.currency
    )
  )
  returning id, public.transactions.created_at
  into v_transaction_id, post_wallet_transfer.created_at;

  begin
    update public.wallets
    set balance = balance - v_amount
    where wallet_id = v_sender_wallet.wallet_id;

    update public.wallets
    set balance = balance + v_amount
    where wallet_id = v_recipient_wallet.wallet_id;

    insert into public.ledger_entries (transaction_id, wallet_id, entry_type, amount)
    values
      (v_transaction_id, v_sender_wallet.wallet_id, 'debit', v_amount),
      (v_transaction_id, v_recipient_wallet.wallet_id, 'credit', v_amount);

    update public.transactions
    set status = 'completed'
    where id = v_transaction_id;

    post_wallet_transfer.status := 'completed';
  exception
    when others then
      get stacked diagnostics v_error_message = message_text;

      update public.transactions
      set status = 'failed',
          metadata = metadata || jsonb_build_object('failure_reason', coalesce(v_error_message, 'transfer failed'))
      where id = v_transaction_id;

      post_wallet_transfer.status := 'failed';
  end;

  transaction_id := v_transaction_id;
  sender_wallet_id := v_sender_wallet.wallet_id;
  recipient_wallet_id := v_recipient_wallet.wallet_id;
  amount := v_amount;

  return next;
end;
$$;
