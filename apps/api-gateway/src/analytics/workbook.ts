import ExcelJS from 'exceljs';
import { adminAnalyticsClient, CHANNEL_LABELS, tripActivityClient } from '@wheleers/db';
import type { AnalyticsFilters, Bucket, Kpis, RideChannelName, TripRow } from '@wheleers/db';
import { cleanName, cleanText } from './clean-text';

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
  /** What the column means, shown when the header cell is hovered. */
  note?: string;
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
    if (c.note) header.getCell(i + 1).note = c.note;
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
    line('Withdrawal fees', 'withdrawalFeesNgn', 'naira'),
    line('Platform revenue', 'platformRevenueNgn', 'naira'),
    line('State levy (owed to Lagos)', 'stateLevyNgn', 'naira'),
    line('Driver payouts', 'driverPayoutsNgn', 'naira'),
    line('Active drivers', 'activeDrivers'),
    line('Active riders', 'activeRiders'),
    line('Drivers on shift', 'driversOnShift'),
    line('Driver hours online', 'driverOnlineHours', 'number'),
    line('Average hours online per driver', 'avgOnlineHoursPerDriver', 'number'),
    line('Trips per driver hour online', 'tripsPerOnlineHour', 'number'),
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

/** A trip's status in five plain words, the same on every sheet. */
function tripStatus(t: TripRow): string {
  if (t.status === 'COMPLETED') return 'Completed';
  if (t.status === 'CANCELLED') return t.noDriver ? 'No driver found' : 'Cancelled';
  if (t.status === 'REQUESTED' || t.status === 'MATCHING') return 'Searching';
  if (t.status === 'DISPUTED') return 'Disputed';
  return 'In progress';
}

/** Lagos date (YYYY-MM-DD) and time (HH:MM) of an instant. */
function lagosParts(isoTime: string | null): { day: string; time: string } | null {
  if (!isoTime) return null;
  const at = new Date(Date.parse(isoTime) + 3_600_000).toISOString();
  return { day: at.slice(0, 10), time: at.slice(11, 16) };
}

/** A time on the booking's day is just the time; on another day it carries its date. */
function timeOn(bookedDay: string, isoTime: string | null): string {
  const parts = lagosParts(isoTime);
  if (!parts) return '';
  return parts.day === bookedDay ? parts.time : `${parts.day} ${parts.time}`;
}

/** The rider's WhatsApp number: whole with contacts, else only its last four digits. */
function platformId(t: TripRow, contacts: boolean): string {
  if (t.channel !== 'WHATSAPP' || !t.riderWhatsapp) return '';
  if (contacts) return t.riderWhatsapp;
  return `••••${t.riderWhatsapp.replace(/\D/g, '').slice(-4)}`;
}

/** Seconds as an Excel duration (a fraction of a day), shown as minutes:seconds and summable. */
const asDuration = (seconds: number | null) => (seconds == null ? null : seconds / 86_400);
const DURATION = '[m]:ss';

const STELLAR_TX = 'https://stellar.expert/explorer/testnet/tx/';
/** A transaction hash as a clickable cell, opening it on the testnet explorer. */
const txLink = (hash: string | null) => (hash ? { text: `${hash.slice(0, 10)}…`, hyperlink: `${STELLAR_TX}${hash}` } : '');
const LONG_TRIP_SECONDS = 3 * 60 * 60;
const CODE_LABEL: Record<string, string> = { none: '', waiting: 'Not entered', verified: 'Entered', unlocked: 'Unlocked by support' };

async function tripsSheet(book: ExcelJS.Workbook, f: AnalyticsFilters, status: 'all' | 'completed', contacts: boolean, name: string): Promise<TripRow[]> {
  const { items, total } = await all((offset) => adminAnalyticsClient.trips(f, status, { limit: PAGE, offset, sort: 'createdAt', dir: 'asc' }, PAGE));
  // Chat, calls, the trip code and the trip's Stellar transfers, for all these trips at once.
  const activity = await tripActivityClient.forRides(items.map((t) => t.id)).catch(() => new Map());
  // In the order the team keeps its own sheet: who, when, how it ended, where, how long, for how much.
  const columns: Column[] = [
    { header: 'Trip ID', key: 'tripId', width: 11 },
    { header: 'Rider', key: 'riderName', width: 22 },
    { header: 'Date', key: 'date', width: 11 },
    { header: 'Status', key: 'statusLabel', width: 16 },
    { header: 'Rider ID', key: 'riderId', width: 38 },
    { header: 'Platform ID', key: 'platformId', width: 16 },
    { header: 'From', key: 'pickupAddress', width: 40 },
    { header: 'Platform', key: 'channel', width: 10 },
    { header: 'To', key: 'destAddress', width: 40 },
    { header: 'Book time', key: 'bookTime', width: 10 },
    { header: 'Start trip time', key: 'startTime', width: 15 },
    { header: 'End trip time', key: 'endTime', width: 15 },
    { header: 'Suggested amount', key: 'suggestedFareNgn', format: NAIRA, width: 17 },
    { header: 'Rider offered', key: 'riderOfferNgn', format: NAIRA, width: 14 },
    { header: 'Amount agreed', key: 'agreedFareNgn', format: NAIRA, width: 15 },
    { header: 'Time to negotiate', key: 'negotiate', format: DURATION, width: 17, note: 'From the request to a driver being booked, in minutes and seconds. Empty when no driver was booked.' },
    { header: 'Messages to book', key: 'messagesToBook', format: WHOLE, width: 17, note: "The rider's WhatsApp messages from after their previous trip ended until this one got a driver (or ended without one). Empty for App and Claude bookings." },
    { header: 'Driver', key: 'driverName', width: 20 },
    { header: 'Driver ID', key: 'driverId', width: 38 },
    ...(contacts ? [{ header: 'Rider phone', key: 'riderPhone', width: 16 }, { header: 'Driver phone', key: 'driverPhone', width: 16 }] : []),
    { header: 'Pickup zone', key: 'pickupZone', width: 14 },
    { header: 'Destination zone', key: 'destZone', width: 16 },
    { header: 'Ride type', key: 'rideType', width: 10 },
    { header: 'Fare', key: 'fareNgn', format: NAIRA },
    { header: 'Commission', key: 'commissionNgn', format: NAIRA },
    { header: 'Service fee', key: 'serviceFeeNgn', format: NAIRA },
    { header: 'State levy', key: 'stateLevyNgn', format: NAIRA },
    { header: 'Platform total', key: 'platformTotalNgn', format: NAIRA },
    { header: 'Driver payout', key: 'driverPayoutNgn', format: NAIRA },
    { header: 'Split estimated', key: 'feeSplitEstimated', width: 15 },
    { header: 'Distance km', key: 'distanceKm', format: '#,##0.0' },
    { header: 'Trip minutes', key: 'minutes', format: WHOLE },
    { header: 'Bids', key: 'bids', format: WHOLE },
    { header: 'Cancel reason', key: 'cancelReason', width: 30 },
    { header: 'Long trip (3h+)', key: 'longTrip', width: 15, note: 'Yes when the trip ran 3 hours or more from start to end.' },
    { header: 'Chat: rider messages', key: 'riderMessages', format: WHOLE, width: 20 },
    { header: 'Chat: driver messages', key: 'driverMessages', format: WHOLE, width: 21 },
    { header: 'Calls', key: 'calls', format: WHOLE },
    { header: 'Calls answered', key: 'callsAnswered', format: WHOLE, width: 15 },
    { header: 'Calls missed', key: 'callsMissed', format: WHOLE, width: 13 },
    { header: 'Call minutes', key: 'callMinutes', format: '#,##0.0', width: 13 },
    { header: 'Trip code', key: 'tripCodeLabel', width: 20, note: "Entered: the driver typed the rider's code. Unlocked by support: started without it. Empty: no code (group seats, older trips)." },
    { header: 'Wrong codes', key: 'wrongCodes', format: WHOLE, width: 12 },
    { header: 'Unlocked by', key: 'unlockedBy', width: 16 },
    { header: 'Stellar fare tx', key: 'stellarFare', width: 16, note: 'Stellar TESTNET: the fare, rider to driver, with the trip ID as memo. Click to open it on stellar.expert.' },
    { header: 'Stellar commission tx', key: 'stellarCommission', width: 20, note: 'Stellar TESTNET: the commission, driver to Wheelers operations.' },
    { header: 'Ride ID', key: 'id', width: 38 },
  ];
  addSheet(book, name, columns, items.map((t) => {
    const booked = lagosParts(t.createdAt)!;
    const ended = t.completedAt ?? t.cancelledAt;
    const a = activity.get(t.id);
    const ranSeconds = t.startedAt && t.completedAt ? (Date.parse(t.completedAt) - Date.parse(t.startedAt)) / 1000 : null;
    return {
      ...t,
      longTrip: ranSeconds !== null && ranSeconds >= LONG_TRIP_SECONDS ? 'yes' : '',
      riderMessages: a?.riderMessages ?? 0,
      driverMessages: a?.driverMessages ?? 0,
      calls: a?.calls ?? 0,
      callsAnswered: a?.callsAnswered ?? 0,
      callsMissed: a?.callsMissed ?? 0,
      callMinutes: a ? Math.round((a.callSeconds / 60) * 10) / 10 : 0,
      tripCodeLabel: CODE_LABEL[a?.tripCode ?? 'none'],
      wrongCodes: a?.wrongCodes ?? 0,
      unlockedBy: a?.unlockedBy ?? '',
      stellarFare: txLink(a?.stellarFareTx ?? null),
      stellarCommission: txLink(a?.stellarCommissionTx ?? null),
      tripId: t.tripId ?? '',
      riderName: cleanName(t.riderName),
      driverName: t.driverId ? cleanName(t.driverName, 'Unnamed driver') : '',
      date: booked.day,
      statusLabel: tripStatus(t),
      platformId: platformId(t, contacts),
      pickupAddress: cleanText(t.pickupAddress),
      destAddress: cleanText(t.destAddress),
      channel: channel(t.channel),
      bookTime: booked.time,
      startTime: timeOn(booked.day, t.startedAt),
      endTime: timeOn(booked.day, ended),
      negotiate: asDuration(t.negotiateSeconds),
      pickupZone: t.pickupZone ?? 'Outside',
      destZone: t.destZone ?? 'Outside',
      rideType: t.rideType === 'group' ? 'Group' : 'Single',
      feeSplitEstimated: t.platformTotalNgn == null ? '' : t.feeSplitEstimated ? 'yes' : 'no',
      minutes: t.durationSeconds == null ? null : Math.round(t.durationSeconds / 60),
      cancelReason: cleanText(t.cancelReason),
    };
  }), cut(items.length, total));
  return items;
}

/** One row per Live call on the exported trips. */
async function callsSheet(book: ExcelJS.Workbook, trips: TripRow[]): Promise<void> {
  const tripIdOf = new Map(trips.map((t) => [t.id, t.tripId ?? '']));
  const calls = await tripActivityClient.callsForRides(trips.map((t) => t.id)).catch(() => []);
  const OUTCOME: Record<string, string> = { COMPLETED: 'Talked', MISSED: 'Missed', CANCELLED: 'Missed (caller hung up)', DECLINED: 'Declined', FAILED: 'Could not connect', RINGING: 'Ringing', ACTIVE: 'On the call' };
  addSheet(book, 'Calls', [
    { header: 'Time (Lagos)', key: 'time', width: 18 },
    { header: 'Trip ID', key: 'tripId', width: 11 },
    { header: 'Caller', key: 'caller', width: 10 },
    { header: 'Rung on', key: 'channel', width: 10 },
    { header: 'Outcome', key: 'outcome', width: 22 },
    { header: 'Talk seconds', key: 'durationSeconds', format: WHOLE, width: 13 },
    { header: 'Ended because', key: 'endReason', width: 14 },
    { header: 'Ride ID', key: 'rideId', width: 38 },
  ], calls.map((c) => ({
    time: lagosTime(c.createdAt.toISOString()),
    tripId: tripIdOf.get(c.rideId) ?? '',
    caller: c.callerRole === 'DRIVER' ? 'Driver' : 'Rider',
    channel: c.calleeChannel === 'whatsapp' ? 'WhatsApp' : 'App',
    outcome: OUTCOME[c.status] ?? c.status,
    durationSeconds: c.durationSeconds ?? '',
    endReason: c.endReason ?? '',
    rideId: c.rideId,
  })), 'Every Live call on the trips in this export. Talk seconds are from answering to hanging up.');
}

/** Every Stellar TESTNET transfer in the period: the grant evidence, with explorer links. */
async function stellarSheet(book: ExcelJS.Workbook, f: AnalyticsFilters, trips: TripRow[]): Promise<void> {
  const from = new Date(`${f.from}T00:00:00+01:00`);
  const to = new Date(Date.parse(`${f.to}T00:00:00+01:00`) + 24 * 60 * 60 * 1000);
  const transfers = await tripActivityClient.stellarBetween(from, to).catch(() => []);
  if (!transfers.length) return;
  const tripIdOf = new Map(trips.map((t) => [t.id, t.tripId ?? '']));
  const KIND: Record<string, string> = { ACCOUNT_OPEN: 'Account opened', TOPUP: 'Top-up', FARE: 'Trip fare', COMMISSION: 'Commission', WITHDRAWAL: 'Driver withdrawal' };
  addSheet(book, 'Stellar', [
    { header: 'Time (Lagos)', key: 'time', width: 18 },
    { header: 'Kind', key: 'kind', width: 18 },
    { header: 'Trip ID', key: 'tripId', width: 11 },
    { header: 'XLM', key: 'amountXlm', format: '#,##0.0000000', width: 14 },
    { header: 'Naira value', key: 'amountNgn', format: NAIRA, width: 13 },
    { header: 'Status', key: 'status', width: 11 },
    { header: 'Transaction', key: 'tx', width: 16 },
    { header: 'From', key: 'from', width: 58 },
    { header: 'To', key: 'to', width: 58 },
    { header: 'Memo', key: 'memo', width: 16 },
  ], transfers.map((t) => ({
    time: lagosTime(t.createdAt.toISOString()),
    kind: KIND[t.kind] ?? t.kind,
    tripId: t.rideId ? tripIdOf.get(t.rideId) ?? '' : '',
    amountXlm: Number(t.amountXlm),
    amountNgn: t.amountNgn === null ? '' : Number(t.amountNgn),
    status: t.status,
    tx: t.status === 'CONFIRMED' ? txLink(t.txHash) : '',
    from: t.fromPublicKey,
    to: t.toPublicKey,
    memo: t.memo ?? '',
  })), 'Stellar TESTNET only: test XLM, no real value. Naira is converted at the demo rate. Click a transaction to open it on stellar.expert.');
}

async function feesSheets(book: ExcelJS.Workbook, f: AnalyticsFilters, bucket: Bucket, contacts: boolean): Promise<void> {
  const points = await adminAnalyticsClient.feePoints(f, bucket);
  addSheet(book, 'Fees', [
    { header: `${bucket[0]!.toUpperCase()}${bucket.slice(1)} starting`, key: 'bucket', width: 14 },
    { header: 'Commission', key: 'commissionNgn', format: NAIRA },
    { header: 'Service fee', key: 'serviceFeeNgn', format: NAIRA },
    { header: 'Deposit fees', key: 'depositFeesNgn', format: NAIRA },
    { header: 'Withdrawal fees', key: 'withdrawalFeesNgn', format: NAIRA, width: 16 },
    { header: 'Income', key: 'incomeNgn', format: NAIRA },
    { header: 'State levy (owed)', key: 'stateLevyNgn', format: NAIRA, width: 18 },
    { header: 'Platform deposit costs', key: 'depositProviderCostNgn', format: NAIRA, width: 20 },
    { header: 'Platform withdrawal costs', key: 'transferCostNgn', format: NAIRA, width: 21 },
    { header: 'Other platform costs', key: 'otherProviderCostNgn', format: NAIRA, width: 19 },
    { header: 'Costs', key: 'costsNgn', format: NAIRA },
    { header: 'Net', key: 'netNgn', format: NAIRA },
    { header: 'Rides with fees', key: 'feeRides', format: WHOLE },
    { header: 'Deposits', key: 'deposits', format: WHOLE },
    { header: 'Withdrawal transfers', key: 'transfers', format: WHOLE, width: 20 },
    { header: 'Withdrawals that paid the fee', key: 'feeWithdrawals', format: WHOLE, width: 26 },
    { header: 'Commission, estimated split', key: 'estimatedCommissionNgn', format: NAIRA, width: 26 },
  ], points, 'Income is commission, the ₦375 service fee, the ₦30 deposit fee and the withdrawal fee. The state levy is collected for Lagos State and is not income.');

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

  const dep = await all((offset) => adminAnalyticsClient.deposits(f, { limit: PAGE, offset, sort: 'createdAt', dir: 'asc' }, PAGE));
  addSheet(book, 'Deposits', [
    { header: 'Time (Lagos)', key: 'createdAt', width: 18 },
    { header: 'Wallet owner', key: 'name', width: 22 },
    ...(contacts ? [{ header: 'Phone', key: 'phone', width: 16 }] : []),
    { header: 'Sent', key: 'grossNgn', format: NAIRA },
    { header: 'Deposit fee', key: 'feeNgn', format: NAIRA },
    { header: 'Provider charge', key: 'providerFeeNgn', format: NAIRA, width: 16 },
    { header: 'Credited to wallet', key: 'creditedNgn', format: NAIRA, width: 18 },
    { header: 'Sender', key: 'senderName', width: 22 },
    { header: 'Sender bank', key: 'senderBank', width: 16 },
    { header: 'Reference', key: 'reference', width: 34 },
  ], dep.items.map((r) => ({ ...r, name: cleanName(r.name), senderName: r.senderName ? cleanName(r.senderName) : '', createdAt: lagosTime(r.createdAt) })), cut(dep.items.length, dep.total));

  const wd = await all((offset) => adminAnalyticsClient.withdrawals(f, { limit: PAGE, offset, sort: 'createdAt', dir: 'asc' }, PAGE));
  addSheet(book, 'Withdrawals', [
    { header: 'Requested (Lagos)', key: 'createdAt', width: 18 },
    { header: 'Paid (Lagos)', key: 'settledAt', width: 18 },
    { header: 'Wallet owner', key: 'name', width: 22 },
    ...(contacts ? [{ header: 'Phone', key: 'phone', width: 16 }] : []),
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Amount', key: 'amountNgn', format: NAIRA },
    { header: 'Withdrawal fee', key: 'feeNgn', format: NAIRA, width: 15 },
    { header: 'Sent to bank', key: 'payoutNgn', format: NAIRA, width: 14 },
    { header: 'Platform cost', key: 'transferFeeNgn', format: NAIRA, width: 15 },
    { header: 'To account', key: 'accountName', width: 24 },
    { header: 'Account ending', key: 'accountEnding', width: 15 },
    { header: 'Why it failed', key: 'failureReason', width: 30 },
  ], wd.items.map((r) => ({ ...r, name: cleanName(r.name), accountName: cleanName(r.accountName), createdAt: lagosTime(r.createdAt), settledAt: lagosTime(r.settledAt) })), cut(wd.items.length, wd.total));
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
      line('Withdrawal fees', 'withdrawalFeesNgn'),
      line('Income', 'incomeNgn'),
      line('State levy (owed to Lagos)', 'stateLevyNgn'),
      line('Platform deposit costs', 'depositProviderCostNgn'),
      line('Platform withdrawal costs', 'transferCostNgn'),
      line('Other platform costs', 'otherProviderCostNgn'),
      line('Costs', 'costsNgn'),
      line('Net', 'netNgn'),
      line('Rides with fees', 'feeRides', 'count'),
      line('Deposits', 'deposits', 'count'),
      line('Withdrawal transfers', 'transfers', 'count'),
      line('Withdrawals that paid the fee', 'feeWithdrawals', 'count'),
      line('Commission from estimated splits', 'estimatedCommissionNgn'),
    ]);
    await feesSheets(book, f, bucket, contacts);
    await tripsSheet(book, f, 'completed', contacts, 'Trips with fees');
  } else {
    const [summary, series, byHour, byChannel, byZone, byType, byCancel] = await Promise.all([
      adminAnalyticsClient.summary(f),
      adminAnalyticsClient.timeseries(f, bucket),
      adminAnalyticsClient.hours(f),
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

    const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
    const supplyNote = !byHour.supply.shown
      ? 'Drivers on shift are not shown under a zone, channel, ride type or rider filter: a shift belongs to no ride.'
      : byHour.supply.recordedFrom
        ? `Drivers on shift are recorded from ${lagosTime(byHour.supply.recordedFrom)} Lagos time. Hours before that have requests but no drivers to show.`
        : 'No driver shift has been recorded yet.';
    const hourColumns: Column[] = [
      { header: 'Requests', key: 'requests', format: WHOLE },
      { header: 'Completed', key: 'completed', format: WHOLE },
      { header: 'No driver found', key: 'noDriver', format: WHOLE, width: 16 },
      { header: 'Match rate', key: 'matchRate', format: PERCENT },
      { header: 'GMV', key: 'gmvNgn', format: NAIRA },
      { header: 'Drivers on shift (average)', key: 'avgDriversOnline', format: '#,##0.0', width: 26 },
      { header: 'Driver hours online', key: 'driverHours', format: '#,##0.0', width: 20 },
      { header: 'Requests per driver', key: 'requestsPerDriver', format: '#,##0.00', width: 20 },
    ];
    addSheet(book, 'Hours', [{ header: 'Hour (Lagos)', key: 'label', width: 14 }, ...hourColumns],
      byHour.hours.map((h) => ({ ...h, label: `${clock(h.hour)} to ${clock(h.hour).slice(0, 2)}:59` })), supplyNote);
    addSheet(book, 'Weekdays', [{ header: 'Day', key: 'label', width: 14 }, ...hourColumns], byHour.weekdays, supplyNote);
    addSheet(book, 'Hours by weekday', [
      { header: 'Requests', key: 'day', width: 14 },
      ...Array.from({ length: 24 }, (_, hour) => ({ header: clock(hour), key: `h${hour}`, width: 7, format: WHOLE })),
    ], byHour.grid.map((row, i) => ({ day: byHour.weekdays[i]?.label ?? '', ...Object.fromEntries(row.map((n, hour) => [`h${hour}`, n])) })));

    const trips = await tripsSheet(book, f, 'all', contacts, 'Trips');
    await callsSheet(book, trips);
    await stellarSheet(book, f, trips);

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
      { header: 'Hours online', key: 'onlineHours', format: '#,##0.0', width: 14 },
      { header: 'Shifts', key: 'shifts', format: WHOLE },
      { header: 'Trips per hour online', key: 'tripsPerOnlineHour', format: '#,##0.00', width: 21 },
      { header: 'Last online (Lagos)', key: 'lastOnlineAt', width: 19 },
    ], drivers.items.map((d) => ({ ...d, name: cleanName(d.name, 'Unnamed driver'), lastTripAt: lagosTime(d.lastTripAt), lastOnlineAt: lagosTime(d.lastOnlineAt) })), cut(drivers.items.length, drivers.total));

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
      { header: 'WhatsApp messages', key: 'messages', format: WHOLE, width: 18 },
      { header: 'Messages per trip', key: 'messagesPerTrip', format: '#,##0.0', width: 17 },
      { header: 'Wallet balance', key: 'walletBalanceNgn', format: NAIRA },
    ], riders.items.map((r) => ({ ...r, name: cleanName(r.name), joinedAt: lagosTime(r.joinedAt), lastRequestAt: lagosTime(r.lastRequestAt), topChannel: channel(r.topChannel) })), cut(riders.items.length, riders.total));

    await feesSheets(book, f, bucket, contacts);

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
