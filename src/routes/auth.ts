import crypto from 'crypto';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logAuditEvent } from '../lib/audit.js';

const OTP_TTL_MINUTES = 10;
const OTP_SEND_COOLDOWN_SECONDS = 30;
const OTP_SEND_WINDOW_MS = 10 * 60_000;
const OTP_SEND_MAX_PER_USER_WINDOW = 5;
const OTP_SEND_MAX_PER_IP_WINDOW = 20;

function isValidPin(pin) {
  return /^\d{6}$/.test(pin);
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function hashOtp(otp, userId) {
  return crypto.createHash('sha256').update(`${userId}:${otp}`).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function isLikelyE164Phone(value) {
  return /^\+[1-9]\d{7,14}$/.test(value ?? '');
}

async function countOtpSendAttempts({ supabaseAdmin, userId, ip, windowStart }) {
  const userCountQuery = supabaseAdmin
    .from('otp_send_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', windowStart);

  const ipCountQuery = supabaseAdmin
    .from('otp_send_attempts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', windowStart);

  if (ip) {
    ipCountQuery.eq('ip', ip);
  } else {
    ipCountQuery.is('ip', null);
  }

  const [
    { count: userAttemptsInWindow, error: userAttemptsError },
    { count: ipAttemptsInWindow, error: ipAttemptsError }
  ] = await Promise.all([userCountQuery, ipCountQuery]);

  if (userAttemptsError || ipAttemptsError) {
    throw new Error('Failed to check OTP rate limit.');
  }

  return {
    userAttemptsInWindow: userAttemptsInWindow ?? 0,
    ipAttemptsInWindow: ipAttemptsInWindow ?? 0
  };
}

export function authRouter({ supabaseAdmin, supabaseAnon, smsProvider }) {
  const router = Router();

  router.post('/sign-up', async (req, res) => {
    const { email, password, phone } = req.body;

    if (!email || !password || !phone) {
      return res.status(400).json({ error: 'email, password, and phone are required.' });
    }

    const { data, error } = await supabaseAnon.auth.signUp({ email, password });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    if (data.user) {
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .update({ phone, biometric_enabled: false, basic_verification_complete: false })
        .eq('id', data.user.id);

      if (profileError) {
        return res.status(500).json({ error: profileError.message });
      }
    }

    return res.status(201).json({
      user: data.user,
      session: data.session,
      message: 'Sign-up successful. Continue onboarding with OTP verification and PIN setup.'
    });
  });

  router.post('/sign-in', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const normalizedEmail = email.toLowerCase();
    const ip = req.ip ?? null;
    const windowMs = 60_000;
    const maxAttempts = 5;
    const windowStart = new Date(Date.now() - windowMs).toISOString();

    const {
      count: attemptsInWindow,
      error: attemptsError
    } = await supabaseAdmin
      .from('login_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('email', normalizedEmail)
      .eq('ip', ip)
      .gte('created_at', windowStart);

    if (attemptsError) {
      return res.status(500).json({ error: 'Failed to check login rate limit.' });
    }

    if ((attemptsInWindow ?? 0) >= maxAttempts) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }

    // Record this attempt regardless of outcome so retries are limited.
    await supabaseAdmin.from('login_attempts').insert({
      email: normalizedEmail,
      ip
    });

    const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

    if (error) {
      await logAuditEvent(supabaseAdmin, {
        userId: null,
        action: 'login',
        resourceType: 'auth',
        resourceId: normalizedEmail,
        ip,
        success: false,
        metadata: { error: error.message }
      });

      return res.status(401).json({ error: error.message });
    }

    await logAuditEvent(supabaseAdmin, {
      userId: data.user.id,
      action: 'login',
      resourceType: 'auth',
      resourceId: data.user.id,
      ip,
      success: true,
      metadata: { email: normalizedEmail }
    });

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

  router.post('/onboarding/send-otp', requireAuth(supabaseAdmin), async (req, res) => {
    const ip = req.ip ?? null;
    const now = Date.now();
    const windowStart = new Date(now - OTP_SEND_WINDOW_MS).toISOString();
    const otp = generateOtp();
    const otpHash = hashOtp(otp, req.user.id);
    const expiresAt = new Date(now + OTP_TTL_MINUTES * 60_000).toISOString();
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('phone')
      .eq('id', req.user.id)
      .single();

    if (profileError) {
      return res.status(500).json({ error: profileError.message });
    }

    if (!profile?.phone) {
      return res.status(400).json({ error: 'No phone number found for this user.' });
    }

    if (!isLikelyE164Phone(profile.phone)) {
      return res.status(400).json({ error: 'Phone number must be in E.164 format (example: +15555550123).' });
    }

    const { data: lastAttempt, error: lastAttemptError } = await supabaseAdmin
      .from('otp_send_attempts')
      .select('created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastAttemptError) {
      return res.status(500).json({ error: 'Failed to check OTP cooldown.' });
    }

    if (lastAttempt?.created_at) {
      const secondsSinceLastAttempt = Math.floor((now - new Date(lastAttempt.created_at).getTime()) / 1000);
      if (secondsSinceLastAttempt < OTP_SEND_COOLDOWN_SECONDS) {
        const retryAfterSeconds = OTP_SEND_COOLDOWN_SECONDS - secondsSinceLastAttempt;
        res.setHeader('Retry-After', retryAfterSeconds);
        return res.status(429).json({
          error: `Please wait ${retryAfterSeconds}s before requesting another OTP.`
        });
      }
    }

    try {
      const { userAttemptsInWindow, ipAttemptsInWindow } = await countOtpSendAttempts({
        supabaseAdmin,
        userId: req.user.id,
        ip,
        windowStart
      });

      if (userAttemptsInWindow >= OTP_SEND_MAX_PER_USER_WINDOW) {
        res.setHeader('Retry-After', Math.ceil(OTP_SEND_WINDOW_MS / 1000));
        return res.status(429).json({
          error: 'Too many OTP requests for this user. Please try again later.'
        });
      }

      if (ipAttemptsInWindow >= OTP_SEND_MAX_PER_IP_WINDOW) {
        res.setHeader('Retry-After', Math.ceil(OTP_SEND_WINDOW_MS / 1000));
        return res.status(429).json({
          error: 'Too many OTP requests from this IP. Please try again later.'
        });
      }
    } catch (rateLimitError) {
      return res.status(500).json({
        error: rateLimitError instanceof Error ? rateLimitError.message : 'Failed to check OTP rate limit.'
      });
    }

    const { error: attemptInsertError } = await supabaseAdmin.from('otp_send_attempts').insert({
      user_id: req.user.id,
      ip,
      phone: profile.phone
    });

    if (attemptInsertError) {
      return res.status(500).json({ error: 'Failed to record OTP send attempt.' });
    }

    const { error } = await supabaseAdmin.from('onboarding_otps').upsert(
      {
        user_id: req.user.id,
        otp_hash: otpHash,
        expires_at: expiresAt,
        attempts: 0
      },
      { onConflict: 'user_id' }
    );

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    try {
      const smsResult = await smsProvider.sendOtp({ to: profile.phone, otp });
      const includeTestOtp = process.env.NODE_ENV !== 'production' && smsResult.provider !== 'twilio';

      return res.json({
        message: `OTP sent via ${smsResult.provider} SMS provider.`,
        otp_expires_at: expiresAt,
        provider: smsResult.provider,
        message_sid: smsResult.messageSid,
        test_otp: includeTestOtp ? otp : undefined
      });
    } catch (smsError) {
      return res.status(502).json({
        error: smsError instanceof Error ? smsError.message : 'Failed to deliver OTP via SMS provider.'
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    router.post('/onboarding/test-sms', requireAuth(supabaseAdmin), async (req, res) => {
      const otp = generateOtp();
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('phone')
        .eq('id', req.user.id)
        .single();

      if (profileError) {
        return res.status(500).json({ error: profileError.message });
      }

      if (!profile?.phone) {
        return res.status(400).json({ error: 'No phone number found for this user.' });
      }

      if (!isLikelyE164Phone(profile.phone)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format (example: +15555550123).' });
      }

      try {
        const smsResult = await smsProvider.sendOtp({ to: profile.phone, otp });
        const includeTestOtp = process.env.NODE_ENV !== 'production' && smsResult.provider !== 'twilio';

        return res.json({
          message: `Test SMS sent via ${smsResult.provider} SMS provider.`,
          to: profile.phone,
          provider: smsResult.provider,
          message_sid: smsResult.messageSid,
          test_otp: includeTestOtp ? otp : undefined
        });
      } catch (smsError) {
        return res.status(502).json({
          error: smsError instanceof Error ? smsError.message : 'Failed to send test SMS via provider.'
        });
      }
    });
  }

  router.post('/onboarding/verify-otp', requireAuth(supabaseAdmin), async (req, res) => {
    const { otp } = req.body;

    if (!/^\d{6}$/.test(otp ?? '')) {
      return res.status(400).json({ error: 'otp must be a 6-digit code.' });
    }

    const { data: challenge, error: challengeError } = await supabaseAdmin
      .from('onboarding_otps')
      .select('otp_hash,expires_at,attempts')
      .eq('user_id', req.user.id)
      .single();

    if (challengeError || !challenge) {
      return res.status(400).json({ error: 'No OTP challenge found. Request a new OTP.' });
    }

    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'OTP expired. Request a new OTP.' });
    }

    const otpHash = hashOtp(otp, req.user.id);

    if (otpHash !== challenge.otp_hash) {
      await supabaseAdmin
        .from('onboarding_otps')
        .update({ attempts: (challenge.attempts ?? 0) + 1 })
        .eq('user_id', req.user.id);

      return res.status(401).json({ error: 'Invalid OTP.' });
    }

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({
        phone_verified_at: new Date().toISOString(),
        basic_verification_complete: true
      })
      .eq('id', req.user.id);

    if (profileError) {
      return res.status(500).json({ error: profileError.message });
    }

    await supabaseAdmin.from('onboarding_otps').delete().eq('user_id', req.user.id);

    return res.json({ message: 'OTP verified. Basic Verification Complete.' });
  });

  router.post('/onboarding/set-pin', requireAuth(supabaseAdmin), async (req, res) => {
    const { pin } = req.body;

    if (!isValidPin(pin ?? '')) {
      return res.status(400).json({ error: 'pin must be a 6-digit string.' });
    }

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ pin_hash: hashPin(pin), pin_set_at: new Date().toISOString() })
      .eq('id', req.user.id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ message: 'PIN setup complete.' });
  });

  router.post('/onboarding/biometric', requireAuth(supabaseAdmin), async (req, res) => {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean.' });
    }

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ biometric_enabled: enabled })
      .eq('id', req.user.id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ message: `Biometric preference ${enabled ? 'enabled' : 'disabled'}.` });
  });

  router.get('/onboarding/status', requireAuth(supabaseAdmin), async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('phone,phone_verified_at,pin_set_at,biometric_enabled,basic_verification_complete')
      .eq('id', req.user.id)
      .single();

    if (error) {
      return res.status(404).json({ error: error.message });
    }

    return res.json({ onboarding: data });
  });

  return router;
}
