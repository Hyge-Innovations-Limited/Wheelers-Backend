import type { IncomingMessage, ServerResponse } from 'http';
import { calculateSuggestedFare, calculateRideFees, getPricingMlModel, normalizePricingSettings, BOOKING_FEE_NGN, COMMISSION_RATE, VAT_RATE, LAGOS_STATE_FEE_NGN, RATE_PER_KM_NGN } from '@wheleers/config';
import { pricingClient } from '@wheleers/db';
import { clientIp, recordAdminActivity } from '../admin/activity';
import { busynessNow } from '../pricing/busyness';
import { verifyAdminAuth } from './admin-auth.route';
import { readJsonBody, sendJson } from './utils';

interface PricingDeps {
  adminApiKey: string;
  jwtSecret: string;
}

/** A few trips priced under the saved settings, so a change can be read as fares before and after. */
const EXAMPLES = [
  { label: '5 km, 14 min', distanceKm: 5, minutes: 14 },
  { label: '10 km, 26 min', distanceKm: 10, minutes: 26 },
  { label: '15.5 km, 23 min', distanceKm: 15.5, minutes: 23 },
  { label: '16 km, 41 min', distanceKm: 16, minutes: 41 },
  { label: '25 km, 60 min', distanceKm: 25, minutes: 60 },
];

function trainedModel() {
  const ml = getPricingMlModel();
  return ml ? { trainedAt: ml.trainedAt, rows: ml.rows, source: ml.source, realRows: ml.realRows ?? 0 } : null;
}

function examples() {
  const quiet = new Date('2026-10-14T12:00:00Z');  // a Wednesday, 13:00 in Lagos
  const rush = new Date('2026-10-14T17:00:00Z');   // 18:00 in Lagos
  return EXAMPLES.map((trip) => {
    const at = (when: Date) => {
      const p = calculateSuggestedFare(trip.distanceKm, { durationSeconds: trip.minutes * 60, at: when });
      const fees = calculateRideFees(p.suggestedFareNgn);
      return {
        marketFareNgn: p.marketFareNgn, suggestedFareNgn: p.suggestedFareNgn, minOfferNgn: p.minOfferNgn, maxOfferNgn: p.maxOfferNgn,
        ratePerKmNgn: p.ratePerKmNgn, setBy: p.setBy, modelFareNgn: p.modelFareNgn,
        driverPayoutNgn: fees.driverPayoutNgn, wheelersNgn: Math.round((fees.bookingFeeNgn + fees.commissionNgn) * 100) / 100,
      };
    };
    return { ...trip, quiet: at(quiet), rush: at(rush) };
  });
}

/**
 * Pricing, for owners only (staff get 404, as on the Team pages):
 *   GET /admin/pricing   the settings, a few example trips priced with them,
 *                        how busy each zone is now, and the last week's check
 *   PUT /admin/pricing   save the settings (the model itself is written by
 *                        scripts/train-pricing-model.mjs, never from here)
 * Returns false when the path is not one of these.
 */
export async function handleAdminPricingRoute(req: IncomingMessage, res: ServerResponse, deps: PricingDeps, url: URL): Promise<boolean> {
  if (url.pathname !== '/admin/pricing') return false;
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  if (auth.role !== 'OWNER') {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  if (req.method === 'PUT') {
    const body = ((await readJsonBody(req).catch(() => null)) ?? {}) as Record<string, unknown>;
    const before = (await pricingClient.loadSettings()).settings;
    // The model is the training script's to write: a save from the page keeps the one there is.
    const next = normalizePricingSettings({ ...body, model: before.model });
    if (next.modelOn && !next.model && !getPricingMlModel()) {
      sendJson(res, 400, { error: 'There is no trained model yet, so it cannot be switched on.' });
      return true;
    }
    await pricingClient.saveSettings(next, auth.adminName);
    const { model: _was, ...from } = before;
    const { model: _is, ...to } = next;
    recordAdminActivity({ adminId: auth.adminId, adminName: auth.adminName, kind: 'pricing', page: '/admin/dashboard/pricing', detail: { from, to }, ip: clientIp(req) });
    console.info('[pricing] settings saved', { by: auth.adminName, to });
  } else if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  // Read back from the database and into this process, so the examples below are priced with what is saved.
  await pricingClient.refresh();
  const saved = await pricingClient.loadSettings();
  const summary = await pricingClient.summary(new Date(Date.now() - 7 * 86400_000));
  sendJson(res, 200, {
    settings: saved.settings,
    updatedAt: saved.updatedAt?.toISOString() ?? null,
    updatedBy: saved.updatedBy,
    // The model this build prices with (trained offline, shipped with the code). Null when there is none.
    trainedModel: trainedModel(),
    fixed: { serviceChargeNgn: BOOKING_FEE_NGN, commissionRate: COMMISSION_RATE, vatRate: VAT_RATE, stateLevyNgn: LAGOS_STATE_FEE_NGN, baseRatePerKmNgn: RATE_PER_KM_NGN },
    examples: examples(),
    busyness: busynessNow(),
    lastWeek: summary,
  });
  return true;
}
