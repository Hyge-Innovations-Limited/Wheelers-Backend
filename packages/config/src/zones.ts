/**
 * Launch zones: the areas Wheelers operates in, by name. A ride is stamped with
 * the zone of its pickup and of its destination when it is created, and the
 * admin dashboard filters and breaks down by these names.
 *
 * Each zone is a simple polygon of [lat, lng] corners, drawn generously around
 * the neighbourhood. They are approximations for reporting, not a service fence:
 * a ride outside every zone still happens, it is just reported as outside.
 *
 * To launch somewhere new, add a zone here. Old rides keep the zone they were
 * stamped with; scripts/backfill-ride-analytics.mjs re-stamps them if needed.
 */

export interface LaunchZone {
  /** Stored on the ride and shown on the dashboard. Never rename one in use. */
  name: string;
  /** Corners in order, [lat, lng]. The shape closes itself. */
  polygon: Array<[number, number]>;
}

export const LAUNCH_ZONES: LaunchZone[] = [
  {
    // Yaba, Akoka and the University of Lagos, Sabo, Onike, Jibowu, the east of Ebute Metta.
    name: 'Yaba',
    polygon: [
      [6.530, 3.362],
      [6.530, 3.404],
      [6.490, 3.404],
      [6.490, 3.362],
    ],
  },
  {
    // Lagos Island, Ikoyi and Victoria Island, up to where Lekki begins.
    name: 'Lagos Island',
    polygon: [
      [6.470, 3.375],
      [6.470, 3.455],
      [6.415, 3.455],
      [6.415, 3.375],
    ],
  },
];

/** What the dashboard calls a place outside every launch zone. */
export const OUTSIDE_ZONES_LABEL = 'Outside launch zones';

/** Ray casting: is the point inside the polygon? */
function inside(lat: number, lng: number, polygon: Array<[number, number]>): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i]!;
    const [latJ, lngJ] = polygon[j]!;
    const crosses = (lngI > lng) !== (lngJ > lng)
      && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (crosses) hit = !hit;
  }
  return hit;
}

/** The launch zone a point falls in, or null when it is outside all of them. */
export function zoneFor(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  for (const zone of LAUNCH_ZONES) {
    if (inside(lat, lng, zone.polygon)) return zone.name;
  }
  return null;
}
