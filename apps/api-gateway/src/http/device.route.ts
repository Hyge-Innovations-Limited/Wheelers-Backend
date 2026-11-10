import type { IncomingMessage, ServerResponse } from 'http';
import { userDeviceClient, deviceKey } from '@wheleers/db';
import { verifyWalletPageToken } from '../auth/local';
import { appReport, shouldRecord, webReport } from '../devices/device-report';
import { authenticateHttpUser, extractBearerToken } from './authenticate';
import { readJsonBody, sendJson } from './utils';

/**
 * The devices a person uses, for their admin profile (collected only):
 *
 *   POST /device/web   from our web pages, with the page's own link token (ride, wallet; never a Trip chat
 *                      link, which is shared with other people): the browser's report + its User-Agent
 *   POST /device/app   from the app, signed in: system, its version, maker, model, app version and build
 *
 * Always answers 204 quickly; a report that cannot be stored is dropped (it never gets in the way of a page).
 */
export async function handleDeviceRoute(req: IncomingMessage, res: ServerResponse, deps: { jwtSecret: string }, url: URL): Promise<boolean> {
  if (url.pathname !== '/device/web' && url.pathname !== '/device/app') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  let userId: string;
  try {
    if (url.pathname === '/device/web') {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) throw new Error('no link');
      const session = verifyWalletPageToken(token, deps.jwtSecret);
      if (session.scope === 'trip') {
        res.statusCode = 204;
        res.end();
        return true;
      }
      userId = session.userId;
    } else {
      userId = (await authenticateHttpUser(req, deps.jwtSecret)).id;
    }
  } catch {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  const body = await readJsonBody(req).catch(() => null);
  const report = url.pathname === '/device/web' ? webReport(body, req.headers['user-agent']) : appReport(body);
  if (shouldRecord(userId, deviceKey(report))) {
    await userDeviceClient.record(userId, report).catch((error) => {
      console.warn('[device] could not record', { error: error instanceof Error ? error.message : String(error) });
    });
  }
  res.statusCode = 204;
  res.end();
  return true;
}
