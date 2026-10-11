/**
 * The papers a driver keeps for the car they drive, beyond the five steps of
 * verification (NIN, licence, selfie, vehicle details, vehicle photos).
 *
 * They are in NEEDS: each need is met by one paper, or by any one of a few
 * that prove the same thing (a roadworthiness certificate or the VIO report
 * it is issued from; proof of ownership, the purchase receipt, or the owner's
 * letter for a driver who does not own the car). A need is "required" or
 * "optional"; that is what the app shows, and what a later rule (a deadline,
 * a block on going online) would read. Nothing here blocks anyone yet.
 *
 * To ask for another paper, add it here: the app shows whatever this lists.
 * Never rename a `type` in use: it is stored on each uploaded paper.
 */
export type DriverPaperType =
  | 'hackneyPermit'
  | 'vehicleLicence'
  | 'roadworthiness'
  | 'vioInspection'
  | 'insurance'
  | 'proofOfOwnership'
  | 'purchaseReceipt'
  | 'ownerLetter'
  | 'lagosVehicle';

export interface DriverPaper {
  type: DriverPaperType;
  label: string;
  /** One line under the label: what it is, in a driver's words. */
  hint: string;
  /** It runs out: the driver gives the date, and is asked for a new one when it passes. */
  expires: boolean;
  /** It carries a number worth keeping (a policy number, a permit number). */
  numbered: boolean;
}

export interface DriverPaperNeed {
  key: string;
  label: string;
  required: boolean;
  /** Any ONE of these meets the need. */
  anyOf: DriverPaperType[];
}

export const DRIVER_PAPERS: readonly DriverPaper[] = [
  { type: 'hackneyPermit', label: 'Hackney permit', hint: 'The permit to carry passengers for hire', expires: true, numbered: true },
  { type: 'vehicleLicence', label: 'Vehicle licence', hint: 'The yearly licence for the car', expires: true, numbered: false },
  { type: 'roadworthiness', label: 'Roadworthiness certificate', hint: 'The certificate that the car is fit for the road', expires: true, numbered: false },
  { type: 'vioInspection', label: 'VIO inspection report', hint: 'The report from the vehicle inspection', expires: true, numbered: false },
  { type: 'insurance', label: 'Insurance', hint: 'The insurance certificate for the car', expires: true, numbered: true },
  { type: 'proofOfOwnership', label: 'Proof of ownership', hint: 'The proof of ownership certificate, in your name', expires: false, numbered: false },
  { type: 'purchaseReceipt', label: 'Receipt of the car', hint: 'The receipt from when the car was bought', expires: false, numbered: false },
  { type: 'ownerLetter', label: "Owner's letter", hint: 'If the car is not yours: a signed letter from the owner letting you drive it', expires: false, numbered: false },
  { type: 'lagosVehicle', label: 'Lagos State vehicle paper', hint: 'The Lagos State paper for the car', expires: false, numbered: false },
];

export const DRIVER_PAPER_NEEDS: readonly DriverPaperNeed[] = [
  { key: 'hackney', label: 'Hackney permit', required: true, anyOf: ['hackneyPermit'] },
  { key: 'vehicleLicence', label: 'Vehicle licence', required: true, anyOf: ['vehicleLicence'] },
  { key: 'roadworthy', label: 'Roadworthiness or VIO inspection', required: true, anyOf: ['roadworthiness', 'vioInspection'] },
  { key: 'insurance', label: 'Insurance', required: true, anyOf: ['insurance'] },
  { key: 'ownership', label: 'Whose car it is', required: true, anyOf: ['proofOfOwnership', 'purchaseReceipt', 'ownerLetter'] },
  { key: 'lagos', label: 'Lagos State vehicle paper', required: true, anyOf: ['lagosVehicle'] },
];

export function driverPaper(type: string): DriverPaper | null {
  return DRIVER_PAPERS.find((paper) => paper.type === type) ?? null;
}

/** A paper counts as running out soon this many days before its date. */
export const DRIVER_PAPER_SOON_DAYS = 30;
