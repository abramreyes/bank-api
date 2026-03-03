import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { logAuditEvent } from '../lib/audit.js';

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
    const parsedLimit = Number.parseInt(req.query.limit ?? '20', 10);
    const parsedPage = Number.parseInt(req.query.page ?? '1', 10);
    const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
    const page = Number.isNaN(parsedPage) ? 1 : Math.max(parsedPage, 1);
    const offset = (page - 1) * limit;

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('wallet_id')
      .eq('user_id', req.user.id)
      .single();

    if (walletError || !wallet) {
      return res.status(404).json({ error: 'Wallet not found for current user.' });
    }

    const {
      data,
      error,
      count
    } = await supabaseAdmin
      .from('ledger_entries')
      .select(
        'id,entry_type,amount,created_at,transaction:transactions!ledger_entries_transaction_id_fkey(id,description,reference,status,sender_wallet_id,recipient_wallet_id)',
        { count: 'exact' }
      )
      .eq('wallet_id', wallet.wallet_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const transactions = (data ?? []).map((entry) => ({
      id: entry.id,
      sent: entry.entry_type === 'debit',
      received: entry.entry_type === 'credit',
      date: entry.created_at,
      amount: entry.amount,
      status: entry.transaction?.status ?? null,
      reference_id: entry.transaction?.reference ?? null,
      description: entry.transaction?.description ?? null,
      transaction_id: entry.transaction?.id ?? null
    }));

    const total = count ?? transactions.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        total_pages: totalPages,
        has_next_page: page < totalPages,
        has_previous_page: page > 1
      }
    });
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
      const { data: recipientProfiles, error: recipientProfileError } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('phone', recipientPhone)
        .limit(2);

      if (recipientProfileError) {
        return res.status(400).json({ error: recipientProfileError.message });
      }

      if (!recipientProfiles || recipientProfiles.length === 0) {
        return res.status(404).json({ error: 'Recipient user not found.' });
      }

      if (recipientProfiles.length > 1) {
        return res.status(409).json({ error: 'Recipient phone matches multiple users.' });
      }

      resolvedRecipientUserId = recipientProfiles[0].id;
    }

    if (!resolvedRecipientUserId && recipientEmail) {
      const { data: recipientId, error: recipientLookupError } = await supabaseAdmin.rpc(
        'find_user_id_by_email',
        { p_email: recipientEmail }
      );

      if (recipientLookupError || !recipientId) {
        return res.status(404).json({ error: 'Recipient user not found.' });
      }

      resolvedRecipientUserId = recipientId;
    }

    if (req.user.id === resolvedRecipientUserId) {
      return res.status(400).json({ error: 'Sender and receiver must be different users.' });
    }

    const { data: senderProfile, error: senderProfileError } = await supabaseAdmin
      .from('profiles')
      .select('pin_hash,pin_failed_attempts,pin_locked_until')
      .eq('id', req.user.id)
      .single();

    if (senderProfileError || !senderProfile?.pin_hash) {
      return res.status(400).json({ error: 'PIN is not configured for this user.' });
    }

    const now = Date.now();
    if (senderProfile.pin_locked_until && new Date(senderProfile.pin_locked_until).getTime() > now) {
      await logAuditEvent(supabaseAdmin, {
        userId: req.user.id,
        action: 'transfer',
        resourceType: 'wallet',
        resourceId: resolvedRecipientUserId ?? null,
        ip: req.ip ?? null,
        success: false,
        metadata: {
          reason: 'pin_locked',
          locked_until: senderProfile.pin_locked_until,
          amount,
          recipient_user_id: resolvedRecipientUserId ?? null
        }
      });

      return res.status(403).json({ error: 'PIN is locked due to too many failed attempts. Please try again later.' });
    }

    const pinOk = verifyPin(pin, senderProfile.pin_hash);

    if (!pinOk) {
      const maxAttempts = 5;
      const lockDurationMinutes = 15;
      const currentAttempts = senderProfile.pin_failed_attempts ?? 0;
      const nextAttempts = currentAttempts + 1;
      const shouldLock = nextAttempts >= maxAttempts;
      const lockedUntil = shouldLock
        ? new Date(Date.now() + lockDurationMinutes * 60_000).toISOString()
        : senderProfile.pin_locked_until ?? null;

      await supabaseAdmin
        .from('profiles')
        .update({
          pin_failed_attempts: nextAttempts,
          pin_locked_until: lockedUntil
        })
        .eq('id', req.user.id);

      await logAuditEvent(supabaseAdmin, {
        userId: req.user.id,
        action: 'transfer',
        resourceType: 'wallet',
        resourceId: resolvedRecipientUserId ?? null,
        ip: req.ip ?? null,
        success: false,
        metadata: {
          reason: 'invalid_pin',
          attempts: nextAttempts,
          locked_until: lockedUntil,
          amount,
          recipient_user_id: resolvedRecipientUserId ?? null
        }
      });

      return res.status(401).json({ error: 'Invalid PIN.' });
    }

    // Successful PIN verification: reset failure counters.
    await supabaseAdmin
      .from('profiles')
      .update({ pin_failed_attempts: 0, pin_locked_until: null })
      .eq('id', req.user.id);

    const { data: senderWallet, error: senderWalletError } = await supabaseAdmin
      .from('wallets')
      .select('balance,status')
      .eq('user_id', req.user.id)
      .single();

    if (senderWalletError || !senderWallet) {
      return res.status(404).json({ error: 'Sender wallet not found.' });
    }

    if (senderWallet.status !== 'active') {
      return res.status(403).json({ error: 'Sender wallet is not active.' });
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
      await logAuditEvent(supabaseAdmin, {
        userId: req.user.id,
        action: 'transfer',
        resourceType: 'wallet',
        resourceId: resolvedRecipientUserId ?? null,
        ip: req.ip ?? null,
        success: false,
        metadata: {
          reason: 'transfer_failed',
          supabase_error: error.message,
          amount,
          recipient_user_id: resolvedRecipientUserId ?? null
        }
      });

      return res.status(400).json({ error: error.message });
    }

    const transaction = data?.[0] ?? null;

    if (!transaction || transaction.status !== 'completed') {
      await logAuditEvent(supabaseAdmin, {
        userId: req.user.id,
        action: 'transfer',
        resourceType: 'wallet',
        resourceId: resolvedRecipientUserId ?? null,
        ip: req.ip ?? null,
        success: false,
        metadata: {
          reason: 'transfer_failed',
          amount,
          recipient_user_id: resolvedRecipientUserId ?? null,
          transaction_id: transaction?.transaction_id ?? null
        }
      });

      return res.status(400).json({ error: 'Transfer failed. Please try again.' });
    }

    await logAuditEvent(supabaseAdmin, {
      userId: req.user.id,
      action: 'transfer',
      resourceType: 'wallet',
      resourceId: resolvedRecipientUserId ?? null,
      ip: req.ip ?? null,
      success: true,
      metadata: {
        amount,
        recipient_user_id: resolvedRecipientUserId ?? null,
        transaction_id: transaction.transaction_id
      }
    });

    return res.status(201).json({ transaction });
  });

  return router;
}
