/**
 * Protocol-level actors for the Wheelers sandbox. They speak the SAME
 * WebSocket protocol the mobile apps do — so a scenario here exercises the
 * gateway, ride-service, and wallet-service exactly the way production
 * traffic does, with no device, no GPS and no San Francisco.
 *
 *   node scripts/sandbox/sim.mjs e2e            # full booking, asserted, exit 0/1
 *   node scripts/sandbox/sim.mjs driver         # act as the seeded driver (auto-bids)
 *   node scripts/sandbox/sim.mjs rider [offer]  # act as the seeded rider (auto-accepts)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { SANDBOX } from './sandbox-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const OPEBI = { lat: 6.6018, lng: 3.3515, address: '102 Opebi Rd, Opebi, Ikeja, Lagos' };
const SURULERE = { lat: 6.4969, lng: 3.3556, address: '15 Aiyetoro St, Surulere, Lagos' };

const startedAt = Date.now();
function stamp() {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${SANDBOX.baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

async function signup({ username, password, role, name, phone }) {
  const created = await api('/auth/signup', {
    method: 'POST',
    body: { username, password, role, fullName: name, phone },
  });
  if (created.status === 201) return { token: created.body.accessToken, user: created.body.user };
  const signin = await api('/auth/signin', { method: 'POST', body: { identifier: username, password } });
  if (signin.status !== 200) throw new Error(`auth failed for ${username}: ${JSON.stringify(signin.body)}`);
  return { token: signin.body.accessToken, user: signin.body.user };
}

// ── Actor: a logged, awaitable WebSocket ───────────────────────────────────

class Actor {
  constructor(label, token) {
    this.label = label;
    this.token = token;
    this.frames = [];
    this.waiters = [];
    this.socket = null;
  }

  connect() {
    return new Promise((resolveConnect, reject) => {
      const url = `${SANDBOX.baseUrl.replace('http', 'ws')}/ws?token=${encodeURIComponent(this.token)}`;
      this.socket = new WebSocket(url);
      this.socket.on('open', () => {
        console.log(`[${stamp()}] ${this.label} ▸ connected`);
        resolveConnect();
      });
      this.socket.on('error', reject);
      this.socket.on('message', (raw) => {
        let frame;
        try { frame = JSON.parse(String(raw)); } catch { return; }
        this.frames.push(frame);
        const summary = JSON.stringify(frame.payload ?? {});
        console.log(`[${stamp()}] ${this.label} ◂ ${frame.type} ${summary.length > 140 ? `${summary.slice(0, 140)}…` : summary}`);
        for (const waiter of [...this.waiters]) {
          if (waiter.matches(frame)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(frame);
          }
        }
      });
    });
  }

  send(type, payload) {
    console.log(`[${stamp()}] ${this.label} ▸ ${type}`);
    this.socket.send(JSON.stringify({ type, payload }));
  }

  /** Resolves with the first (past or future) frame of `type` matching `predicate`. */
  waitFor(type, { predicate = () => true, timeoutMs = 20_000, description } = {}) {
    const matches = (frame) => frame.type === type && predicate(frame.payload ?? {});
    const seen = this.frames.find(matches);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolveWait, reject) => {
      const waiter = { matches, resolve: resolveWait };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`${this.label}: timed out waiting for ${description ?? type}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.socket?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Driver behaviour ───────────────────────────────────────────────────────

/** Go online and answer one complete trip: bid → arrive → start → gps → end. */
async function driveOneTrip(driver, { bidNgn, position = OPEBI, keepGoing = false } = {}) {
  driver.send('driver:online', { lat: position.lat, lng: position.lng });
  await driver.waitFor('driver:online:accepted');

  do {
    const offer = await driver.waitFor('ride:offer', { timeoutMs: 30_000 });
    const { rideId, riderId, riderOfferNgn, fareEstimateNgn, destination } = offer.payload;
    const amount = bidNgn ?? riderOfferNgn ?? fareEstimateNgn;

    await sleep(400);
    driver.send('driver:accept', { rideId, riderId, agreedFareNgn: amount, etaSeconds: 120 });
    await driver.waitFor('driver:accept:accepted', { predicate: (p) => p.rideId === rideId });

    const matched = await driver.waitFor('ride:matched', {
      predicate: (p) => p.rideId === rideId,
      timeoutMs: 60_000,
      description: 'ride:matched (rider must accept within 60s)',
    });
    const agreedFare = matched.payload.agreedFareNgn ?? amount;

    await sleep(600);
    driver.send('ride:arrived', { rideId });
    await driver.waitFor('ride:arrived:ack', { predicate: (p) => p.rideId === rideId || !p.rideId });

    await sleep(600);
    driver.send('ride:start', { rideId, riderId, lockedFareNgn: agreedFare });

    // Three GPS ticks marching toward the drop-off.
    const target = destination ?? SURULERE;
    for (let step = 1; step <= 3; step += 1) {
      await sleep(500);
      driver.send('driver:gps', {
        rideId,
        lat: position.lat + ((target.lat - position.lat) * step) / 3,
        lng: position.lng + ((target.lng - position.lng) * step) / 3,
        speedKmh: 42,
        timestamp: new Date().toISOString(),
      });
    }

    await sleep(500);
    driver.send('ride:end', { rideId, riderId, fareNgn: agreedFare, endedBy: 'both_confirmed' });
    await driver.waitFor('ride:completed', { predicate: (p) => p.rideId === rideId, timeoutMs: 30_000 });
    console.log(`[${stamp()}] ${driver.label} ✓ trip ${rideId.slice(0, 8)} complete (₦${agreedFare})`);
  } while (keepGoing);
}

// ── Rider behaviour ────────────────────────────────────────────────────────

/** Request a ride, accept the first bid, ride it to completion. */
async function rideOnce(rider, { offerNgn = 6000, pickup = OPEBI, destination = SURULERE } = {}) {
  rider.send('ride:request', {
    pickup, destination, paymentMethod: 'WALLET', offerNgn,
  });
  const accepted = await rider.waitFor('ride:request:accepted', {
    timeoutMs: 15_000,
    description: 'ride:request:accepted (offer may be below minimum fare)',
  });
  const { rideId } = accepted.payload;

  const bid = await rider.waitFor('ride:counter_offer', {
    predicate: (p) => p.rideId === rideId,
    timeoutMs: 30_000,
    description: 'a driver bid (is a driver online near the pickup?)',
  });

  await sleep(400);
  rider.send('ride:accept_offer', {
    rideId,
    driverId: bid.payload.driverId,
    driverUserId: bid.payload.driverUserId,
    agreedFareNgn: bid.payload.counterOfferNgn,
    paymentMethod: 'WALLET',
  });

  await rider.waitFor('ride:matched', { predicate: (p) => p.rideId === rideId, timeoutMs: 30_000 });
  await rider.waitFor('ride:driver_arrived', { predicate: (p) => p.rideId === rideId, timeoutMs: 60_000 });
  await rider.waitFor('ride:started', { predicate: (p) => p.rideId === rideId, timeoutMs: 60_000 });
  const completed = await rider.waitFor('ride:completed', { predicate: (p) => p.rideId === rideId, timeoutMs: 120_000 });
  console.log(`[${stamp()}] ${rider.label} ✓ ride ${rideId.slice(0, 8)} complete (₦${completed.payload.fareNgn})`);
  return { rideId, agreedFareNgn: bid.payload.counterOfferNgn };
}

// ── Commands ───────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(readFileSync(resolve(here, '.sandbox-state.json'), 'utf8'));
  } catch {
    throw new Error('No sandbox state — run `npm run sandbox:seed` first.');
  }
}

async function commandDriver() {
  const state = loadState();
  const { token } = await signup({ username: state.driver.username, password: state.driver.password, role: 'DRIVER' });
  const driver = new Actor('driver', token);
  await driver.connect();
  console.log('[sim] driver online at Opebi — will auto-bid on every request. Ctrl+C to stop.');
  await driveOneTrip(driver, { keepGoing: true });
}

async function commandRider(offerArg) {
  const state = loadState();
  const { token } = await signup({ username: state.rider.username, password: state.rider.password, role: 'RIDER' });
  const rider = new Actor('rider', token);
  await rider.connect();
  await rideOnce(rider, { offerNgn: offerArg ? Number(offerArg) : 6000 });
  rider.close();
}

async function commandE2e() {
  // Fresh actors every run: no leftover active rides, no stale resyncs —
  // the scenario is hermetic and repeatable.
  process.env.DATABASE_URL = SANDBOX.databaseUrl;
  const { prisma } = await import('@wheleers/db');
  const runId = Date.now().toString(36);

  const riderAuth = await signup({
    username: `e2e_r_${runId}`, password: 'sandbox123', role: 'RIDER',
    name: 'E2E Rider', phone: '+2348000001001',
  });
  const driverAuth = await signup({
    username: `e2e_d_${runId}`, password: 'sandbox123', role: 'DRIVER',
    name: 'E2E Driver', phone: '+2348000001002',
  });

  await prisma.driver.update({
    where: { userId: driverAuth.user.id },
    data: {
      status: 'ONLINE', kycStatus: 'APPROVED',
      lat: OPEBI.lat, lng: OPEBI.lng, lastSeenAt: new Date(),
      vehiclePlate: 'E2E-001-AA', vehicleModel: 'Toyota Corolla',
    },
  });
  const wallet = await prisma.wallet.findUnique({ where: { userId: riderAuth.user.id } });
  if (!wallet) throw new Error('rider wallet missing after signup');
  await prisma.wallet.update({ where: { id: wallet.id }, data: { balanceNgn: 50_000 } });

  const rider = new Actor('rider ', riderAuth.token);
  const driver = new Actor('driver', driverAuth.token);
  await Promise.all([rider.connect(), driver.connect()]);

  const checks = [];
  const check = (label, ok, detail = '') => {
    checks.push({ label, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  };

  console.log('\n── E2E: booking a ride, Opebi → Surulere ──\n');
  const driverDone = driveOneTrip(driver);
  const { rideId, agreedFareNgn } = await rideOnce(rider, { offerNgn: 6000 });
  await driverDone;

  // Wallet settlement fans out through Kafka a beat after ride:completed —
  // give those frames a moment to land instead of asserting into the race.
  await Promise.allSettled([
    rider.waitFor('wallet:updated', { predicate: (p) => p.direction === 'debit', timeoutMs: 10_000 }),
    driver.waitFor('wallet:updated', { predicate: (p) => p.direction === 'credit', timeoutMs: 10_000 }),
  ]);

  console.log('\n── Assertions ──');
  const got = (actor, type, predicate = () => true) =>
    actor.frames.some((f) => f.type === type && predicate(f.payload ?? {}));

  check('rider: request acknowledged', got(rider, 'ride:request:accepted'));
  check('driver: received the ride offer', got(driver, 'ride:offer', (p) => p.rideId === rideId));
  check('rider: received the driver bid', got(rider, 'ride:counter_offer', (p) => p.rideId === rideId));
  check('driver: told the rider accepted & paid (ride:offer_accepted)',
    got(driver, 'ride:offer_accepted', (p) => p.rideId === rideId));
  const driverMatch = driver.frames.find((f) => f.type === 'ride:matched' && f.payload?.rideId === rideId);
  check('driver: matched with the full route in the payload',
    Boolean(driverMatch?.payload?.pickup?.address && driverMatch?.payload?.destination?.address),
    'pickup/destination missing — resync-proof matching broken');
  check('rider: saw arrived → started → completed',
    got(rider, 'ride:driver_arrived') && got(rider, 'ride:started') && got(rider, 'ride:completed'));
  check('rider: wallet locked for the fare',
    got(rider, 'wallet:updated', (p) => p.direction === 'lock'));
  check('rider: wallet debited on completion',
    got(rider, 'wallet:updated', (p) => p.direction === 'debit'));
  check('driver: wallet credited with earnings',
    got(driver, 'wallet:updated', (p) => p.direction === 'credit'));

  const riderWallet = await prisma.wallet.findUnique({ where: { userId: riderAuth.user.id } });
  check(`rider: balance is ₦${(50_000 - agreedFareNgn).toLocaleString()} after the ₦${agreedFareNgn} fare`,
    Number(riderWallet?.balanceNgn) === 50_000 - agreedFareNgn,
    `actual ₦${Number(riderWallet?.balanceNgn)}`);

  const bids = await api('/drivers/me/bids', { token: driverAuth.token });
  check('driver: bid recorded in history as ACCEPTED',
    bids.status === 200 && bids.body.items?.some((b) => b.rideId === rideId && b.status === 'ACCEPTED'),
    JSON.stringify(bids.body.items?.map((b) => b.status)));

  const active = await api('/drivers/me/rides/active', { token: driverAuth.token });
  check('driver: no active ride after completion', active.status === 200 && active.body.ride === null);

  rider.close();
  driver.close();
  await prisma.$disconnect();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? 'E2E PASSED' : 'E2E FAILED'} — ${checks.length - failed.length}/${checks.length} checks\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function commandE2eWave1() {
  // Marketplace integrity under the Wave-1 rules: one driver can never be
  // sold twice, losers hear the outcome, money is secured at accept, and
  // requests carry a person. Fresh actors every run.
  process.env.DATABASE_URL = SANDBOX.databaseUrl;
  const { prisma } = await import('@wheleers/db');
  const runId = Date.now().toString(36);

  async function seedRider(tag, balanceNgn) {
    const auth = await signup({
      username: `w1_${tag}_${runId}`, password: 'sandbox123', role: 'RIDER',
      name: `${tag.toUpperCase()} Rider`, phone: `+23480${String(Date.now()).slice(-8)}`,
    });
    const wallet = await prisma.wallet.findUnique({ where: { userId: auth.user.id } });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { balanceNgn } });
    return { ...auth, walletId: wallet.id };
  }
  async function seedDriver(tag) {
    const auth = await signup({
      username: `w1_${tag}_${runId}`, password: 'sandbox123', role: 'DRIVER',
      name: `${tag.toUpperCase()} Driver`, phone: `+23481${String(Date.now()).slice(-8)}`,
    });
    const row = await prisma.driver.update({
      where: { userId: auth.user.id },
      data: {
        status: 'ONLINE', kycStatus: 'APPROVED',
        lat: OPEBI.lat, lng: OPEBI.lng, lastSeenAt: new Date(),
        vehiclePlate: `W1-${tag.toUpperCase()}`, vehicleModel: 'Corolla',
      },
    });
    return { ...auth, driverId: row.id };
  }

  const [r1, r2, d1, d2] = await Promise.all([
    seedRider('r1', 50_000), seedRider('r2', 100),
    seedDriver('d1'), seedDriver('d2'),
  ]);

  const R1 = new Actor('rider1 ', r1.token);
  const R2 = new Actor('rider2 ', r2.token);
  const D1 = new Actor('driver1', d1.token);
  const D2 = new Actor('driver2', d2.token);
  await Promise.all([R1.connect(), R2.connect(), D1.connect(), D2.connect()]);

  const checks = [];
  const check = (label, ok, detail = '') => {
    checks.push({ label, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  };

  D1.send('driver:online', { lat: OPEBI.lat, lng: OPEBI.lng });
  D2.send('driver:online', { lat: OPEBI.lat, lng: OPEBI.lng });
  await D1.waitFor('driver:online:accepted');
  await D2.waitFor('driver:online:accepted');

  console.log('\n── Scenario: two riders want the same driver ──');
  R1.send('ride:request', { pickup: OPEBI, destination: SURULERE, paymentMethod: 'WALLET', offerNgn: 6000 });
  const ride1 = (await R1.waitFor('ride:request:accepted')).payload.rideId;
  const d1Offer = await D1.waitFor('ride:offer', { predicate: (p) => p.rideId === ride1 });
  await D2.waitFor('ride:offer', { predicate: (p) => p.rideId === ride1 });

  check('offers carry the rider: name + rating + trip count',
    typeof d1Offer.payload.riderName === 'string' &&
    typeof d1Offer.payload.riderRating === 'number' &&
    typeof d1Offer.payload.riderTripCount === 'number',
    JSON.stringify({ n: d1Offer.payload.riderName, r: d1Offer.payload.riderRating, t: d1Offer.payload.riderTripCount }));
  const closeMs = new Date(d1Offer.payload.bidsCloseAt ?? 0).getTime() - Date.now();
  check('offers carry the shared 90s auction clock', closeMs > 60_000 && closeMs < 95_000, `${Math.round(closeMs / 1000)}s`);

  R2.send('ride:request', { pickup: OPEBI, destination: SURULERE, paymentMethod: 'WALLET', offerNgn: 6000 });
  const ride2 = (await R2.waitFor('ride:request:accepted')).payload.rideId;
  await D1.waitFor('ride:offer', { predicate: (p) => p.rideId === ride2 });

  D1.send('driver:accept', { rideId: ride1, riderId: r1.user.id, agreedFareNgn: 6000, etaSeconds: 120 });
  D1.send('driver:accept', { rideId: ride2, riderId: r2.user.id, agreedFareNgn: 6000, etaSeconds: 120 });
  D2.send('driver:accept', { rideId: ride1, riderId: r1.user.id, agreedFareNgn: 5800, etaSeconds: 150 });

  const r1BidD1 = await R1.waitFor('ride:counter_offer', { predicate: (p) => p.driverId === d1.driverId });
  await R1.waitFor('ride:counter_offer', { predicate: (p) => p.driverId === d2.driverId });
  const r2BidD1 = await R2.waitFor('ride:counter_offer', { predicate: (p) => p.driverId === d1.driverId });
  check('bids carry their durable identity (bidId)', Boolean(r1BidD1.payload.bidId && r2BidD1.payload.bidId));

  R1.send('ride:accept_offer', {
    rideId: ride1, bidId: r1BidD1.payload.bidId,
    driverId: d1.driverId, driverUserId: d1.user.id,
    agreedFareNgn: 6000, paymentMethod: 'WALLET',
  });
  await R1.waitFor('ride:accept_offer:accepted', { predicate: (p) => p.rideId === ride1 });
  await R1.waitFor('ride:matched', { predicate: (p) => p.rideId === ride1, timeoutMs: 30_000 });

  const lost = await D2.waitFor('ride:bid_lost', { predicate: (p) => p.rideId === ride1, timeoutMs: 15_000 })
    .then(() => true).catch(() => false);
  check('the losing driver is told (ride:bid_lost)', lost);

  const withdrawn = await R2.waitFor('ride:driver_rejected', {
    predicate: (p) => p.rideId === ride2 && p.driverId === d1.driverId, timeoutMs: 15_000,
  }).then(() => true).catch(() => false);
  check("winning removes the driver's other bids (rider2 told)", withdrawn);

  R2.send('ride:accept_offer', {
    rideId: ride2, bidId: r2BidD1.payload.bidId,
    driverId: d1.driverId, driverUserId: d1.user.id,
    agreedFareNgn: 6000, paymentMethod: 'WALLET',
  });
  const busyReject = await R2.waitFor('ride:accept_offer:rejected', {
    predicate: (p) => p.rideId === ride2, timeoutMs: 15_000,
  });
  check('a busy driver cannot be bought twice',
    busyReject.payload.reason === 'driver_unavailable' || busyReject.payload.reason === 'offer_changed',
    busyReject.payload.reason);

  console.log('\n── Scenario: no hold, no match ──');
  D2.send('driver:accept', { rideId: ride2, riderId: r2.user.id, agreedFareNgn: 5500, etaSeconds: 150 });
  const r2BidD2 = await R2.waitFor('ride:counter_offer', { predicate: (p) => p.driverId === d2.driverId });
  R2.send('ride:accept_offer', {
    rideId: ride2, bidId: r2BidD2.payload.bidId,
    driverId: d2.driverId, driverUserId: d2.user.id,
    agreedFareNgn: 5500, paymentMethod: 'WALLET',
  });
  const broke = await R2.waitFor('ride:accept_offer:rejected', {
    predicate: (p) => p.reason === 'insufficient_funds', timeoutMs: 15_000,
  });
  check('an empty wallet cannot book (told the shortfall)',
    typeof broke.payload.message === 'string' && broke.payload.requiredNgn === 5500);

  await prisma.wallet.update({ where: { id: r2.walletId }, data: { balanceNgn: 50_000 } });
  R2.send('ride:accept_offer', {
    rideId: ride2, bidId: r2BidD2.payload.bidId,
    driverId: d2.driverId, driverUserId: d2.user.id,
    agreedFareNgn: 5500, paymentMethod: 'WALLET',
  });
  await R2.waitFor('ride:matched', { predicate: (p) => p.rideId === ride2, timeoutMs: 30_000 });
  const r2Wallet = await prisma.wallet.findUnique({ where: { id: r2.walletId } });
  check('funds are held at accept (locked = fare)',
    Number(r2Wallet.lockedNgn) === 5500 && Number(r2Wallet.balanceNgn) === 44_500,
    `locked=${r2Wallet.lockedNgn} balance=${r2Wallet.balanceNgn}`);

  console.log('\n── Scenario: ratings become real ──');
  D2.send('feedback:submit', { rideId: ride2, revieweeId: r2.user.id, rating: 4, reviewerRole: 'DRIVER' });
  let rated = false;
  for (let i = 0; i < 10 && !rated; i += 1) {
    await sleep(1000);
    const u = await prisma.user.findUnique({ where: { id: r2.user.id } });
    rated = Number(u.riderRating) === 4 && u.riderRatingCount === 1;
  }
  check('driver rating a rider updates the rider aggregate', rated);

  [R1, R2, D1, D2].forEach((a) => a.close());
  await prisma.$disconnect();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? 'WAVE-1 E2E PASSED' : 'WAVE-1 E2E FAILED'} — ${checks.length - failed.length}/${checks.length} checks\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'driver') await commandDriver();
  else if (command === 'rider') await commandRider(arg);
  else if (command === 'e2e') await commandE2e();
  else if (command === 'e2e-wave1') await commandE2eWave1();
  else {
    console.log('usage: sim.mjs e2e | driver | rider [offerNgn]');
    process.exit(2);
  }
} catch (error) {
  console.error(`\n[sim] FAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
