import { rideClient, safetyAlertClient } from '@wheleers/db';

/**
 * The emergency button for a WhatsApp rider: one tap on the ride card's SOS
 * button. Same table, same operators and the same two rules as the app's button
 * (http/safety.route.ts):
 *
 *   - the alert must get recorded — whatever is missing is stored as null;
 *   - one open incident per person — a frightened thumb presses repeatedly, and
 *     an operator should see one emergency, not eight.
 *
 * A chat tap carries no position, so the car's last known one is recorded:
 * during a trip that IS where the rider is.
 */
export async function raiseRiderSos(userId: string): Promise<{ alertId: string; alreadyOpen: boolean }> {
  const rideId = (await rideClient.findActiveByRider(userId).catch(() => null))?.id ?? null;
  const open = await safetyAlertClient.findOpenForUser(userId, rideId);
  if (open) return { alertId: open.id, alreadyOpen: true };

  const ride = rideId ? await rideClient.findWithDriver(rideId).catch(() => null) : null;
  const car = ride?.driver?.lat != null && ride.driver.lng != null ? { lat: ride.driver.lat, lng: ride.driver.lng } : null;
  const alert = await safetyAlertClient.raise({
    userId,
    raisedByRole: 'RIDER',
    kind: 'SOS',
    rideId,
    counterpartUserId: ride?.driver?.userId ?? null,
    lat: car?.lat ?? null,
    lng: car?.lng ?? null,
    note: [
      'Raised from the SOS button on the WhatsApp ride card.',
      car ? "Position: the DRIVER's last known position (a chat tap carries none)." : 'No position available.',
      ride ? `Trip: ${ride.pickupAddress} → ${ride.destAddress} (${ride.status}).` : 'No live trip at the time.',
    ].join(' '),
  });
  console.warn('[safety] EMERGENCY ALERT RAISED', { alertId: alert.id, userId, role: 'RIDER', rideId, source: 'whatsapp_ride_card', hasLocation: car !== null });
  return { alertId: alert.id, alreadyOpen: false };
}

/** "I'm safe": withdraw the rider's own open alert. True when there was one. */
export async function cancelRiderSos(userId: string): Promise<boolean> {
  const open = await safetyAlertClient.findOpenForUser(userId);
  if (!open) return false;
  await safetyAlertClient.cancelOwn({ id: open.id, userId, reason: 'Rider tapped "I\'m safe" in WhatsApp' });
  console.warn('[safety] alert withdrawn by the rider', { alertId: open.id, userId });
  return true;
}
