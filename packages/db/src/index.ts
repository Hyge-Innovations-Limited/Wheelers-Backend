// Singleton client — import this if you ever need raw Prisma access
export { prisma } from './prisma';

// Scoped clients — import only the one your service owns
export { userClient }           from './clients/user.client';
export { driverClient }         from './clients/driver.client';
export { rideClient }           from './clients/rider.client';
export { driverBidClient }      from './clients/driver-bid.client';
export { scheduledRideClient }  from './clients/scheduled-ride.client';
export { outboxClient }         from './clients/outbox.client';
export { walletClient }         from './clients/wallet.client';
export { withdrawalClient }     from './clients/withdrawal.client';
export { virtualAccountClient, ACTIVE_PAYMENT_PROVIDER } from './clients/virtual-account.client';
export { PLATFORM_USER_ID, ensurePlatformWalletId } from './clients/platform-wallet';
export { groupRideClient }      from './clients/group-ride.client';
export { complianceClient }     from './clients/compliance.client';
export { referralClient }       from './clients/referral.client';
export { chatClient }           from './clients/chat.client';
export { riderKycClient }       from './clients/rider-kyc.client';
export { adminClient }          from './clients/admin.client';
export { analyticsClient }      from './clients/analytics.client';
export { activityClient }       from './clients/activity.client';
export { memoryClient }         from './clients/memory.client';
export type { MemoryFactInput, MemoryRole } from './clients/memory.client';
export { adminMetricsClient }   from './clients/admin-metrics.client';
export { interstateClient, InterstateError, refundFractionFor } from './clients/interstate.client';
export type { BookingMode, QuoteResult } from './clients/interstate.client';
export {
  minimumOfferNgn,
  isBidBelowFare,
  vehiclePriceNgn,
  seatPriceNgn,
  priceForBooking,
  vehicleClass,
  VEHICLE_CLASSES,
  RATE_PER_KM_NGN,
} from './clients/interstate-pricing';
export type { InterstateVehicleType, VehicleClass } from './clients/interstate-pricing';
export { safetyAlertClient, LIVE_ALERT_STATUSES } from './clients/safety-alert.client';
export type {
  SafetyAlertRole,
  SafetyAlertKind,
  SafetyAlertStatus,
  SafetyAlertWithPeople,
} from './clients/safety-alert.client';
export type { AdminUserListRow } from './clients/admin-metrics.client';
export type { ActivityEventInput } from './clients/activity.client';

// Re-export Prisma types so services don't need to install @prisma/client directly
export type {
  User,
  Driver,
  Ride,
  RideStop,
  ScheduledRide,
  Wallet,
  VirtualAccount,
  RideHold,
  Transaction,
  GpsLog,
  Dispute,
  Feedback,
  UserConsent,
  Notification,
  NotificationDevice,
  WalletReservation,
  WithdrawalRequest,
  GroupRideMatchRequest,
  GroupRideFaceVerification,
  ReferralCode,
  Referral,
  ReferralCashback,
  ReferralCashbackUsage,
  ReferralCashbackUnlock,
  ChatMessage,
  RiderKycAttempt,
  Prisma,
} from '@prisma/client';

export {
  UserRole,
  KycStatus,
  DriverStatus,
  RideStatus,
  CancelStage,
  TransactionDirection,
  TransactionType,
  DisputeStatus,
  DisputeResolution,
  ConsentType,
  NotificationCategory,
  WalletReservationKind,
  WalletReservationStatus,
  WithdrawalRequestStatus,
  GroupRideMatchRequestStatus,
  GroupRideFaceVerificationStatus,
  GroupRideGenderPreference,
  RideHoldStatus,
  RideStopStatus,
  RideStopType,
  ScheduledRideStatus,
  ScheduledRidePaymentMethod,
  ReferralStatus,
  ReferralCashbackType,
  ReferralCashbackStatus,
  ReferralCashbackUsageStatus,
  ChatSenderRole,
  RidePaymentMethod,
  RiderKycStatus,
} from '@prisma/client';
