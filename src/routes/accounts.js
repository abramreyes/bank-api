import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

export function accountsRouter({ supabaseAdmin }) {
  const router = Router();

  router.get('/me', requireAuth(supabaseAdmin), async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('accounts')
      .select('id,balance,currency,created_at')
      .eq('user_id', req.user.id)
      .single();

    if (error) {
      return res.status(404).json({ error: error.message });
    }

    return res.json({ account: data });
  });

  return router;
}
