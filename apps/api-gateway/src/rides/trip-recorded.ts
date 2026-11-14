/**
 * "This trip is recorded for your safety" (Timi, 14 Nov 2026). The driver's
 * phone marks a trip as recorded a few seconds after it starts
 * (POST /drivers/me/trip-recordings/start); the consumer, which can reach the
 * rider, says so (kafka/consumer.ts sayTripRecorded). This joins the two
 * without the recording route having to know about WhatsApp or sockets.
 */
type Hook = (rideId: string) => Promise<void>;
let hook: Hook | undefined;

export function setTripRecordedHook(next: Hook | undefined): void {
  hook = next;
}

/** The trip was just marked as recorded (the first time). Never throws, never waits. */
export function tripRecordingStarted(rideId: string): void {
  if (!hook) return;
  void hook(rideId).catch((error) => console.warn('[trip-recorded] could not tell the rider', { rideId, error: error instanceof Error ? error.message : String(error) }));
}
