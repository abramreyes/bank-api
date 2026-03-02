import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

export function walletsRouter({ supabaseAdmin }) {
  const router = Router();

  router.get('/me', requireAuth(supabaseAdmin), async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('wallets')
      .select('wallet_id,user_id,balance,status,currency,created_at,updated_at')
      .eq('user_id', req.user.id)
      .single();

    if (error) {
      return res.status(404).json({ error: error.message });
    }

    return res.json({ wallet: data });
  });

  return router;
}
