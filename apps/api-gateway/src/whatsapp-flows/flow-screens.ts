import type { WhatsappRideMeta, WhatsappBid } from './bid-state';

const MAX_FLOW_LIST_ITEMS = 10;

// ── BID_LIST screen ───────────────────────────────────────────────────────

export function buildBidListData(
  meta: WhatsappRideMeta,
  bids: WhatsappBid[],
  error?: string,
): Record<string, unknown> {
  const capped = bids.slice(0, MAX_FLOW_LIST_ITEMS);
  const bidItems = capped.map((bid, index) => ({
    id: `bid-${bid.driverId}`,
    title: `${bid.driverName} — ₦${bid.counterOfferNgn.toLocaleString()}`,
    description: `${bid.vehicleModel} | ${bid.driverRating.toFixed(1)}★ | ETA ${Math.ceil(bid.etaSeconds / 60)} min`,
  }));

  const countLabel = bids.length > MAX_FLOW_LIST_ITEMS
    ? `Showing ${MAX_FLOW_LIST_ITEMS} of ${bids.length} offers`
    : `${bids.length} offer${bids.length === 1 ? '' : 's'}`;
  const hasBids = bidItems.length > 0;

  return {
    route_summary: `${meta.pickupAddress} → ${meta.destinationAddress}`,
    offer_amount: `₦${meta.offerNgn.toLocaleString()}`,
    offer_line: `Your offer: ₦${meta.offerNgn.toLocaleString()}`,
    bids: bidItems,
    bid_count: countLabel,
    has_bids: hasBids,
    has_no_bids: !hasBids,
    waiting_line:
      'No offers yet — drivers around you are seeing your request right now. Tap Continue below to check for new offers.',
    bid_actions: [
      { id: 'accept', title: 'Accept' },
      { id: 'decline', title: 'Decline' },
    ],
    error: error ?? '',
    has_error: !!error,
  };
}

// ── TOP_UP screen — wallet short at accept; VA details + re-check ────────

export function buildTopUpData(params: {
  fareNgn: number;
  balanceNgn: number;
  virtualAccount?: { bankName: string; accountNumber: string; accountName: string } | null;
  status?: string;
}): Record<string, unknown> {
  const shortNgn = Math.max(0, params.fareNgn - params.balanceNgn);
  return {
    fare_line: `Ride fare: ₦${params.fareNgn.toLocaleString()}`,
    balance_line: `Wallet: ₦${params.balanceNgn.toLocaleString()} — ₦${shortNgn.toLocaleString()} short`,
    bank_line: params.virtualAccount ? `Bank: ${params.virtualAccount.bankName}` : 'Bank: —',
    account_line: params.virtualAccount
      ? `Account: ${params.virtualAccount.accountNumber}`
      : 'Account: not set up yet — type "balance" in the chat',
    name_line: params.virtualAccount ? `Name: ${params.virtualAccount.accountName}` : '',
    note_line:
      'Transfer a little more than the shortfall to this account — deposit charges come off first. It credits your wallet in seconds; then tap the button below to book your driver.',
    status_line: params.status ?? '',
    has_status: !!params.status,
  };
}

// ── RIDE_CONFIRMED screen (driver info only) ─────────────────────────────

export function buildConfirmationData(params: {
  driverName: string;
  vehicleModel: string;
  vehiclePlate: string;
  etaSeconds: number;
  fareNgn: number;
  driverRating: number;
}): Record<string, unknown> {
  const etaMin = Math.ceil(params.etaSeconds / 60);

  return {
    driver_name: params.driverName,
    vehicle_info: `${params.vehicleModel} (${params.vehiclePlate})`,
    rating: `${params.driverRating.toFixed(1)}★`,
    eta: `${etaMin} minute${etaMin === 1 ? '' : 's'}`,
    fare: `₦${params.fareNgn.toLocaleString()}`,
    // Flow JSON 5.1 cannot interpolate inside literals — ship whole lines.
    headline_line: `${params.driverName} is on the way!`,
    rating_line: `Rating: ${params.driverRating.toFixed(1)}★`,
    eta_line: `ETA: ${etaMin} minute${etaMin === 1 ? '' : 's'}`,
    fare_line: `Fare: ₦${params.fareNgn.toLocaleString()}`,
  };
}

// ── PAYMENT screen ────────────────────────────────────────────────────────

export function buildPaymentData(params: {
  fareNgn: number;
  walletBalanceNgn: number;
  virtualAccount?: {
    bankName: string;
    accountNumber: string;
    accountName: string;
  } | null;
}): Record<string, unknown> {
  const needsFunding = params.walletBalanceNgn < params.fareNgn;

  return {
    fare: `Ride fare: ₦${params.fareNgn.toLocaleString()}`,
    wallet_balance: `Wallet: ₦${params.walletBalanceNgn.toLocaleString()}`,
    status: needsFunding
      ? `You need ₦${(params.fareNgn - params.walletBalanceNgn).toLocaleString()} more. Transfer to your virtual account below.`
      : 'Your wallet has enough funds. Payment will be deducted automatically.',
    bank_name: params.virtualAccount?.bankName ?? '',
    account_number: params.virtualAccount?.accountNumber ?? '',
    account_name: params.virtualAccount?.accountName ?? '',
    bank_line: params.virtualAccount ? `Bank: ${params.virtualAccount.bankName}` : '',
    account_line: params.virtualAccount ? `Account: ${params.virtualAccount.accountNumber}` : '',
    name_line: params.virtualAccount ? `Name: ${params.virtualAccount.accountName}` : '',
    has_virtual_account: !!params.virtualAccount,
    transfer_note: needsFunding
      ? 'Transfer to this account to fund your wallet. Your driver will be notified once payment is received.'
      : 'Transfer to this account anytime to top up your wallet.',
  };
}

// ── RIDE_SETUP screen ─────────────────────────────────────────────────────

export function buildRideSetupData(params: {
  pickupAddress: string;
  destinationAddress: string;
  error?: string;
}): Record<string, unknown> {
  return {
    pickup_address: params.pickupAddress,
    destination_address: params.destinationAddress,
    error: params.error ?? '',
    has_error: !!params.error,
  };
}

export function buildFareConfirmData(params: {
  pickupAddress: string;
  destinationAddress: string;
  suggestedFareNgn: number;
  minOfferNgn?: number;
  distanceKm?: number;
  durationSeconds?: number;
  error?: string;
}): Record<string, unknown> {
  const tripLine =
    params.distanceKm && params.durationSeconds
      ? `${params.distanceKm.toFixed(1)} km · ~${Math.ceil(params.durationSeconds / 60)} min`
      : '';

  return {
    route_line: `${params.pickupAddress} → ${params.destinationAddress}`,
    trip_line: tripLine,
    has_trip_line: tripLine.length > 0,
    suggested_fare_line: `Suggested fare: ₦${params.suggestedFareNgn.toLocaleString()}`,
    min_fare_line: params.minOfferNgn
      ? `Minimum offer: ₦${params.minOfferNgn.toLocaleString()}`
      : '',
    has_min_fare_line: !!params.minOfferNgn,
    suggested_fare_value: String(params.suggestedFareNgn),
    pickup_address: params.pickupAddress,
    destination_address: params.destinationAddress,
    error: params.error ?? '',
    has_error: !!params.error,
  };
}

// ── DRIVER_PROFILE screen ────────────────────────────────────────────────

export function buildDriverProfileData(params: {
  driverName: string;
  phoneNumber: string;
  vehicleInfo: string;
  vehiclePlate: string;
  ratingInfo: string;
  eta: string;
  fare: string;
  driverPhoto: string;
  vehiclePhoto: string;
}): Record<string, unknown> {
  return {
    driver_name: params.driverName,
    phone_number: params.phoneNumber || 'Not available',
    vehicle_info: params.vehicleInfo,
    vehicle_plate: params.vehiclePlate,
    rating_info: params.ratingInfo,
    eta: params.eta,
    fare: params.fare,
    plate_line: `Plate: ${params.vehiclePlate}`,
    fare_line: `Fare: ${params.fare}`,
    paid_line: 'Fare secured from your wallet ✓ — released to the driver when your trip completes.',
    eta_line: `ETA: ${params.eta}`,
    phone_line: `Call: ${params.phoneNumber || 'Not available'}`,
    driver_photo: params.driverPhoto,
    has_driver_photo: params.driverPhoto.length > 0,
    vehicle_photo: params.vehiclePhoto,
    has_vehicle_photo: params.vehiclePhoto.length > 0,
  };
}

// ── Utility screens ───────────────────────────────────────────────────────

export function buildNotifyExitData(message: string): Record<string, unknown> {
  return { message };
}

export function buildErrorData(message: string): Record<string, unknown> {
  return { message };
}
