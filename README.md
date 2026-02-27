# bank-api

Starter Node.js + Express API for a digital banking mobile application backend using:

- **Supabase Auth** (email + password)
- **Supabase Postgres migrations** for core banking tables
- **JWT-protected routes** using Supabase access tokens
- **Vercel-ready serverless deployment** for temporary hosting

## 1) Prerequisites

- Node.js 20+
- npm 10+
- Supabase project (cloud or local)
- (Optional) [Supabase CLI](https://supabase.com/docs/guides/cli)
- (Optional) [Vercel CLI](https://vercel.com/docs/cli)

## 2) Install dependencies

```bash
npm install
```

## 3) Configure environment variables

Set these variables in your shell, Vercel project settings, or process manager before running the API:

- `PORT` (optional, local runtime only, defaults to `4000`)
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Example for local shell:

```bash
export PORT=4000
export SUPABASE_URL="https://YOUR_PROJECT_ID.supabase.co"
export SUPABASE_ANON_KEY="your-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
```

> Vercel note: set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in Project Settings → Environment Variables.

## 4) Apply database migrations

If using Supabase CLI:

```bash
supabase migration up
```

This creates:

- `profiles` table (1:1 with `auth.users`)
- `accounts` table (1 account per user)
- `transactions` table
- RLS policies for owner-scoped reads
- Trigger that auto-creates profile + account when a new auth user signs up

Migration file: `supabase/migrations/202602270001_init_bank_schema.sql`

## 5) Run the API locally

Development:

```bash
npm run dev
```

Production/local run:

```bash
npm start
```

## 6) Deploy to Vercel (temporary hosting)

This repo is configured with `vercel.json` and `api/index.js` so all routes map to the Express app as a serverless function.

### Option A: Vercel dashboard

1. Import this repository into Vercel.
2. Set environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Deploy.

### Option B: Vercel CLI

```bash
vercel
```

For production deployment:

```bash
vercel --prod
```

## API endpoints

### Health

- `GET /health`

### Auth (Supabase Auth)

- `POST /auth/sign-up`
  - body: `{ "email": "user@email.com", "password": "strong-password" }`
- `POST /auth/sign-in`
  - body: `{ "email": "user@email.com", "password": "strong-password" }`
- `GET /auth/me`
  - header: `Authorization: Bearer <access_token>`

### Account

- `GET /accounts/me`
  - header: `Authorization: Bearer <access_token>`

## Notes

- Email confirmation behavior depends on your Supabase Auth settings.
- For local Supabase stack, see `supabase/config.toml`.
- For Vercel, avoid long-running background jobs in this API process; use separate workers/queues when needed.
