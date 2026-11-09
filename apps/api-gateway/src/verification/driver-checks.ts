/**
 * What a check found, set against what the driver gave us: the fields worth
 * keeping (never the licence photo), and each thing that does not agree, in
 * words an admin reads at a glance. Pure: no network, no database.
 *
 * A check that found the record and agrees on everything is "verified"; one
 * that found it and disagrees on something is "mismatch"; Prembly having no
 * such record is "not_found".
 */
export type CheckOutcome = 'verified' | 'mismatch' | 'not_found' | 'failed' | 'error';

export type Reading = { found: Record<string, string | number | boolean | null>; mismatches: string[] };

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** A plate or policy reg number, letters and digits only: "KJA 123 AB" and "kja-123ab" are the same plate. */
export const plateKey = (value: string | null | undefined) => (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const words = (value: string | null | undefined) =>
  (value ?? '').toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

/**
 * Two names are the same person's when they share two words (a first name
 * and a surname, in any order), or every word of the shorter one when it has
 * only one. A name not given cannot disagree.
 */
export function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = words(a);
  const right = words(b);
  if (!left.length || !right.length) return true;
  const shared = new Set(left.filter((w) => right.includes(w))).size;
  return shared >= Math.min(2, left.length, right.length);
}

/** "TOYOTA" and "Toyota Corolla" agree; "Toyota" and "Honda" do not. Either one missing cannot disagree. */
export function makesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const y = (b ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!x || !y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  // The first word of each: "MERCEDES BENZ" against "Mercedes".
  const fx = words(a)[0]; const fy = words(b)[0];
  return !!fx && !!fy && (fx.startsWith(fy) || fy.startsWith(fx));
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * A day as YYYY-MM-DD from the shapes records come in: 2026-06-03,
 * 2026-06-03T00:00:00, 03-06-2026 or 03/06/2026 (day first, as in Nigeria),
 * 3 Jun 2026, 3-JUN-26. Null when it cannot be read.
 */
export function readDay(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const valid = (y: number, m: number, d: number) => (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return valid(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{2,4})$/.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.toUpperCase()) + 1;
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return month ? valid(year, month, Number(m[1])) : null;
  }
  return null;
}

const dayWords = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const todayIso = (today: Date) => today.toISOString().slice(0, 10);

/** The driver's licence, from FRSC through Prembly, against the name and expiry the driver typed (and, with a face check, their selfie). */
export function readLicence(
  data: Record<string, unknown>,
  driver: { legalName: string | null; accountName: string | null; licenceExpiresOn: string | null },
  face: { match: boolean; confidence: number | null; message: string } | null,
  today: Date,
): Reading {
  const firstName = str(data.firstName ?? data.first_name);
  const middleName = str(data.middleName ?? data.middle_name);
  const lastName = str(data.lastName ?? data.last_name);
  const expiry = readDay(data.expiryDate ?? data.expiry_date);
  const name = [firstName, middleName, lastName].filter(Boolean).join(' ') || null;
  const mismatches: string[] = [];

  const given = driver.legalName ?? driver.accountName;
  if (name && given && !namesAgree(name, given)) mismatches.push(`The name on the licence is ${name}; the driver gave ${given}.`);
  if (expiry && expiry < todayIso(today)) mismatches.push(`FRSC says this licence expired on ${dayWords(expiry)}.`);
  else if (expiry && driver.licenceExpiresOn && expiry !== driver.licenceExpiresOn) {
    mismatches.push(`FRSC says it expires ${dayWords(expiry)}; the driver typed ${dayWords(driver.licenceExpiresOn)}.`);
  }
  if (face && !face.match) {
    mismatches.push(`The selfie does not match the licence photo${face.confidence !== null ? ` (confidence ${Math.round(face.confidence * (face.confidence <= 1 ? 100 : 1))}%)` : ''}.`);
  }

  return {
    found: {
      name,
      licenceNumber: str(data.licenseNo ?? data.licenceNo ?? data.license_no),
      gender: str(data.gender),
      stateOfIssue: str(data.stateOfIssue ?? data.state_of_issue),
      issuedOn: readDay(data.issuedDate ?? data.issued_date) ?? str(data.issuedDate),
      expiresOn: expiry ?? str(data.expiryDate),
      ...(face ? { faceMatch: face.match, faceConfidence: face.confidence } : {}),
    },
    mismatches,
  };
}

/** A plate, from the vehicle records through Prembly, against the car the driver registered. */
export function readPlate(data: Record<string, unknown>, driver: { vehicleMake: string | null; vehicleModel: string | null }): Reading {
  const make = str(data.vehicle_name ?? data.vehicle_make ?? data.make);
  const mismatches: string[] = [];
  const registered = [driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ') || null;
  if (make && driver.vehicleMake && !makesAgree(make, driver.vehicleMake)) {
    mismatches.push(`The plate's records say ${make}; the driver registered ${registered}.`);
  }
  return {
    found: { plate: str(data.vehicle_number), make, colour: str(data.vehicle_color ?? data.vehicle_colour ?? data.color) },
    mismatches,
  };
}

/** An insurance policy, from NIID through Prembly, against the driver's plate and car and the date on the paper they sent. */
export function readInsurance(
  data: Record<string, unknown>,
  driver: { plate: string | null; vehicleMake: string | null; vehicleModel: string | null; paperExpiresOn: string | null },
  today: Date,
): Reading {
  const status = str(data.policy_status);
  const regNumber = str(data.reg_number);
  const newRegNumber = str(data.new_reg_number);
  const make = str(data.vehicle_make);
  const model = str(data.vehicle_model);
  const expiry = readDay(data.expiry_date);
  const mismatches: string[] = [];

  if (status && !/^active$/i.test(status)) mismatches.push(`The policy is ${status}, not active.`);
  const plate = plateKey(driver.plate);
  const regs = [regNumber, newRegNumber].map(plateKey).filter(Boolean);
  if (plate && regs.length && !regs.includes(plate)) mismatches.push(`The policy is for plate ${regNumber ?? newRegNumber}, not the driver's ${driver.plate}.`);
  if (make && driver.vehicleMake && !makesAgree(make, driver.vehicleMake)) {
    mismatches.push(`The policy is for a ${[make, model].filter(Boolean).join(' ')}; the driver registered ${[driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ')}.`);
  }
  if (expiry && expiry < todayIso(today)) mismatches.push(`NIID says the policy ran out on ${dayWords(expiry)}.`);
  else if (expiry && driver.paperExpiresOn && expiry !== driver.paperExpiresOn) {
    mismatches.push(`NIID says it runs out ${dayWords(expiry)}; the driver typed ${dayWords(driver.paperExpiresOn)}.`);
  }

  return {
    found: {
      policyNumber: str(data.policy_number),
      status,
      plate: regNumber,
      newPlate: newRegNumber,
      cover: str(data.type_of_cover),
      vehicleType: str(data.vehicle_type),
      make,
      model,
      colour: str(data.vehicle_color),
      chassis: str(data.vehicle_chasis ?? data.vehicle_chassis),
      issuedOn: readDay(data.issue_date) ?? str(data.issue_date),
      expiresOn: expiry ?? str(data.expiry_date),
    },
    mismatches,
  };
}

/** Where an admin checks by hand what Prembly does not cover, and what each covers. */
export const MANUAL_SOURCES = [
  { key: 'autoreg', label: 'AutoReg (Lagos hackney permit)', url: 'https://verify.autoreg.ng', papers: ['hackneyPermit', 'vehicleLicence', 'lagosVehicle'] },
  { key: 'dvis', label: 'DVIS (Lagos roadworthiness)', url: 'https://dvis.lg.gov.ng/verify', papers: ['roadworthiness', 'vioInspection'] },
  { key: 'niid', label: 'NIID (insurance)', url: 'https://askniid.org', papers: ['insurance'] },
  { key: 'other', label: 'Other (a call, the owner, the paper itself)', url: null, papers: ['proofOfOwnership', 'purchaseReceipt', 'ownerLetter', 'hackneyPermit', 'vehicleLicence', 'roadworthiness', 'vioInspection', 'insurance', 'lagosVehicle'] },
] as const;
