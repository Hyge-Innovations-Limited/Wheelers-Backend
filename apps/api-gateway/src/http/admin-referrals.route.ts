import type { IncomingMessage, ServerResponse } from 'http';
import { adminReferralsClient, isDay, lagosToday, periodDays, REFERRAL_RULES, REFERRAL_STATUSES } from '@wheleers/db';
import type { ReferralStatusName } from '@wheleers/db';
import { verifyAdminAuth } from './admin-auth.route';
import { sendJson } from './utils';

/**
 * The admin Referrals page: who brought whom, whether the friend rode, and the
 * cashback it earned.
 *
 *   GET /admin/referrals?from=&to=&status=&q=&limit=&offset=
 *   GET /admin/referrals/codes?q=&sort=referred|newest|cashback&limit=&offset=   everyone with a code, all time
 *   GET /admin/referrals/people/:userId                                          one person: code, friends, cashback
 *
 * from and to are Lagos days, both included (default: the last 30 days), and
 * count referrals by the day the code was used. q is a name, phone number or
 * code of either person. Owners and staff; support never gets here.
 */

interface Deps {
  adminApiKey: string;
  jwtSecret: string;
}

const MAX_PERIOD_DAYS = 800;

class BadRequest extends Error {}

function filters(url: URL) {
  const to = url.searchParams.get('to') || lagosToday();
  const from = url.searchParams.get('from') || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!isDay(from) || !isDay(to)) throw new BadRequest('from and to must be dates like 2026-10-23');
  if (from > to) throw new BadRequest('from must not be after to');
  if (periodDays({ from, to }) > MAX_PERIOD_DAYS) throw new BadRequest(`the period can be at most ${MAX_PERIOD_DAYS} days`);
  const status = url.searchParams.get('status') || null;
  if (status && !(REFERRAL_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequest(`status must be one of ${REFERRAL_STATUSES.join(', ')}`);
  }
  const int = (key: string, fallback: number) => {
    const n = Number.parseInt(url.searchParams.get(key) ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    from,
    to,
    status: status as ReferralStatusName | null,
    q: (url.searchParams.get('q') ?? '').trim().slice(0, 60) || null,
    limit: Math.min(int('limit', 50), 200),
    offset: int('offset', 0),
  };
}

export async function handleAdminReferralsRoute(req: IncomingMessage, res: ServerResponse, deps: Deps, url: URL): Promise<boolean> {
  const person = /^\/admin\/referrals\/people\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (url.pathname !== '/admin/referrals' && url.pathname !== '/admin/referrals/codes' && !person) return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  if (auth.role === 'SUPPORT') {
    sendJson(res, 403, { error: 'Not for the support desk.' });
    return true;
  }
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (person) {
      const found = await adminReferralsClient.person(person[1]!);
      if (!found) {
        sendJson(res, 404, { error: 'No such person.', code: 'NOT_FOUND' });
        return true;
      }
      sendJson(res, 200, { rules: REFERRAL_RULES, ...found });
      return true;
    }
    if (url.pathname === '/admin/referrals/codes') {
      const sort = url.searchParams.get('sort');
      const int = (key: string, fallback: number) => {
        const n = Number.parseInt(url.searchParams.get(key) ?? '', 10);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
      };
      sendJson(res, 200, await adminReferralsClient.codes({
        q: (url.searchParams.get('q') ?? '').trim().slice(0, 60) || null,
        sort: sort === 'newest' || sort === 'cashback' ? sort : 'referred',
        limit: Math.min(int('limit', 50), 200),
        offset: int('offset', 0),
      }));
      return true;
    }
    const f = filters(url);
    const [overview, referrals] = await Promise.all([adminReferralsClient.overview(f), adminReferralsClient.list(f)]);
    sendJson(res, 200, {
      from: f.from,
      to: f.to,
      rules: REFERRAL_RULES,
      ...overview,
      referrals,
    });
  } catch (error) {
    if (error instanceof BadRequest) {
      sendJson(res, 400, { error: error.message, code: 'BAD_REQUEST' });
      return true;
    }
    console.error('[admin-referrals] could not load', { error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { error: 'Could not load referrals.' });
  }
  return true;
}
