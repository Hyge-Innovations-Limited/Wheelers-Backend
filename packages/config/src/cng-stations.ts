import { isInLagos } from './service-area';

/**
 * CNG stations in Lagos for the driver app's Stations tab (14 Nov 2026).
 * Gathered once from public sources (cngpumpnearme.com, gastecng.com,
 * bovasgroup.com, NNPC/PCNGi and Lagos State announcements). No admin:
 * change this list in code.
 *
 * pin "exact": from the station's map code; "area": the middle of its area
 * (the address is known only roughly). confirmed false: a source lists it but
 * it may not sell CNG to cars (an LPG autogas site, a supply depot).
 * NNPC Agege Bypass is left out until its spot is known.
 */
export type CngStation = {
  id: string;
  name: string;
  brand: string;
  area: string;
  address: string | null;
  lat: number;
  lng: number;
  pin: 'exact' | 'area';
  hours: string | null;
  confirmed: boolean;
};

export const LAGOS_CNG_STATIONS: readonly CngStation[] = [
  { id: "agidingbi", name: "Agidingbi CNG Station", brand: "Mobil / NNPC", area: "Ikeja", address: "Lateef Jakande Rd, Agidingbi", lat: 6.620837, lng: 3.353016, pin: "exact", hours: "6am \u2013 9pm", confirmed: true },
  { id: "dopemu-nnpc", name: "NNPC CNG Dopemu", brand: "NNPC", area: "Agege", address: "Kamoru Alimi St, Dopemu", lat: 6.613487, lng: 3.328109, pin: "exact", hours: "7am \u2013 10pm", confirmed: true },
  { id: "surulere-thld", name: "THLD Autogas Station", brand: "THLD Group", area: "Surulere", address: "Surulere", lat: 6.477188, lng: 3.326703, pin: "exact", hours: "8am \u2013 5pm", confirmed: false },
  { id: "itire-gns", name: "Gas Network Services (CNG mother station)", brand: "GNS", area: "Itire", address: "Itire", lat: 6.512638, lng: 3.328297, pin: "exact", hours: null, confirmed: false },
  { id: "idimu-bovas", name: "BOVAS CNG Idimu", brand: "BOVAS", area: "Idimu", address: "22 Ikotun Rd, Idimu", lat: 6.569562, lng: 3.283313, pin: "exact", hours: null, confirmed: true },
  { id: "abule-egba-nepal", name: "Nepal Oil and Gas", brand: "Nepal", area: "Abule Egba", address: "663 Lagos-Abeokuta Expy, Abule Egba", lat: 6.647894, lng: 3.304622, pin: "area", hours: "Open 24 hours", confirmed: true },
  { id: "kudirat-nnpc", name: "NNPC Kudirat Abiola Way", brand: "NNPC", area: "Oregun", address: "98 Kudirat Abiola Way", lat: 6.599261, lng: 3.365994, pin: "area", hours: null, confirmed: true },
  { id: "ojota-portland", name: "Portland Gas CNG Ojota", brand: "Portland Gas", area: "Ojota", address: "Ojota Interstate Bus Terminal", lat: 6.587071, lng: 3.379146, pin: "area", hours: "9am \u2013 5pm", confirmed: true },
  { id: "onigbagbo-total", name: "TotalEnergies Onigbagbo", brand: "TotalEnergies", area: "Ikeja", address: "25 Mobolaji Bank Anthony Way", lat: 6.590289, lng: 3.337905, pin: "area", hours: null, confirmed: false },
  { id: "dopemu-nipco", name: "NIPCO Dopemu", brand: "NIPCO", area: "Agege", address: "75 Surulere Rd, Dopemu", lat: 6.616358, lng: 3.313058, pin: "area", hours: null, confirmed: true },
  { id: "apapa", name: "Apapa CNG Station", brand: "Mobil / NNPC", area: "Apapa", address: "1 Mobil Rd, Apapa Quays", lat: 6.445187, lng: 3.368373, pin: "area", hours: null, confirmed: true },
  { id: "sangotedo", name: "Sangotedo CNG Station", brand: "NNPC", area: "Sangotedo", address: "Lekki-Epe Expy, Sangotedo", lat: 6.471022, lng: 3.635581, pin: "area", hours: null, confirmed: true },
  { id: "fola-agoro", name: "NNPC Fola Agoro", brand: "NNPC", area: "Shomolu", address: "Fola Agoro", lat: 6.52722, lng: 3.380801, pin: "area", hours: null, confirmed: true },
  { id: "alapere", name: "NNPC Alapere", brand: "NNPC", area: "Ketu", address: "Oworonshoki Expy, Alapere", lat: 6.588243, lng: 3.397721, pin: "area", hours: null, confirmed: true },
  { id: "marina", name: "NNPC Marina", brand: "NNPC", area: "Lagos Island", address: "Marina", lat: 6.446083, lng: 3.394802, pin: "area", hours: null, confirmed: true },
  { id: "lakowe", name: "NNPC Lakowe", brand: "NNPC", area: "Lakowe", address: "Lagos-Epe Expy, Lakowe", lat: 6.467313, lng: 3.731847, pin: "area", hours: null, confirmed: true },
  { id: "odogunyan", name: "NNPC Odogunyan", brand: "NNPC", area: "Ikorodu", address: "Ikorodu-Sagamu Rd, Odogunyan", lat: 6.658392, lng: 3.52051, pin: "area", hours: null, confirmed: true },
  { id: "ibile-agege", name: "Ibile CNG Agege", brand: "Ibile", area: "Agege", address: null, lat: 6.625252, lng: 3.31121, pin: "area", hours: null, confirmed: true },
  { id: "ibile-oshodi", name: "Ibile CNG Oshodi", brand: "Ibile", area: "Oshodi", address: null, lat: 6.557025, lng: 3.349442, pin: "area", hours: null, confirmed: true },
  { id: "ibile-abule-egba", name: "Ibile CNG Abule Egba", brand: "Ibile / MDGIF", area: "Abule Egba", address: null, lat: 6.647894, lng: 3.304622, pin: "area", hours: null, confirmed: true },
  { id: "ibile-ajah", name: "Ibile CNG Ajah", brand: "Ibile / MDGIF", area: "Ajah", address: null, lat: 6.469472, lng: 3.562386, pin: "area", hours: null, confirmed: true },
  { id: "ibile-oko-oba", name: "Ibile CNG Oko-Oba", brand: "Ibile / MDGIF", area: "Oko-Oba", address: null, lat: 6.65015, lng: 3.319374, pin: "area", hours: null, confirmed: true },
  { id: "ibile-idimu", name: "Ibile CNG Idimu", brand: "Ibile / MDGIF", area: "Idimu", address: null, lat: 6.575256, lng: 3.283904, pin: "area", hours: null, confirmed: true },
  { id: "ibile-ogolonto", name: "Ibile CNG Ogolonto", brand: "Ibile / MDGIF", area: "Ikorodu", address: null, lat: 6.619628, lng: 3.474762, pin: "area", hours: null, confirmed: true },
];

/** Lagos traffic: road distance is about 1.4 times the straight line, at about 20 km/h. */
const ROAD_FACTOR = 1.4;
const LAGOS_KMH = 20;

export function straightKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type NearbyCngStation = CngStation & { km: number; minutes: number };

/**
 * The stations nearest first from where the driver is, with the road distance
 * (km, one decimal) and the drive in minutes, both estimated. `inLagos` false
 * when the driver is outside Lagos (the tab says it is Lagos only).
 */
export function nearestCngStations(lat: number, lng: number, stations: readonly CngStation[] = LAGOS_CNG_STATIONS): { inLagos: boolean; stations: NearbyCngStation[] } {
  const list = stations
    .map((s) => {
      const roadKm = straightKm(lat, lng, s.lat, s.lng) * ROAD_FACTOR;
      return { ...s, km: Math.round(roadKm * 10) / 10, minutes: Math.max(1, Math.round((roadKm / LAGOS_KMH) * 60)) };
    })
    .sort((a, b) => a.km - b.km || a.name.localeCompare(b.name));
  return { inLagos: isInLagos(lat, lng), stations: list };
}
