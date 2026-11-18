// Regression guard (17 Nov 2026): group rides are off, so every ride has groupRole NULL. What runs on every ride
// regardless of the flag must still see it: the analytics views (same columns, same order, solo rides counted), the
// NOT_GROUP_TRIP filter (spreads into a where that has its own OR and keeps NULL), and the driver's one live ride.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/regression/solo-ride-no-group.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, rideClient, NOT_GROUP_TRIP } = require('@wheleers/db');

const RIDE_FACTS = 'id rider_id driver_id status payment_method channel pickup_zone dest_zone pickup_address dest_address distance_km duration_seconds fare_estimate_ngn rider_offer_ngn fare_ngn platform_total_ngn commission_ngn service_fee_ngn state_levy_ngn fee_split_estimated cancel_stage cancel_reason superseded no_driver is_group created_at matched_at completed_at cancelled_at created_day completed_day cancelled_day trip_number started_at agreed_fare_ngn vat_ngn whatsapp_fee_ngn arrived_at booking_suggested_fare_ngn planned_distance_km bargain_rate cancelled_by first_rider_offer_ngn rider_offer_changes'.split(' ');
const RIDE_FUNNEL = 'ride_id trip_number rider_id driver_id channel pickup_zone dest_zone distance_km planned_minutes pricing_version suggested_fare_ngn rider_offer_ngn agreed_fare_ngn final_fare_ngn payment_method offers drivers_offering lowest_offer_ngn highest_offer_ngn status outcome stage_reached furthest_stage stopped_at_stage cancel_stage cancel_reason requested_at first_offer_at driver_assigned_at driver_arrived_at trip_started_at completed_at cancelled_at minutes_to_first_offer minutes_to_driver_assigned minutes_driver_to_pickup minutes_waiting_at_pickup minutes_in_trip minutes_until_cancelled requested_day requested_hour requested_weekday'.split(' ');

const made = { users: [], rides: [], drivers: [] };
const user = async (role = 'RIDER') => {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:regression:${id}`, role, name: 'Reg Guard' } });
  made.users.push(id);
  return id;
};
const ride = async (riderId, extra = {}) => {
  const r = await prisma.ride.create({ data: { riderId, status: 'REQUESTED', paymentMethod: 'WALLET', riderOfferNgn: 5000, pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.62, destLng: 3.51, destAddress: 'Ikorodu', ...extra } });
  made.rides.push(r.id);
  return r.id;
};

test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

test('ride_facts and ride_funnel keep every column, in the same order', async () => {
  for (const [view, expected] of [['ride_facts', RIDE_FACTS], ['ride_funnel', RIDE_FUNNEL]]) {
    const cols = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = ${view} ORDER BY ordinal_position`;
    assert.deepEqual(cols.map((c) => c.column_name), expected, `${view} columns`);
  }
});

test('a solo ride (groupRole NULL) is counted by both views and is not a group ride; a group TRIP is not counted; a SEAT is', async () => {
  const a = await user(); const g = await user(); const s = await user();
  const solo = await ride(a);
  const trip = await ride(g, { groupRole: 'TRIP' });
  const seat = await ride(s, { groupRole: 'SEAT', groupTripId: trip });
  const ids = [solo, trip, seat];
  const facts = await prisma.$queryRaw`SELECT id, is_group FROM ride_facts WHERE id = ANY(${ids})`;
  const byId = Object.fromEntries(facts.map((r) => [r.id, r.is_group]));
  assert.equal(byId[solo], false, 'solo counted, not a group ride');
  assert.equal(byId[seat], true, 'a seat counts as a group ride');
  assert.ok(!(trip in byId), 'the group trip is not counted');
  const funnel = await prisma.$queryRaw`SELECT ride_id FROM ride_funnel WHERE ride_id = ANY(${ids})`;
  assert.deepEqual(funnel.map((r) => r.ride_id).sort(), [solo, seat].sort());
});

test('NOT_GROUP_TRIP keeps solo rides, drops trips, and does not replace the where\'s own OR', async () => {
  const a = await user(); const b = await user();
  const solo = await ride(a); const trip = await ride(a, { groupRole: 'TRIP' }); const other = await ride(b);
  const rows = await prisma.ride.findMany({ where: { OR: [{ riderId: a }], ...NOT_GROUP_TRIP }, select: { id: true } });
  assert.deepEqual(rows.map((r) => r.id), [solo], 'only this rider\'s solo ride');
  const all = await prisma.ride.count({ where: { id: { in: [solo, trip, other] }, ...NOT_GROUP_TRIP } });
  assert.equal(all, 2);
});

test('the driver\'s live ride is a solo ride', async () => {
  const rid = await user(); const du = await user('DRIVER');
  const driver = await prisma.driver.create({ data: { userId: du, kycStatus: 'APPROVED', status: 'ON_RIDE', lastSeenAt: new Date() } });
  made.drivers.push(driver.id);
  const solo = await ride(rid, { status: 'DRIVER_ASSIGNED', driverId: driver.id });
  assert.equal((await rideClient.findActiveByDriver(driver.id))?.id, solo);
});
