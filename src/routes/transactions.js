import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';

function verifyPin(pin, pinHash) {
  if (!pinHash || typeof pinHash !== 'string') {
    return false;
  }

  const [salt, storedHash] = pinHash.split(':');

  if (!salt || !storedHash) {
    return false;
  }

  const candidateHash = crypto.scryptSync(pin, salt, 64).toString('hex');
  const expected = Buffer.from(storedHash, 'hex');
  const actual = Buffer.from(candidateHash, 'hex');

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

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
    const {
      recipient_user_id: recipientUserId,
      recipient_phone: recipientPhone,
      recipient_email: recipientEmail,
      amount,
      description,
      note,
      pin
    } = req.body;

    if (!recipientUserId && !recipientPhone && !recipientEmail) {
      return res.status(400).json({ error: 'Provide recipient_user_id, recipient_phone, or recipient_email.' });
    }

    if (recipientPhone && recipientEmail) {
      return res.status(400).json({ error: 'Use either recipient_phone or recipient_email, not both.' });
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number.' });
    }

    if (!/^\d{6}$/.test(pin ?? '')) {
      return res.status(400).json({ error: 'pin must be a 6-digit string.' });
    }

    let resolvedRecipientUserId = recipientUserId;

    if (!resolvedRecipientUserId && recipientPhone) {
      const { data: recipientProfile, error: recipientProfileError } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('phone', recipientPhone)
        .single();

      if (recipientProfileError || !recipientProfile) {
        return res.status(404).json({ error: 'Recipient user not found.' });
      }

      resolvedRecipientUserId = recipientProfile.id;
    }

    if (!resolvedRecipientUserId && recipientEmail) {
      const { data: recipientUser, error: recipientUserError } = await supabaseAdmin
        .schema('auth')
        .from('users')
        .select('id')
        .eq('email', recipientEmail)
        .single();

      if (recipientUserError || !recipientUser) {
        return res.status(404).json({ error: 'Recipient user not found.' });
      }

      resolvedRecipientUserId = recipientUser.id;
    }

    if (req.user.id === resolvedRecipientUserId) {
      return res.status(400).json({ error: 'Sender and receiver must be different users.' });
    }

    const { data: senderProfile, error: senderProfileError } = await supabaseAdmin
      .from('profiles')
      .select('pin_hash')
      .eq('id', req.user.id)
      .single();

    if (senderProfileError || !senderProfile?.pin_hash) {
      return res.status(400).json({ error: 'PIN is not configured for this user.' });
    }

    if (!verifyPin(pin, senderProfile.pin_hash)) {
      return res.status(401).json({ error: 'Invalid PIN.' });
    }

    const { data: senderWallet, error: senderWalletError } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', req.user.id)
      .single();

    if (senderWalletError || !senderWallet) {
      return res.status(404).json({ error: 'Sender wallet not found.' });
    }

    if (Number(senderWallet.balance) < amount) {
      return res.status(400).json({ error: 'Insufficient balance.' });
    }

    const transferDescription = note ?? description ?? null;

    const { data, error } = await supabaseAdmin.rpc('post_wallet_transfer', {
      p_sender_user_id: req.user.id,
      p_recipient_user_id: resolvedRecipientUserId,
      p_amount: amount,
      p_description: transferDescription
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({ transaction: data?.[0] ?? null });
  });

  return router;
}
