import { validateSharedEnv, validatePaymentEnv } from '@wheleers/config';
import {
  createConsumer,
  createProducer,
  onShutdown,
  registerShutdownHandlers,
} from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';
import { PaymentsClient } from '@wheleers/payments';
import { createPaymentEventsConsumer } from './consumers/payment-events.consumer';
import { applyPaymentServiceDefaults, getPaymentServiceId } from './config/runtime';
import { createPaymentEventsHandler } from './handlers/payment-events.handler';
import { startPayoutReconciliation } from './handlers/payout-reconciliation';
import { createPaymentEventsProducer } from './producers/payment-events.producer';

export async function startPaymentService(): Promise<void> {
  applyPaymentServiceDefaults();

  const serviceId = getPaymentServiceId();
  registerShutdownHandlers(serviceId);

  validateSharedEnv();
  const paymentEnv = validatePaymentEnv();

  const producer = await createProducer({ serviceId });
  const consumer = await createConsumer({ groupId: serviceId });

  onShutdown(async () => {
    await producer.disconnect();
  });

  onShutdown(async () => {
    await consumer.disconnect();
  });

  const paymentsClient = new PaymentsClient({
    secretKey: paymentEnv.PAYSTACK_SECRET_KEY,
    baseUrl: paymentEnv.PAYSTACK_BASE_URL,
    dvaBank: paymentEnv.PAYSTACK_DVA_BANK,
    emailDomain: paymentEnv.PAYSTACK_CUSTOMER_EMAIL_DOMAIN,
  });

  // Producer is wired up for other services (e.g. api-gateway) that may
  // import it, but the handler itself only logs for now.
  createPaymentEventsProducer(producer);

  const paymentEventsHandler = createPaymentEventsHandler({
    paymentsClient,
    serviceId,
  });
  const paymentEventsConsumer = createPaymentEventsConsumer({
    paymentEventsHandler,
  });

  await consumer.subscribe(
    [TOPICS.PAYMENT_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.PAYMENT_EVENTS) {
        await paymentEventsConsumer.handle(value, ctx);
      }
    },
  );

  const stopReconciliation = startPayoutReconciliation(paymentsClient);
  onShutdown(async () => {
    stopReconciliation();
  });

  console.log(`[${serviceId}] consuming`);
}
