import type { FlowRequestBody } from './encryption';

/**
 * What a form request means. Every screen has ONE Continue button, so the screen
 * Meta names on every data_exchange request says what was asked — no need to read
 * it off the shape of the fields. The payload's own `action` tag is only the
 * fallback for a request whose screen is not in the map.
 *
 * INIT, BACK and ping carry no action; the caller shows the entry screen.
 */
export function actionFor(body: FlowRequestBody, actionByScreen: Readonly<Record<string, string>>): string | null {
  if (body.action !== 'data_exchange') return null;
  const fromScreen = body.screen ? actionByScreen[body.screen] : undefined;
  if (fromScreen) return fromScreen;
  const tagged = body.data?.['action'];
  return typeof tagged === 'string' ? tagged : null;
}
