import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { AddressInfo } from 'node:net';
import { transactionsRouter } from '../src/routes/transactions.js';

function hashPin(pin: string) {
  const salt = 'testsalt';
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function createFakeSupabase(options: any = {}) {
  const senderId = options.senderId ?? 'user-sender';
  const recipientId = options.recipientId ?? 'user-recipient';
  const state = {
    rpcCalls: 0,
    tokens: new Map([[options.token ?? 'token-1', senderId]]),
    profiles: new Map([
      [
        senderId,
        {
          id: senderId,
          pin_hash: hashPin(options.correctPin ?? '123456'),
          pin_failed_attempts: 0,
          pin_locked_until: null
        }
      ]
    ]),
    wallets: new Map([
      [senderId, { wallet_id: 'wallet-sender', user_id: senderId, balance: options.senderBalance ?? 100, status: options.senderStatus ?? 'active' }],
      [recipientId, { wallet_id: 'wallet-recipient', user_id: recipientId, balance: options.recipientBalance ?? 0, status: options.recipientStatus ?? 'active' }]
    ]),
    auditLogs: [] as any[],
    transfersByFingerprint: new Map<string, any>(),
    transferInFlight: false
  };

  const supabaseAdmin: any = {
    auth: {
      async getUser(token: string) {
        const userId = state.tokens.get(token);
        if (!userId) return { data: { user: null }, error: { message: 'invalid token' } };
        return { data: { user: { id: userId } }, error: null };
      }
    },
    from(table: string) {
      if (table === 'profiles') {
        return {
          select() {
            return {
              eq(column: string, value: string) {
                return {
                  async single() {
                    if (column !== 'id') return { data: null, error: { message: 'unsupported profile query' } };
                    const profile = state.profiles.get(value);
                    return profile ? { data: profile, error: null } : { data: null, error: { message: 'not found' } };
                  }
                };
              }
            };
          },
          update(patch: any) {
            return {
              async eq(column: string, value: string) {
                if (column !== 'id') return { data: null, error: { message: 'unsupported profile update query' } };
                const current = state.profiles.get(value);
                if (!current) return { data: null, error: { message: 'not found' } };
                state.profiles.set(value, { ...current, ...patch });
                return { data: null, error: null };
              }
            };
          }
        };
      }

      if (table === 'wallets') {
        return {
          select() {
            return {
              eq(column: string, value: string) {
                return {
                  async single() {
                    if (column !== 'user_id') return { data: null, error: { message: 'unsupported wallet query' } };
                    const wallet = state.wallets.get(value);
                    return wallet ? { data: wallet, error: null } : { data: null, error: { message: 'wallet not found' } };
                  }
                };
              }
            };
          }
        };
      }

      if (table === 'audit_logs') {
        return {
          async insert(row: any) {
            state.auditLogs.push(row);
            return { data: null, error: null };
          }
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc(name: string, args: any) {
      assert.equal(name, 'post_wallet_transfer');
      state.rpcCalls += 1;

      if (options.rpcImpl) {
        return options.rpcImpl({ state, args });
      }

      const recipientWallet = state.wallets.get(args.p_recipient_user_id);
      if (!recipientWallet) {
        return { data: null, error: { message: 'recipient wallet not found' } };
      }

      const senderWallet = state.wallets.get(args.p_sender_user_id);
      if (!senderWallet) {
        return { data: null, error: { message: 'sender wallet not found' } };
      }

      if (Number(senderWallet.balance) < Number(args.p_amount)) {
        return { data: null, error: { message: 'insufficient funds' } };
      }

      senderWallet.balance -= Number(args.p_amount);
      recipientWallet.balance += Number(args.p_amount);

      return {
        data: [
          {
            transaction_id: `txn-${state.rpcCalls}`,
            sender_wallet_id: senderWallet.wallet_id,
            recipient_wallet_id: recipientWallet.wallet_id,
            amount: Number(args.p_amount),
            status: 'completed',
            created_at: new Date().toISOString()
          }
        ],
        error: null
      };
    }
  };

  return { supabaseAdmin, state, senderId, recipientId, token: options.token ?? 'token-1' };
}

async function createServer(fake: any) {
  const app = express();
  app.use(express.json());
  app.use('/transactions', transactionsRouter({ supabaseAdmin: fake.supabaseAdmin }));

  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => server.close((err: any) => (err ? reject(err) : resolve())))
  };
}

async function transfer(baseUrl: string, token: string, body: any) {
  return fetch(`${baseUrl}/transactions/transfer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

test('transfer success', async () => {
  const fake = createFakeSupabase();
  const srv = await createServer(fake);

  const response = await transfer(srv.baseUrl, fake.token, {
    recipient_user_id: fake.recipientId,
    amount: 25,
    pin: '123456'
  });

  assert.equal(response.status, 201);
  const payload: any = await response.json();
  assert.equal(payload.transaction.status, 'completed');
  assert.equal(fake.state.rpcCalls, 1);

  await srv.close();
});

test('insufficient funds', async () => {
  const fake = createFakeSupabase({ senderBalance: 10 });
  const srv = await createServer(fake);

  const response = await transfer(srv.baseUrl, fake.token, {
    recipient_user_id: fake.recipientId,
    amount: 50,
    pin: '123456'
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Insufficient balance.' });
  assert.equal(fake.state.rpcCalls, 0);

  await srv.close();
});

test('recipient not found', async () => {
  const fake = createFakeSupabase();
  const srv = await createServer(fake);

  const response = await transfer(srv.baseUrl, fake.token, {
    recipient_user_id: 'missing-recipient',
    amount: 10,
    pin: '123456'
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'recipient wallet not found' });

  await srv.close();
});

test('sender equals recipient', async () => {
  const fake = createFakeSupabase();
  const srv = await createServer(fake);

  const response = await transfer(srv.baseUrl, fake.token, {
    recipient_user_id: fake.senderId,
    amount: 10,
    pin: '123456'
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Sender and receiver must be different users.' });
  assert.equal(fake.state.rpcCalls, 0);

  await srv.close();
});

test('frozen wallet cannot transfer', async () => {
  const fake = createFakeSupabase({ senderStatus: 'frozen' });
  const srv = await createServer(fake);

  const response = await transfer(srv.baseUrl, fake.token, {
    recipient_user_id: fake.recipientId,
    amount: 10,
    pin: '123456'
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Sender wallet is not active.' });
  assert.equal(fake.state.rpcCalls, 0);

  await srv.close();
});

test('wrong pin locks after 5 attempts', async () => {
  const fake = createFakeSupabase();
  const srv = await createServer(fake);

  for (let i = 0; i < 5; i += 1) {
    const response = await transfer(srv.baseUrl, fake.token, {
      recipient_user_id: fake.recipientId,
      amount: 1,
      pin: '000000'
    });
    assert.equal(response.status, 401);
  }

  const lockedResponse = await transfer(srv.baseUrl, fake.token, {
    recipient_user_id: fake.recipientId,
    amount: 1,
    pin: '123456'
  });

  assert.equal(lockedResponse.status, 403);
  const profile = fake.state.profiles.get(fake.senderId);
  assert.equal(profile.pin_failed_attempts, 5);
  assert.ok(profile.pin_locked_until);

  await srv.close();
});

test('double tap duplicate transfer (idempotency behavior)', async () => {
  const fake = createFakeSupabase({
    rpcImpl: ({ state, args }: any) => {
      const key = `${args.p_sender_user_id}:${args.p_recipient_user_id}:${args.p_amount}`;
      const prior = state.transfersByFingerprint.get(key);
      if (prior) {
        return {
          data: [
            {
              transaction_id: prior.transaction_id,
              sender_wallet_id: prior.sender_wallet_id,
              recipient_wallet_id: prior.recipient_wallet_id,
              amount: prior.amount,
              status: 'failed',
              created_at: prior.created_at
            }
          ],
          error: null
        };
      }

      const transaction = {
        transaction_id: 'txn-first',
        sender_wallet_id: 'wallet-sender',
        recipient_wallet_id: 'wallet-recipient',
        amount: Number(args.p_amount),
        status: 'completed',
        created_at: new Date().toISOString()
      };

      state.transfersByFingerprint.set(key, transaction);
      return { data: [transaction], error: null };
    }
  });

  const srv = await createServer(fake);
  const payload = { recipient_user_id: fake.recipientId, amount: 7, pin: '123456' };

  const first = await transfer(srv.baseUrl, fake.token, payload);
  const second = await transfer(srv.baseUrl, fake.token, payload);

  assert.equal(first.status, 201);
  assert.equal(second.status, 400);
  assert.deepEqual(await second.json(), { error: 'Transfer failed. Please try again.' });

  await srv.close();
});

test('two concurrent transfers from same sender (race condition handling)', async () => {
  const fake = createFakeSupabase({
    senderBalance: 100,
    rpcImpl: async ({ state, args }: any) => {
      const amount = Number(args.p_amount);
      while (state.transferInFlight) {
        await new Promise((r) => setTimeout(r, 5));
      }
      state.transferInFlight = true;
      try {
        const senderWallet = state.wallets.get(args.p_sender_user_id);
        const recipientWallet = state.wallets.get(args.p_recipient_user_id);
        if (!senderWallet || !recipientWallet) {
          return { data: null, error: { message: 'wallet not found' } };
        }

        if (senderWallet.balance < amount) {
          return { data: null, error: { message: 'insufficient funds' } };
        }

        senderWallet.balance -= amount;
        recipientWallet.balance += amount;

        return {
          data: [
            {
              transaction_id: `txn-race-${Date.now()}`,
              sender_wallet_id: senderWallet.wallet_id,
              recipient_wallet_id: recipientWallet.wallet_id,
              amount,
              status: 'completed',
              created_at: new Date().toISOString()
            }
          ],
          error: null
        };
      } finally {
        state.transferInFlight = false;
      }
    }
  });

  const srv = await createServer(fake);
  const payload = { recipient_user_id: fake.recipientId, amount: 80, pin: '123456' };

  const [first, second] = await Promise.all([
    transfer(srv.baseUrl, fake.token, payload),
    transfer(srv.baseUrl, fake.token, payload)
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 400]);

  await srv.close();
});
