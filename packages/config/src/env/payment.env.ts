import { z } from 'zod';

const PaymentEnvSchema = z.object({
  // Paystack: dedicated deposit accounts, transfers, and the webhook that
  // reports both. One secret key signs requests AND webhook bodies.
  PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, 'must be a Paystack secret key (sk_test_… or sk_live_…)'),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  // Which bank issues deposit accounts on a LIVE key. Test keys always use
  // Paystack's "test-bank", whatever this says.
  PAYSTACK_DVA_BANK: z.enum(['wema-bank', 'titan-paystack']).default('wema-bank'),
  PAYSTACK_CUSTOMER_EMAIL_DOMAIN: z.string().min(3).default('users.wheelersng.com'),
});

export type PaymentEnv = z.infer<typeof PaymentEnvSchema>;

export function validatePaymentEnv(): PaymentEnv {
  const result = PaymentEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] payment-service env errors:\n', result.error.format());
    process.exit(1);
  }
  return result.data;
}
