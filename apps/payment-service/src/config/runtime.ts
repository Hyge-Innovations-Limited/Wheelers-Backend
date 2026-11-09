import { loadWorkspaceEnv, startAlerts } from '@wheleers/config';

const SERVICE_ID = 'payment-service';

export function applyPaymentServiceDefaults(): void {
  loadWorkspaceEnv();
  startAlerts();
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:29092';
}

export function getPaymentServiceId(): string {
  return SERVICE_ID;
}
