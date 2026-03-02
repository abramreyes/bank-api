function buildOtpMessage(otp: string) {
  return `Your bank-api verification code is ${otp}. It expires in 10 minutes.`;
}

type SendOtpParams = {
  to: string;
  otp: string;
};

type SendOtpResult = {
  provider: 'twilio' | 'mock';
  messageSid?: string;
};

export type SmsProvider = {
  sendOtp(params: SendOtpParams): Promise<SendOtpResult>;
};

type SmsConfig = {
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  twilioMessagingServiceSid?: string;
};

function createMockSmsProvider(): SmsProvider {
  return {
    async sendOtp({ to, otp }) {
      console.log(`[mock-sms] to=${to} otp=${otp}`);
      return { provider: 'mock' };
    }
  };
}

function createTwilioSmsProvider(config: Required<Pick<SmsConfig, 'twilioAccountSid' | 'twilioAuthToken'>> & SmsConfig): SmsProvider {
  return {
    async sendOtp({ to, otp }) {
      const body = new URLSearchParams({
        To: to,
        Body: buildOtpMessage(otp)
      });

      if (config.twilioMessagingServiceSid) {
        body.set('MessagingServiceSid', config.twilioMessagingServiceSid);
      } else if (config.twilioFromNumber) {
        body.set('From', config.twilioFromNumber);
      }

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${config.twilioAccountSid}:${config.twilioAuthToken}`
            ).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body
        }
      );

      const payload = await response.json();

      if (!response.ok) {
        const reason = payload?.message ?? 'Twilio request failed.';
        throw new Error(reason);
      }

      return {
        provider: 'twilio',
        messageSid: payload?.sid
      };
    }
  };
}

export function createSmsProvider(config: SmsConfig): SmsProvider {
  const accountSid = config.twilioAccountSid?.trim();
  const authToken = config.twilioAuthToken?.trim();
  const fromNumber = config.twilioFromNumber?.trim();
  const messagingServiceSid = config.twilioMessagingServiceSid?.trim();

  if (!accountSid || !authToken) {
    return createMockSmsProvider();
  }

  if (!fromNumber && !messagingServiceSid) {
    console.warn(
      'Twilio credentials configured but neither TWILIO_FROM_NUMBER nor TWILIO_MESSAGING_SERVICE_SID is set. Falling back to mock SMS provider.'
    );
    return createMockSmsProvider();
  }

  return createTwilioSmsProvider({
    twilioAccountSid: accountSid,
    twilioAuthToken: authToken,
    twilioFromNumber: fromNumber,
    twilioMessagingServiceSid: messagingServiceSid
  });
}
