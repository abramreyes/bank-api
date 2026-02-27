import { Router } from 'express';

export function authRouter({ supabaseAdmin, supabaseAnon }) {
  const router = Router();

  router.post('/sign-up', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const { data, error } = await supabaseAnon.auth.signUp({ email, password });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      user: data.user,
      session: data.session,
      message: 'Sign-up successful. Check email confirmation settings in Supabase.'
    });
  });

  router.post('/sign-in', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    return res.json({ user: data.user, session: data.session });
  });

  router.get('/me', async (req, res) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing Bearer token.' });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    return res.json({ user: data.user });
  });

  return router;
}
