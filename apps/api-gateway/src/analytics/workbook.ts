import ExcelJS from 'exceljs';
import { adminAnalyticsClient, CHANNEL_LABELS } from '@wheleers/db';
import type { AnalyticsFilters, Bucket, Kpis, RideChannelName } from '@wheleers/db';

/**
 * The Excel download for the admin Home page and the Fees page: one workbook,
 * one sheet per view, every sheet built from the same filters as the screen.
 *
 * Each sheet has a frozen bold header, naira and percent number formats, sized
 * columns and filter dropdowns. Phone numbers are left out unless asked for:
 * these files leave the company (investors, partners), and a phone number is
 * personal data.
 */

export type WorkbookScope = 'overview' | 'fees';

/** Rows per sheet. Well above today's volume; past it the sheet says it was cut. */
const MAX_ROWS = 50_000;
const PAGE = 5_000;

const NAIRA = '"₦"#,##0.00';
const WHOLE = '#,##0';
const PERCENT = '0.0%';

interface Column {
  header: string;
  key: string;
  width?: number;
  format?: string;
}

function addSheet(book: ExcelJS.Workbook, name: string, columns: Column[], rows: readonly object[], note?: string): void {
  const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 4) }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1D21' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  for (const row of rows) sheet.addRow(row);
  columns.forEach((c, i) => {
    if (c.format) sheet.getColumn(i + 1).numFmt = c.format;
  });
  if (columns.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  if (note) {
    const at = sheet.addRow([]);
    at.getCell(1).value = note;
    at.getCell(1).font = { italic: true, color: { argb: 'FF786F68' } };
  }
}

/** Every page of a paged query, up to MAX_ROWS. */
async function all<T>(fetchPage: (offset: number) => Promise<{ items: T[]; hasMore: boolean; total: number }>): Promise<{ items: T[]; total: number }> {
  const items: T[] = [];
  let total = 0;
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = await fetchPage(offset);
    total = page.total;
    items.push(...page.items);
    if (!page.hasMore) break;
  }
  return { items, total };
}

const cut = (shown: number, total: number) => (total > shown ? `Showing the first ${shown.toLocaleString()} of ${total.toLocaleString()} rows.` : undefined);
const lagosTime = (isoTime: string | null) => (isoTime ? new Date(Date.parse(isoTime) + 3_600_000).toISOString().replace('T', ' ').slice(0, 16) : '');
const channel = (value: string | null) => (value ? CHANNEL_LABELS[value as RideChannelName] ?? value : '');

function filterLines(f: AnalyticsFilters, bucket: Bucket): Array<[string, string]> {
  return [
    ['Period', `${f.from} to ${f.to} (Lagos days, both included)`],
    ['Grouped by', bucket],
    ['Zone', f.zone === 'outside' ? 'Outside launch zones' : f.zone ?? 'All'],
    ['Channel', f.channel ? channel(f.channel) : 'All'],
    ['Ride type', f.rideType ?? 'All'],
    ['Driver', f.driverId ?? 'All'],
    ['Rider', f.riderId ?? 'All'],
    ['Downloaded', `${lagosTime(new Date().toISOString())} Lagos time`],
  ];
}

function kpiRows(current: Kpis, previous: Kpis): Array<Record<string, unknown>> {
  const line = (metric: string, key: keyof Kpis, kind: 'naira' | 'count' | 'percent' | 'number' = 'count') => ({
    metric,
    current: current[key] ?? null,
    previous: previous[key] ?? null,
    change: typeof current[key] === 'number' && typeof previous[key] === 'number' && (previous[key] as number) !== 0
      ? ((current[key] as number) - (previous[key] as number)) / Math.abs(previous[key] as number)
      : null,
    kind,
  });
  return [
    line('Ride requests', 'requests'),
    line('Trips completed', 'completed'),
    line('Match rate', 'matchRate', 'percent'),
    line('Trips cancelled', 'cancelled'),
    line('  No driver found', 'cancelledNoDriver'),
    line('  Cancelled before a driver', 'cancelledBeforeMatch'),
    line('  Cancelled after a driver', 'cancelledAfterMatch'),
    line('Disputed', 'disputed'),
    line('GMV (fares of completed trips)', 'gmvNgn', 'naira'),
    line('Average fare', 'avgFareNgn', 'naira'),
    line('Median fare', 'medianFareNgn', 'naira'),
    line('Commission (4%)', 'commissionNgn', 'naira'),
    line('Service fee', 'serviceFeeNgn', 'naira'),
    line('Deposit fees', 'depositFeesNgn', 'naira'),
    line('Platform revenue', 'platformRevenueNgn', 'naira'),
    line('State levy (owed to Lagos)', 'stateLevyNgn', 'naira'),
    line('Driver payouts', 'driverPayoutsNgn', 'naira'),
    line('Active drivers', 'activeDrivers'),
    line('Active riders', 'activeRiders'),
    line('Rides that got bids', 'ridesWithBids'),
    line('Bid acceptance rate', 'bidAcceptanceRate', 'percent'),
    line('Average bids per ride', 'avgBidsPerRide', 'number'),
    line('Median seconds to first bid', 'medianSecondsToFirstBid', 'number'),
    line('Deposits in', 'depositsNgn', 'naira'),
    line('Deposits (count)', 'depositCount'),
    line('Withdrawals out', 'withdrawalsNgn', 'naira'),
    line('Withdrawals (count)', 'withdrawalCount'),
    line('Refunds', 'refundsNgn', 'naira'),
    line('New users', 'newUsers'),
    line('New riders', 'newRiders'),
    line('New drivers', 'newDrivers'),
  ];
}

function summarySheet(book: ExcelJS.Workbook, title: string, f: AnalyticsFilters, bucket: Bucket, previous: { from: string; to: string }, rows: Array<Record<string, unknown>>): void {
  const sheet = book.addWorksheet('Summary');
  sheet.columns = [{ width: 36 }, { width: 22 }, { width: 22 }, { width: 14 }];
  sheet.addRow([title]).font = { bold: true, size: 14 };
  for (const [k, v] of filterLines(f, bucket)) sheet.addRow([k, v]);
  sheet.addRow([]);
  const head = sheet.addRow(['Metric', `${f.from} to ${f.to}`, `${previous.from} to ${previous.to}`, 'Change']);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1D21' } };
  for (const r of rows) {
    const row = sheet.addRow([r.metric, r.current, r.previous, r.change]);
    const fmt = r.kind === 'naira' ? NAIRA : r.kind === 'percent' ? PERCENT : r.kind === 'number' ? '#,##0.0' : WHOLE;
    row.getCell(2).numFmt = fmt;
    row.getCell(3).numFmt = fmt;
    row.getCell(4).numFmt = PERCENT;
  }
}

async function tripsSheet(book: ExcelJS.Workbook, f: AnalyticsFilters, status: 'all' | 'completed', contacts: boolean, name: string): Promise<void> {
  const { items, total } = await all((offset) => adminAnalyticsClient.trips(f, status, { limit: PAGE, offset, sort: 'createdAt', dir: 'asc' }, PAGE));
  const columns: Column[] = [
    { header: 'Ride ID', key: 'id', width: 38 },
    { header: 'Requested (Lagos)', key: 'createdAt', width: 18 },
    { header: 'Completed (Lagos)', key: 'completedAt', width: 18 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Channel', key: 'channel', width: 11 },
    { header: 'Ride type', key: 'rideType', width: 10 },
    { header: 'Pickup zone', key: 'pickupZone', width: 14 },
    { header: 'Destination zone', key: 'destZone', width: 16 },
    { header: 'Pickup', key: 'pickupAddress', width: 40 },
    { header: 'Destination', key: 'destAddress', width: 40 },
    { header: 'Rider', key: 'riderName', width: 20 },
    ...(contacts ? [{ header: 'Rider phone', key: 'riderPhone', width: 16 }] : []),
    { header: 'Driver', key: 'driverName', width: 20 },
    ...(contacts ? [{ header: 'Driver phone', key: 'driverPhone', width: 16 }] : []),
    { header: 'Fare', key: 'fareNgn', format: NAIRA },
    { header: 'Commission', key: 'commissionNgn', format: NAIRA },
    { header: 'Service fee', key: 'serviceFeeNgn', format: NAIRA },
    { header: 'State levy', key: 'stateLevyNgn', format: NAIRA },
    { header: 'Platform total', key: 'platformTotalNgn', format: NAIRA },
    { header: 'Driver payout', key: 'driverPayoutNgn', format: NAIRA },
    { header: 'Split estimated', key: 'feeSplitEstimated', width: 15 },
    { header: 'Distance km', key: 'distanceKm', format: '#,##0.0' },
    { header: 'Minutes', key: 'minutes', format: WHOLE },
    { header: 'Bids', key: 'bids', format: WHOLE },
    { header: 'Cancel reason', key: 'cancelReason', width: 30 },
  ];
  addSheet(book, name, columns, items.map((t) => ({
    ...t,
    createdAt: lagosTime(t.createdAt),
    completedAt: lagosTime(t.completedAt),
    channel: channel(t.channel),
    pickupZone: t.pickupZone ?? 'Outside',
    destZone: t.destZone ?? 'Outside',
    feeSplitEstimated: t.platformTotalNgn == null ? '' : t.feeSplitEstimated ? 'yes' : 'no',
    minutes: t.durationSeconds == null ? null : Math.round(t.durationSeconds / 60),
  })), cut(items.length, total));
}

async function feesSheets(book: ExcelJS.Workbook, f: AnalyticsFilters, bucket: Bucket): Promise<void> {
  const points = await adminAnalyticsClient.feePoints(f, bucket);
  addSheet(book, 'Fees', [
    { header: `${bucket[0]!.toUpperCase()}${bucket.slice(1)} starting`, key: 'bucket', width: 14 },
    { header: 'Commission', key: 'commissionNgn', format: NAIRA },
    { header: 'Service fee', key: 'serviceFeeNgn', format: NAIRA },
    { header: 'Deposit fees', key: 'depositFeesNgn', format: NAIRA },
    { header: 'Income', key: 'incomeNgn', format: NAIRA },
    { header: 'State levy (owed)', key: 'stateLevyNgn', format: NAIRA, width: 18 },
    { header: 'Paystack deposit fees', key: 'depositProviderCostNgn', format: NAIRA, width: 20 },
    { header: 'Paystack transfer fees', key: 'transferCostNgn', format: NAIRA, width: 21 },
    { header: 'Other provider fees', key: 'otherProviderCostNgn', format: NAIRA, width: 19 },
    { header: 'Costs', key: 'costsNgn', format: NAIRA },
    { header: 'Net', key: 'netNgn', format: NAIRA },
    { header: 'Rides with fees', key: 'feeRides', format: WHOLE },
    { header: 'Deposits', key: 'deposits', format: WHOLE },
    { header: 'Withdrawal transfers', key: 'transfers', format: WHOLE, width: 20 },
    { header: 'Commission, estimated split', key: 'estimatedCommissionNgn', format: NAIRA, width: 26 },
  ], points, 'Income is commission, the ₦375 service fee and the ₦30 deposit fee. The state levy is collected for Lagos State and is not income.');

  const { items, total } = await all((offset) => adminAnalyticsClient.feeLedger(f, null, { limit: PAGE, offset, sort: 'createdAt', dir: 'asc' }, PAGE));
  addSheet(book, 'Fee ledger', [
    { header: 'Ledger ID', key: 'id', width: 38 },
    { header: 'Time (Lagos)', key: 'createdAt', width: 18 },
    { header: 'Kind', key: 'label', width: 22 },
    { header: 'Direction', key: 'direction', width: 10 },
    { header: 'Amount', key: 'amountNgn', format: NAIRA },
    { header: 'Reference (ride, deposit or withdrawal)', key: 'referenceId', width: 40 },
    { header: 'Commission', key: 'commissionNgn', format: NAIRA },
    { header: 'Service fee', key: 'serviceFeeNgn', format: NAIRA },
    { header: 'State levy', key: 'stateLevyNgn', format: NAIRA },
  ], items.map((r) => ({ ...r, createdAt: lagosTime(r.createdAt) })), cut(items.length, total));
}

export async function buildWorkbook(scope: WorkbookScope, f: AnalyticsFilters, bucket: Bucket, contacts: boolean): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = 'Wheelers admin';
  book.created = new Date();

  if (scope === 'fees') {
    const fees = await adminAnalyticsClient.fees(f, bucket);
    const t = fees.totals;
    const p = fees.previousTotals;
    const line = (metric: string, key: keyof typeof t, kind: 'naira' | 'count' = 'naira') => ({
      metric, current: t[key], previous: p[key], change: p[key] ? ((t[key] as number) - (p[key] as number)) / Math.abs(p[key] as number) : null, kind,
    });
    summarySheet(book, 'Wheelers fees', f, bucket, fees.previous, [
      line('Commission (4%)', 'commissionNgn'),
      line('Service fee', 'serviceFeeNgn'),
      line('Deposit fees', 'depositFeesNgn'),
      line('Income', 'incomeNgn'),
      line('State levy (owed to Lagos)', 'stateLevyNgn'),
      line('Paystack deposit fees', 'depositProviderCostNgn'),
      line('Paystack transfer fees', 'transferCostNgn'),
      line('Other provider fees', 'otherProviderCostNgn'),
      line('Costs', 'costsNgn'),
      line('Net', 'netNgn'),
      line('Rides with fees', 'feeRides', 'count'),
      line('Deposits', 'deposits', 'count'),
      line('Withdrawal transfers', 'transfers', 'count'),
      line('Commission from estimated splits', 'estimatedCommissionNgn'),
    ]);
    await feesSheets(book, f, bucket);
    await tripsSheet(book, f, 'completed', contacts, 'Trips with fees');
  } else {
    const [summary, series, byChannel, byZone, byType, byCancel] = await Promise.all([
      adminAnalyticsClient.summary(f),
      adminAnalyticsClient.timeseries(f, bucket),
      adminAnalyticsClient.breakdown(f, 'channel'),
      adminAnalyticsClient.breakdown(f, 'zone'),
      adminAnalyticsClient.breakdown(f, 'rideType'),
      adminAnalyticsClient.breakdown(f, 'cancelReason'),
    ]);
    summarySheet(book, 'Wheelers overview', f, bucket, summary.previous, kpiRows(summary.current, summary.previousKpis));

    addSheet(book, bucket === 'day' ? 'Daily' : bucket === 'week' ? 'Weekly' : 'Monthly', [
      { header: `${bucket[0]!.toUpperCase()}${bucket.slice(1)} starting`, key: 'bucket', width: 14 },
      { header: 'Requests', key: 'requests', format: WHOLE },
      { header: 'Completed', key: 'completed', format: WHOLE },
      { header: 'Cancelled', key: 'cancelled', format: WHOLE },
      { header: 'GMV', key: 'gmvNgn', format: NAIRA },
      { header: 'Commission', key: 'commissionNgn', format: NAIRA },
      { header: 'Service fee', key: 'serviceFeeNgn', format: NAIRA },
      { header: 'State levy', key: 'stateLevyNgn', format: NAIRA },
      { header: 'Deposit fees', key: 'depositFeesNgn', format: NAIRA },
      { header: 'Deposits in', key: 'depositsNgn', format: NAIRA },
      { header: 'New users', key: 'newUsers', format: WHOLE },
    ], series);

    await tripsSheet(book, f, 'all', contacts, 'Trips');

    const drivers = await all((offset) => adminAnalyticsClient.drivers(f, { limit: PAGE, offset, sort: 'trips' }, PAGE));
    addSheet(book, 'Drivers', [
      { header: 'Driver ID', key: 'driverId', width: 38 },
      { header: 'Name', key: 'name', width: 22 },
      ...(contacts ? [{ header: 'Phone', key: 'phone', width: 16 }] : []),
      { header: 'KYC', key: 'kycStatus', width: 11 },
      { header: 'Trips', key: 'trips', format: WHOLE },
      { header: 'GMV', key: 'gmvNgn', format: NAIRA },
      { header: 'Earnings', key: 'earningsNgn', format: NAIRA },
      { header: 'Commission', key: 'commissionNgn', format: NAIRA },
      { header: 'Average fare', key: 'avgFareNgn', format: NAIRA },
      { header: 'Bids', key: 'bids', format: WHOLE },
      { header: 'Bids won', key: 'bidsWon', format: WHOLE },
      { header: 'Win rate', key: 'bidWinRate', format: PERCENT },
      { header: 'Last trip (Lagos)', key: 'lastTripAt', width: 18 },
    ], drivers.items.map((d) => ({ ...d, lastTripAt: lagosTime(d.lastTripAt) })), cut(drivers.items.length, drivers.total));

    const riders = await all((offset) => adminAnalyticsClient.riders(f, { limit: PAGE, offset, sort: 'trips' }, PAGE));
    addSheet(book, 'Riders', [
      { header: 'Rider ID', key: 'riderId', width: 38 },
      { header: 'Name', key: 'name', width: 22 },
      ...(contacts ? [{ header: 'Phone', key: 'phone', width: 16 }] : []),
      { header: 'Joined (Lagos)', key: 'joinedAt', width: 18 },
      { header: 'Requests', key: 'requests', format: WHOLE },
      { header: 'Trips', key: 'trips', format: WHOLE },
      { header: 'Cancelled', key: 'cancelled', format: WHOLE },
      { header: 'Spend', key: 'spendNgn', format: NAIRA },
      { header: 'Average fare', key: 'avgFareNgn', format: NAIRA },
      { header: 'Usual channel', key: 'topChannel', width: 14 },
      { header: 'Last request (Lagos)', key: 'lastRequestAt', width: 20 },
      { header: 'Wallet balance', key: 'walletBalanceNgn', format: NAIRA },
    ], riders.items.map((r) => ({ ...r, joinedAt: lagosTime(r.joinedAt), lastRequestAt: lagosTime(r.lastRequestAt), topChannel: channel(r.topChannel) })), cut(riders.items.length, riders.total));

    await feesSheets(book, f, bucket);

    const breakdownRows = [
      ...byChannel.map((r) => ({ ...r, by: 'Channel' })),
      ...byZone.map((r) => ({ ...r, by: 'Pickup zone' })),
      ...byType.map((r) => ({ ...r, by: 'Ride type' })),
      ...byCancel.map((r) => ({ ...r, by: 'Cancellation' })),
    ];
    addSheet(book, 'Breakdown', [
      { header: 'By', key: 'by', width: 14 },
      { header: 'Group', key: 'label', width: 26 },
      { header: 'Requests', key: 'requests', format: WHOLE },
      { header: 'Completed', key: 'completed', format: WHOLE },
      { header: 'Cancelled', key: 'cancelled', format: WHOLE },
      { header: 'GMV', key: 'gmvNgn', format: NAIRA },
    ], breakdownRows);
  }

  return Buffer.from(await book.xlsx.writeBuffer());
}
