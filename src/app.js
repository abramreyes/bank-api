import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createSupabaseClients } from './lib/supabase.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { accountsRouter } from './routes/accounts.js';

export function createApp(config) {
  const { admin: supabaseAdmin, anon: supabaseAnon } = createSupabaseClients(config);

  const app = express();

  app.use(cors());
  app.use(morgan('dev'));
  app.use(express.json());

  app.use('/health', healthRouter());
  app.use('/auth', authRouter({ supabaseAdmin, supabaseAnon }));
  app.use('/accounts', accountsRouter({ supabaseAdmin }));

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
