/**
 * The parts of Lagos priced against the standard (Yaba and Lagos Island, and
 * anywhere not named here). Each has a pickup factor and a drop-off factor in
 * the pricing settings (PricingSettings.areas), 1 until real prices there say
 * otherwise (npm run pricing sample … AREA, then area-fit); a trip takes the
 * larger of its two.
 *
 * The outer areas (Ikorodu, Epe, Ibeju-Lekki, Badagry), where drivers are few
 * and come back empty: local government outlines from OpenStreetMap
 * (© OpenStreetMap contributors, ODbL), simplified to about a hundred metres.
 * Three neighbourhoods have their own boxes (Maryland, Lekki, Ajah), and
 * every other part of Lagos is in its local government area: all 20 of them,
 * outlined from OpenStreetMap (lga-outlines.ts), each with its own factors,
 * ×1 until set by hand (npm run pricing area KEY P D) or learned from prices
 * there (sample … KEY, then area-fit). The first area a point falls in is its
 * area, so a neighbourhood comes before the local government around it
 * (Maryland before Ikeja, Lekki and Ajah before Eti-Osa).
 */

import { LGA_OUTLINES, type LgaKey } from './lga-outlines';

export type PricingAreaKey = LgaKey | 'maryland' | 'lekki' | 'ajah';

export interface PricingArea {
  key: PricingAreaKey;
  name: string;
  /** A point in its main town, for pricing a sample trip there (npm run pricing try … AREA). */
  center: readonly [number, number];
  /** [lat, lng] corners in order; the shape closes itself. */
  outline: ReadonlyArray<readonly [number, number]>;
}

/** A box from its south-west and north-east corners, as an outline. */
const box = (south: number, west: number, north: number, east: number): PricingArea['outline'] =>
  [[south, west], [north, west], [north, east], [south, east]];

export const PRICING_AREAS: readonly PricingArea[] = [
  {
    key: 'ikorodu',
    name: 'Ikorodu',
    center: [6.6194, 3.5105],
    outline: [
      [6.63730, 3.43437], [6.61755, 3.43487], [6.60818, 3.44228], [6.60735, 3.44644], [6.59971, 3.45385], [6.59925, 3.45755],
      [6.58547, 3.46551], [6.58921, 3.47093], [6.59478, 3.46955], [6.59719, 3.47729], [6.59119, 3.48129], [6.58428, 3.47981],
      [6.56896, 3.47042], [6.55067, 3.46778], [6.54100, 3.47722], [6.53221, 3.49132], [6.53170, 3.50658], [6.52437, 3.52632],
      [6.52737, 3.53816], [6.53333, 3.54665], [6.53080, 3.55636], [6.53130, 3.56330], [6.55868, 3.59035], [6.55590, 3.60594],
      [6.55641, 3.62397], [6.55021, 3.63245], [6.55021, 3.64253], [6.55995, 3.65034], [6.56855, 3.66838], [6.58193, 3.67991],
      [6.59498, 3.69674], [6.60487, 3.70466], [6.62683, 3.69300], [6.63438, 3.68481], [6.63997, 3.68228], [6.64382, 3.68281],
      [6.65578, 3.69012], [6.66801, 3.69172], [6.67877, 3.69876], [6.68381, 3.69985], [6.68548, 3.46108], [6.67872, 3.46161],
      [6.67604, 3.46416], [6.66897, 3.46149], [6.67243, 3.45120], [6.67517, 3.44882], [6.66727, 3.44356], [6.65225, 3.45257],
      [6.64448, 3.45429], [6.63943, 3.45766], [6.64058, 3.44828], [6.63730, 3.43437],
    ],
  },
  {
    key: 'epe',
    name: 'Epe',
    center: [6.5841, 3.9834],
    outline: [
      [6.49026, 3.61864], [6.48747, 3.62183], [6.48098, 3.64058], [6.48785, 3.64506], [6.49329, 3.65383], [6.49257, 3.66514],
      [6.55632, 3.81831], [6.56302, 3.84857], [6.56203, 3.85675], [6.55583, 3.87237], [6.51346, 3.92337], [6.50688, 3.95411],
      [6.50763, 3.96042], [6.43138, 3.95967], [6.42659, 3.99058], [6.43340, 3.99198], [6.43391, 3.98424], [6.49510, 3.99154],
      [6.49466, 4.00140], [6.48918, 4.00855], [6.48352, 4.00936], [6.47205, 4.01742], [6.46305, 4.04499], [6.45923, 4.05020],
      [6.44606, 4.05851], [6.43369, 4.07195], [6.43610, 4.08738], [6.42663, 4.10450], [6.42427, 4.11624], [6.42986, 4.12741],
      [6.43308, 4.14477], [6.43085, 4.15171], [6.42192, 4.15866], [6.42019, 4.16535], [6.42366, 4.19536], [6.41944, 4.20478],
      [6.40456, 4.21495], [6.38059, 4.24258], [6.37216, 4.32250], [6.36668, 4.35091], [6.42763, 4.35084], [6.43581, 4.34340],
      [6.43953, 4.33720], [6.43779, 4.32406], [6.43947, 4.30394], [6.43461, 4.29558], [6.43876, 4.28128], [6.43790, 4.27900],
      [6.44276, 4.27242], [6.44356, 4.26381], [6.44133, 4.25434], [6.43433, 4.25327], [6.43447, 4.24527], [6.43817, 4.23688],
      [6.44476, 4.23569], [6.44562, 4.22583], [6.45048, 4.22183], [6.46305, 4.21733], [6.46447, 4.21339], [6.46191, 4.20346],
      [6.46320, 4.19374], [6.46548, 4.19217], [6.47006, 4.17745], [6.47363, 4.17202], [6.47472, 4.16107], [6.48721, 4.15944],
      [6.49664, 4.15501], [6.49878, 4.15615], [6.50363, 4.16771], [6.50867, 4.17400], [6.51513, 4.17833], [6.52526, 4.20610],
      [6.53774, 4.22226], [6.55762, 4.22873], [6.56196, 4.22311], [6.58174, 4.21176], [6.58847, 4.19958], [6.58575, 4.19881],
      [6.58486, 4.18675], [6.58642, 4.17960], [6.58866, 4.17826], [6.59337, 4.16634], [6.59218, 4.16224], [6.57509, 4.14300],
      [6.57102, 4.12891], [6.56342, 4.11640], [6.55829, 4.11060], [6.54690, 4.10948], [6.54591, 4.10304], [6.54598, 4.09474],
      [6.54929, 4.09358], [6.55073, 4.09537], [6.55528, 4.09197], [6.56183, 4.09064], [6.56264, 4.08861], [6.55877, 4.08610],
      [6.56355, 4.06823], [6.56240, 4.06494], [6.56955, 4.06706], [6.58056, 4.06489], [6.59644, 4.05750], [6.61108, 4.05653],
      [6.61916, 4.05048], [6.62470, 4.05658], [6.63596, 4.05879], [6.63615, 4.06433], [6.63319, 4.07043], [6.63707, 4.07671],
      [6.63762, 4.08151], [6.64483, 4.08797], [6.65258, 4.09148], [6.65152, 4.09523], [6.66607, 4.09037], [6.67068, 4.09425],
      [6.67899, 4.09148], [6.68381, 3.69985], [6.67877, 3.69876], [6.66801, 3.69172], [6.65578, 3.69012], [6.64382, 3.68281],
      [6.63997, 3.68228], [6.63438, 3.68481], [6.62683, 3.69300], [6.60487, 3.70466], [6.59498, 3.69674], [6.58193, 3.67991],
      [6.56855, 3.66838], [6.55995, 3.65034], [6.55021, 3.64253], [6.53087, 3.63462], [6.52329, 3.62375], [6.49888, 3.62871],
      [6.49230, 3.61879], [6.49026, 3.61864],
    ],
  },
  {
    key: 'ibeju-lekki',
    name: 'Ibeju-Lekki',
    center: [6.43, 3.75],
    outline: [
      [6.41660, 3.62605], [6.41972, 3.69417], [6.42667, 3.74750], [6.42611, 3.84528], [6.42139, 3.99111], [6.41315, 4.05101],
      [6.38890, 4.18105], [6.38059, 4.24258], [6.40456, 4.21495], [6.41944, 4.20478], [6.42366, 4.19536], [6.42019, 4.16535],
      [6.42192, 4.15866], [6.43085, 4.15171], [6.43308, 4.14477], [6.42986, 4.12741], [6.42427, 4.11624], [6.42663, 4.10450],
      [6.43610, 4.08738], [6.43369, 4.07195], [6.44606, 4.05851], [6.45923, 4.05020], [6.46305, 4.04499], [6.47205, 4.01742],
      [6.48352, 4.00936], [6.48918, 4.00855], [6.49466, 4.00140], [6.49510, 3.99154], [6.43391, 3.98424], [6.43340, 3.99198],
      [6.42659, 3.99058], [6.43138, 3.95967], [6.50763, 3.96042], [6.50688, 3.95411], [6.51346, 3.92337], [6.55583, 3.87237],
      [6.56104, 3.86047], [6.56302, 3.84857], [6.55632, 3.81831], [6.49257, 3.66514], [6.48846, 3.66878], [6.47787, 3.67157],
      [6.47696, 3.67362], [6.41660, 3.62605],
    ],
  },
  {
    key: 'badagry',
    name: 'Badagry',
    center: [6.415, 2.8813],
    outline: [
      [6.45136, 2.70667], [6.37258, 2.70698], [6.39176, 2.85050], [6.39612, 2.97011], [6.39467, 3.02319], [6.39661, 3.06899],
      [6.40974, 3.08635], [6.40771, 3.09774], [6.40913, 3.10689], [6.42519, 3.10912], [6.43170, 3.10607], [6.43800, 3.10668],
      [6.46036, 3.09347], [6.46707, 3.09367], [6.46545, 3.10221], [6.47033, 3.11339], [6.47175, 3.11522], [6.48029, 3.11665],
      [6.48558, 3.11177], [6.49167, 3.11197], [6.49411, 3.10668], [6.49946, 3.10395], [6.49778, 3.09587], [6.49945, 3.06316],
      [6.49806, 3.02831], [6.50256, 2.98678], [6.50026, 2.94864], [6.50264, 2.92427], [6.50120, 2.92019], [6.50437, 2.90943],
      [6.50149, 2.90351], [6.50193, 2.89290], [6.49171, 2.89730], [6.48007, 2.89366], [6.46989, 2.88058], [6.47171, 2.86930],
      [6.46771, 2.86022], [6.45167, 2.85448], [6.44395, 2.84281], [6.44237, 2.83050], [6.45127, 2.81994], [6.45831, 2.80149],
      [6.45731, 2.79389], [6.45079, 2.78362], [6.44842, 2.77584], [6.44736, 2.75748], [6.44776, 2.74574], [6.45566, 2.73406],
      [6.45742, 2.71868], [6.45136, 2.70667],
    ],
  },
  // Inside Lagos: priced against Yaba and the Island, where the other app charges more.
  {
    // Maryland, Mende and Onigbongbo: inside Ikeja's box, so first.
    key: 'maryland',
    name: 'Maryland',
    center: [6.5715, 3.3676],
    outline: box(6.560, 3.355, 6.585, 3.385),
  },
  {
    // Lekki Phase 1, Ikate, Agungi, Osapa, Chevron, Jakande, Ikota: from the toll gate.
    key: 'lekki',
    name: 'Lekki',
    center: [6.4474, 3.4720],
    outline: box(6.415, 3.455, 6.475, 3.550),
  },
  {
    // Ajah, Badore, Addo, Sangotedo, Abraham Adesanya, up to where Ibeju-Lekki starts.
    key: 'ajah',
    name: 'Ajah',
    center: [6.4670, 3.5710],
    outline: box(6.415, 3.550, 6.500, 3.624),
  },
  // The rest of Lagos, by local government (the four outer ones are above).
  ...lgaAreas([
    // Ikeja GRA, Allen, Alausa, Opebi, Oregun, Agidingbi, Ogba and the airport.
    ['ikeja', [6.6018, 3.3515]],
    // Surulere, Ojuelegba, Aguda, Itire, Ijeshatedo, Masha, Adeniran Ogunsanya.
    ['surulere', [6.5000, 3.3500]],
    ['agege', [6.6180, 3.3210]],
    ['ajeromi-ifelodun', [6.4550, 3.3330]],
    // Alagbado, Abule Egba, Ipaja, Egbeda, Ikotun, Igando.
    ['alimosho', [6.5920, 3.2930]],
    // Festac, Mile 2, Satellite Town.
    ['amuwo-odofin', [6.4660, 3.2840]],
    ['apapa', [6.4490, 3.3590]],
    // Victoria Island, Ikoyi, Oniru, Lekki outside its box.
    ['eti-osa', [6.4281, 3.4219]],
    ['ifako-ijaiye', [6.6400, 3.3200]],
    // Gbagada, Ojota, Ketu, Mile 12, Ogudu.
    ['kosofe', [6.5550, 3.3900]],
    ['mushin', [6.5270, 3.3500]],
    ['ojo', [6.4600, 3.1800]],
    ['oshodi-isolo', [6.5550, 3.3430]],
    // Shomolu, Bariga, Akoka (Unilag).
    ['shomolu', [6.5390, 3.3850]],
    // Yaba, Ebute Metta, Iwaya.
    ['lagos-mainland', [6.5070, 3.3780]],
    ['lagos-island', [6.4520, 3.3900]],
  ]),
];

/** Local government areas as pricing areas, each with a point in its main town. */
function lgaAreas(list: ReadonlyArray<readonly [LgaKey, readonly [number, number]]>): PricingArea[] {
  return list.map(([key, center]) => ({ key, name: LGA_OUTLINES[key].name, center, outline: LGA_OUTLINES[key].parts[0]! }));
}

function inside(outline: PricingArea['outline'], lat: number, lng: number): boolean {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [latI, lngI] = outline[i]!;
    const [latJ, lngJ] = outline[j]!;
    if (latI > lat !== latJ > lat && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI) hit = !hit;
  }
  return hit;
}

/** The pricing area a point is in, or null for the rest of Lagos. */
export function pricingAreaOf(lat: number, lng: number): PricingArea | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return PRICING_AREAS.find((area) => inside(area.outline, lat, lng)) ?? null;
}
