/**
 * Phones as people say them, for the Studio (Timi, 20 Nov 2026): "Galaxy A10s", not "SM-A107F". Only models we are
 * sure of are named (Samsung's codes, iPhone identifiers); every other phone keeps the name its maker reports.
 * And a phone tier: Android by its memory (3 GB or less low-end, 4–6 mid-range, 8+ high-end), else by the model.
 */

/** Samsung's model codes without the region letter at the end ("SM-A107F" and "SM-A107M" are both a Galaxy A10s). */
const SAMSUNG: Record<string, string> = {
  'SM-A015': 'Galaxy A01', 'SM-A022': 'Galaxy A02', 'SM-A025': 'Galaxy A02s', 'SM-A035': 'Galaxy A03', 'SM-A037': 'Galaxy A03s',
  'SM-A045': 'Galaxy A04', 'SM-A047': 'Galaxy A04s', 'SM-A055': 'Galaxy A05', 'SM-A057': 'Galaxy A05s',
  'SM-A105': 'Galaxy A10', 'SM-A107': 'Galaxy A10s', 'SM-A115': 'Galaxy A11', 'SM-A125': 'Galaxy A12', 'SM-A135': 'Galaxy A13',
  'SM-A145': 'Galaxy A14', 'SM-A146': 'Galaxy A14 5G', 'SM-A155': 'Galaxy A15', 'SM-A156': 'Galaxy A15 5G',
  'SM-A205': 'Galaxy A20', 'SM-A207': 'Galaxy A20s', 'SM-A217': 'Galaxy A21s', 'SM-A225': 'Galaxy A22', 'SM-A235': 'Galaxy A23',
  'SM-A245': 'Galaxy A24', 'SM-A256': 'Galaxy A25 5G', 'SM-A305': 'Galaxy A30', 'SM-A307': 'Galaxy A30s', 'SM-A325': 'Galaxy A32',
  'SM-A336': 'Galaxy A33 5G', 'SM-A346': 'Galaxy A34 5G', 'SM-A356': 'Galaxy A35 5G', 'SM-A505': 'Galaxy A50', 'SM-A515': 'Galaxy A51',
  'SM-A525': 'Galaxy A52', 'SM-A536': 'Galaxy A53 5G', 'SM-A546': 'Galaxy A54 5G', 'SM-A556': 'Galaxy A55 5G', 'SM-A705': 'Galaxy A70',
  'SM-A715': 'Galaxy A71', 'SM-M215': 'Galaxy M21', 'SM-G960': 'Galaxy S9', 'SM-G965': 'Galaxy S9+', 'SM-G973': 'Galaxy S10',
  'SM-G975': 'Galaxy S10+', 'SM-G980': 'Galaxy S20', 'SM-G985': 'Galaxy S20+', 'SM-G988': 'Galaxy S20 Ultra', 'SM-G991': 'Galaxy S21',
  'SM-G996': 'Galaxy S21+', 'SM-G998': 'Galaxy S21 Ultra', 'SM-S901': 'Galaxy S22', 'SM-S906': 'Galaxy S22+', 'SM-S908': 'Galaxy S22 Ultra',
  'SM-S911': 'Galaxy S23', 'SM-S916': 'Galaxy S23+', 'SM-S918': 'Galaxy S23 Ultra', 'SM-S921': 'Galaxy S24', 'SM-S926': 'Galaxy S24+',
  'SM-S928': 'Galaxy S24 Ultra', 'SM-N960': 'Galaxy Note9', 'SM-N970': 'Galaxy Note10', 'SM-N975': 'Galaxy Note10+',
  'SM-N981': 'Galaxy Note20', 'SM-N986': 'Galaxy Note20 Ultra',
};

/** iPhone identifiers ("iPhone14,5") as sold. */
const IPHONE: Record<string, string> = {
  'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8', 'iPhone10,2': 'iPhone 8 Plus', 'iPhone10,5': 'iPhone 8 Plus',
  'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X', 'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max', 'iPhone11,6': 'iPhone XS Max',
  'iPhone11,8': 'iPhone XR', 'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max',
  'iPhone12,8': 'iPhone SE (2nd gen)', 'iPhone13,1': 'iPhone 12 mini', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro',
  'iPhone13,4': 'iPhone 12 Pro Max', 'iPhone14,4': 'iPhone 13 mini', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro',
  'iPhone14,3': 'iPhone 13 Pro Max', 'iPhone14,6': 'iPhone SE (3rd gen)', 'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max', 'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max', 'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max',
};

/** The phone's name as people say it; the reported model when we do not know it; null with nothing reported. */
export function phoneName(model: string | null | undefined, maker?: string | null): string | null {
  const raw = model?.trim();
  if (!raw) return null;
  const samsung = /^(SM-[A-Z]\d{3})/i.exec(raw);
  if (samsung) return SAMSUNG[samsung[1].toUpperCase()] ?? raw;
  if (IPHONE[raw]) return IPHONE[raw];
  // A maker that is not already in the model's name goes first ("Tecno KI7", "Infinix X6525").
  const m = maker?.trim();
  return m && !raw.toLowerCase().startsWith(m.toLowerCase()) && m.length <= 12 ? `${m[0].toUpperCase()}${m.slice(1).toLowerCase()} ${raw}` : raw;
}

export type PhoneTier = 'Low-end' | 'Mid-range' | 'High-end' | 'Unknown';

/**
 * Android by its memory first (the app's reading, or the browser's, which stops at 8): 3 GB or less low-end, 4–6
 * mid-range, 8+ high-end. Without it: Samsung's family (A0x/A1x low, other A and M mid, S, Note, Fold/Flip high); an
 * iPhone XS or newer high-end, older mid-range. Computers and the rest: Unknown.
 */
export function phoneTier(d: { platform?: string | null; ramGb?: number | null; model?: string | null; formFactor?: string | null }): PhoneTier {
  if (d.formFactor === 'computer') return 'Unknown';
  if (d.platform === 'android' && typeof d.ramGb === 'number' && d.ramGb > 0) {
    if (d.ramGb <= 3) return 'Low-end';
    if (d.ramGb < 8) return 'Mid-range';
    return 'High-end';
  }
  const model = d.model?.trim() ?? '';
  const samsung = /^SM-([A-Z])(\d)(\d)/i.exec(model);
  if (samsung) {
    const family = samsung[1].toUpperCase();
    const series = Number(samsung[2]);
    if (family === 'S' || family === 'N' || family === 'G' || family === 'F') return 'High-end';
    if (family === 'A') return series <= 1 ? 'Low-end' : 'Mid-range';
    if (family === 'M') return 'Mid-range';
  }
  const iphone = /^iPhone(\d+),/.exec(model);
  if (iphone) return Number(iphone[1]) >= 11 ? 'High-end' : 'Mid-range';
  return 'Unknown';
}

export type PlatformLabel = 'Android' | 'iPhone' | 'Computer' | 'Other' | 'Unknown';

export function platformLabel(d: { platform?: string | null; formFactor?: string | null } | null | undefined): PlatformLabel {
  if (!d) return 'Unknown';
  if (d.formFactor === 'computer' || d.platform === 'windows' || d.platform === 'mac' || d.platform === 'linux') return 'Computer';
  if (d.platform === 'android') return 'Android';
  if (d.platform === 'ios') return 'iPhone';
  return d.platform ? 'Other' : 'Unknown';
}

export type SignalLabel = '4G' | '3G' | '2G' | 'Unknown';
export function signalLabel(network: string | null | undefined): SignalLabel {
  if (network === '4g') return '4G';
  if (network === '3g') return '3G';
  if (network === '2g' || network === 'slow-2g') return '2G';
  return 'Unknown';
}
