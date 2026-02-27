import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

export function transactionsRouter({ supabaseAdmin }) {
  const router = Router();

  router.get('/me', requireAuth(supabaseAdmin), async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '50', 10), 1), 100);

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('wallet_id')
      .eq('user_id', req.user.id)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({ error: 'Wallet not found for current user.' });
    }

    const { data, error } = await supabaseAdmin
      .from('ledger_entries')
      .select(
        'id,entry_type,amount,created_at,transaction:transactions!ledger_entries_transaction_id_fkey(id,description,reference,status,sender_wallet_id,recipient_wallet_id)'
      )
      .eq('wallet_id', wallet.wallet_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ transactions: data ?? [] });
  });

  router.post('/transfer', requireAuth(supabaseAdmin), async (req, res) => {
    const { recipient_user_id: recipientUserId, amount, description } = req.body;

    if (!recipientUserId) {
      return res.status(400).json({ error: 'recipient_user_id is required.' });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number.' });
    }

    const { data, error } = await supabaseAdmin.rpc('post_wallet_transfer', {
      p_sender_user_id: req.user.id,
      p_recipient_user_id: recipientUserId,
      p_amount: amount,
      p_description: description ?? null
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({ transaction: data?.[0] ?? null });
  });

  return router;
}
