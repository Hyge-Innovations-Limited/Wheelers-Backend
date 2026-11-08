/**
 * Test drivers held at a fixed spot for matching, whatever their phone says:
 * DRIVER_TEST_PINS="<driverId>@<lat>,<lng>" (several: separated by ";").
 * Only their idle position (going online, the location pings) is replaced, so
 * requests near the spot reach them; a trip's own GPS stays real. Unset: off.
 */
type Pin = { lat: number; lng: number };

let parsedFrom: string | undefined;
let pins = new Map<string, Pin>();

function readPins(): Map<string, Pin> {
  const raw = process.env.DRIVER_TEST_PINS?.trim() ?? '';
  if (raw === parsedFrom) return pins;
  parsedFrom = raw;
  pins = new Map();
  for (const entry of raw.split(';')) {
    if (!entry.trim()) continue;
    const match = /^\s*([0-9a-f-]{36})\s*@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(entry);
    const lat = Number(match?.[2]);
    const lng = Number(match?.[3]);
    if (!match || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) {
      // Once per change of the setting: a pin that does nothing must not be silent.
      console.warn('[driver-test-pin] ignored, not "<driverId>@<lat>,<lng>":', entry.trim());
      continue;
    }
    pins.set(match[1]!.toLowerCase(), { lat, lng });
  }
  return pins;
}

/** Where this driver is for matching: their pin when they have one, else where their phone says. */
export function pinnedPosition(driverId: string, lat: number, lng: number): Pin {
  return readPins().get(driverId.toLowerCase()) ?? { lat, lng };
}

/** This driver has a pin (only then is their status worth reading on a ping). */
export function hasTestPin(driverId: string): boolean {
  return readPins().has(driverId.toLowerCase());
}
