import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';
import { calculateRideFees } from '@wheleers/config';

import type { WalletRepository } from '../types';
import type { WalletEventsProducer } from '../producers/wallet-events.producer';

export function createRideEventsConsumer(params: {
  walletRepository: WalletRepository;
  walletEventsProducer: WalletEventsProducer;
  serviceId?: string;
}) {
  const {
    walletRepository,
    walletEventsProducer,
    serviceId = 'wallet-service',
  } = params;

  return {
    async handle(value: unknown, _context: MessageContext): Promise<void> {
      const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
        // Cash rides skip wallet hold — driver collects cash directly
        if (event.paymentMethod === 'CASH') {
          console.info(`[${serviceId}][escrow] hold skipped — cash ride`, {
            rideId: event.rideId,
            riderId: event.riderId,
          });
          return;
        }

        try {
          const wallet = await walletRepository.findByUserId(event.riderId);
          if (!wallet) {
            console.error(`[${serviceId}][escrow] CRITICAL: no wallet for rider — ride proceeding with NO escrow`, {
              rideId: event.rideId,
              riderId: event.riderId,
              agreedFareNgn: event.agreedFareNgn,
            });
            return;
          }

          const fees = calculateRideFees(event.agreedFareNgn);
          const holdResult = await walletRepository.createRideHold({
            rideId: event.rideId,
            walletId: wallet.id,
            riderId: event.riderId,
            driverUserId: event.driverUserId,
            amountNgn: fees.totalNgn,
          });

          if (!holdResult.applied) {
            console.info(`[${serviceId}][escrow] hold already existed — duplicate event ignored`, {
              rideId: event.rideId,
              riderId: event.riderId,
              existingHoldNgn: holdResult.holdAmountNgn,
            });
            return;
          }

          console.info(`[${serviceId}][escrow] HELD rider funds`, {
            rideId: event.rideId,
            riderId: event.riderId,
            driverUserId: event.driverUserId,
            walletId: wallet.id,
            heldNgn: fees.totalNgn,
            agreedFareNgn: event.agreedFareNgn,
            riderBalanceAfterNgn: Number(holdResult.wallet.balanceNgn),
            riderLockedAfterNgn: Number(holdResult.wallet.lockedNgn),
          });

          await walletEventsProducer.publishLocked({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            lockedAmountNgn: event.agreedFareNgn,
            rideId: event.rideId,
            reason: 'ride_fare_hold',
          }, { key: event.rideId });

          // The ledger hold IS the escrow. All cash sits pooled in one
          // provider balance, and a held naira cannot be withdrawn, so no
          // real-money movement is needed to secure the trip.
        } catch (error) {
          // The ride is already matched at this point — it will run with no
          // escrow behind it, and settlement at completion will find no hold.
          console.error(`[${serviceId}][escrow] CRITICAL: hold creation FAILED — ride is running unsecured`, {
            rideId: event.rideId,
            riderId: event.riderId,
            driverUserId: event.driverUserId,
            agreedFareNgn: event.agreedFareNgn,
            error: getErrorMessage(error),
          });
        }

        return;
      }

      if (event.eventType === 'RIDE_ROUTE_UPDATED') {
        if (event.fareEstimateNgn === undefined) {
          return;
        }

        try {
          const routeFees = calculateRideFees(event.fareEstimateNgn);
          const holdResult = await walletRepository.adjustRideHold({
            rideId: event.rideId,
            targetAmountNgn: routeFees.totalNgn,
          });

          if (!holdResult || !holdResult.applied) {
            return;
          }

          console.info(`[${serviceId}][escrow] hold adjusted — route changed`, {
            rideId: event.rideId,
            walletId: holdResult.wallet.id,
            previousHeldNgn: holdResult.previousHoldAmountNgn,
            newHeldNgn: holdResult.holdAmountNgn,
            deltaNgn: holdResult.holdAmountNgn - holdResult.previousHoldAmountNgn,
            balanceAfterNgn: Number(holdResult.wallet.balanceNgn),
            lockedAfterNgn: Number(holdResult.wallet.lockedNgn),
          });

          await walletEventsProducer.publishHoldAdjusted({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            previousLockedAmountNgn: holdResult.previousHoldAmountNgn,
            lockedAmountNgn: holdResult.holdAmountNgn,
            rideId: event.rideId,
            reason: 'ride_route_updated',
          }, { key: event.rideId });
        } catch (error) {
          // Non-fatal: the original hold stands, so the ride is still covered
          // up to the old amount — but the shortfall is real if the fare rose.
          console.warn(`[${serviceId}][escrow] hold adjust failed — original hold still stands`, {
            rideId: event.rideId,
            attemptedTargetNgn: calculateRideFees(event.fareEstimateNgn).totalNgn,
            error: getErrorMessage(error),
          });
        }

        return;
      }

      if (event.eventType === 'RIDE_COMPLETED') {
        // Cash rides skip wallet settlement — driver already collected cash
        if (event.paymentMethod === 'CASH') {
          console.info(`[${serviceId}][escrow] settlement skipped — cash ride`, {
            rideId: event.rideId,
            driverUserId: event.driverUserId,
            fareNgn: event.fareNgn,
          });
          return;
        }

        try {
          const completionFees = calculateRideFees(event.fareNgn);

          const result = await walletRepository.completeRideHoldWithDriverPayout({
            rideId: event.rideId,
            fareNgn: event.fareNgn,
            driverUserId: event.driverUserId,
          });

          // No hold at all: the ride completed but nothing was ever escrowed,
          // so the driver is NOT getting paid. This used to return silently.
          if (!result) {
            console.error(`[${serviceId}][escrow] CRITICAL: ride completed with NO hold — driver NOT paid`, {
              rideId: event.rideId,
              driverUserId: event.driverUserId,
              riderId: event.riderId,
              fareNgn: event.fareNgn,
              owedDriverNgn: completionFees.driverPayoutNgn,
            });
            return;
          }

          if (!result.applied) {
            console.info(`[${serviceId}][escrow] settlement already applied — duplicate event ignored`, {
              rideId: event.rideId,
              driverUserId: event.driverUserId,
            });
            return;
          }

          console.info(`[${serviceId}][escrow] RELEASED — ride settled`, {
            rideId: event.rideId,
            riderId: event.riderId,
            driverUserId: event.driverUserId,
            fareNgn: event.fareNgn,
            heldNgn: result.holdAmountNgn,
            riderDebitedNgn: completionFees.totalNgn,
            driverCreditedNgn: completionFees.driverPayoutNgn,
            platformFeeNgn: result.platformFeeNgn,
            riderBalanceAfterNgn: Number(result.riderWallet.balanceNgn),
            riderLockedAfterNgn: Number(result.riderWallet.lockedNgn),
            driverBalanceAfterNgn: Number(result.driverWallet.balanceNgn),
          });

          // NOTE deliberately NO physical transfer here. The ledger credit
          // above IS the driver's payment; real money stays in the treasury
          // until the driver withdraws. The old releaseToDriver call pushed
          // treasury cash to the driver's VA, which bounced back through the
          // deposit webhook and credited the driver's wallet a SECOND time
          // (driver earned N3,840, wallet showed N7,680).

          // Publish rider debit event (total including tax + levy)
          await walletEventsProducer.publishDebited({
            walletId: result.riderWallet.id,
            userId: result.riderWallet.userId,
            amountNgn: completionFees.totalNgn,
            newBalanceNgn: Number(result.riderWallet.balanceNgn),
            debitType: 'ride_payment',
            referenceId: event.rideId,
          }, { key: event.rideId });

          // Publish driver credit event (fare minus all deductions)
          await walletEventsProducer.publishCredited({
            walletId: result.driverWallet.id,
            userId: result.driverWallet.userId,
            amountNgn: completionFees.driverPayoutNgn,
            newBalanceNgn: Number(result.driverWallet.balanceNgn),
            creditType: 'driver_payout',
            referenceId: event.rideId,
          }, { key: event.rideId });
        } catch (error) {
          // Settlement is transactional — on failure the rider's funds stay
          // LOCKED and the driver stays unpaid until this is resolved by hand.
          console.error(`[${serviceId}][escrow] CRITICAL: settlement FAILED — rider funds still locked, driver unpaid`, {
            rideId: event.rideId,
            riderId: event.riderId,
            driverUserId: event.driverUserId,
            fareNgn: event.fareNgn,
            error: getErrorMessage(error),
          });
        }

        return;
      }

      if (event.eventType === 'RIDE_CANCELLED') {
        // A driver bailing puts the ride back into matching with the same
        // rideId; the rider's fare must stay held for the next driver. The
        // hold is released when the ride truly ends (rider cancel, timeout).
        if (event.cancelledBy === 'driver') {
          console.info(`[${serviceId}][escrow] driver cancelled — hold kept for re-match`, {
            rideId: event.rideId,
          });
          return;
        }
        try {
          const holdResult = await walletRepository.cancelRideHold(event.rideId);
          if (!holdResult) {
            console.info(`[${serviceId}][escrow] cancel — no hold to release`, {
              rideId: event.rideId,
            });
            return;
          }

          if (!holdResult.applied) {
            console.info(`[${serviceId}][escrow] cancel — hold already settled or released`, {
              rideId: event.rideId,
              holdNgn: holdResult.holdAmountNgn,
            });
            return;
          }

          console.info(`[${serviceId}][escrow] RELEASED — ride cancelled, funds returned to rider`, {
            rideId: event.rideId,
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            releasedNgn: holdResult.holdAmountNgn,
            balanceAfterNgn: Number(holdResult.wallet.balanceNgn),
            lockedAfterNgn: Number(holdResult.wallet.lockedNgn),
          });

          await walletEventsProducer.publishUnlocked({
            walletId: holdResult.wallet.id,
            userId: holdResult.wallet.userId,
            unlockedAmountNgn: holdResult.holdAmountNgn,
            rideId: event.rideId,
            reason: 'ride_cancelled',
          }, { key: event.rideId });

          // Deliberately NO cash transfer back to the rider's VA. The ledger
          // credit above IS the refund; a transfer to their VA comes back
          // through the deposit webhook and credits the wallet a second time
          // (the same bounce that removed releaseToDriver at completion).
        } catch (error) {
          console.error(`[${serviceId}][escrow] CRITICAL: cancel release FAILED — rider funds still locked`, {
            rideId: event.rideId,
            error: getErrorMessage(error),
          });
        }
      }
    },
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
