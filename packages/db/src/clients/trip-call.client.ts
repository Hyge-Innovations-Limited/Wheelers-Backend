import { prisma } from '../prisma';
import type { ChatSenderRole } from '@prisma/client';

/** How a Live call ended. RINGING and ACTIVE are the states before that. */
export type TripCallStatus = 'RINGING' | 'ACTIVE' | 'COMPLETED' | 'MISSED' | 'DECLINED' | 'CANCELLED' | 'FAILED';

export const tripCallClient = {
  /** Written the moment the phone starts ringing, so a call is on record even if the gateway dies mid-call. */
  async start(params: {
    id: string;
    rideId: string;
    callerId: string;
    callerRole: ChatSenderRole;
    calleeId: string;
    calleeChannel: 'app' | 'whatsapp';
  }) {
    return prisma.tripCall.create({ data: { ...params, status: 'RINGING' } });
  },

  async answered(id: string, at: Date) {
    await prisma.tripCall.updateMany({ where: { id, status: 'RINGING' }, data: { status: 'ACTIVE', answeredAt: at } });
  },

  async ended(id: string, params: { status: TripCallStatus; endReason: string; endedAt: Date; durationSeconds: number | null }) {
    await prisma.tripCall.updateMany({
      where: { id, status: { in: ['RINGING', 'ACTIVE'] } },
      data: { status: params.status, endReason: params.endReason, endedAt: params.endedAt, durationSeconds: params.durationSeconds },
    });
  },

  async findById(id: string) {
    return prisma.tripCall.findUnique({ where: { id } });
  },

  async listForRide(rideId: string) {
    return prisma.tripCall.findMany({ where: { rideId }, orderBy: { createdAt: 'asc' } });
  },
};
