import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export type RidePageEventInput = {
  sessionId: string;
  userId: string;
  rideId: string | null;
  event: string;
  phase: string | null;
  seq: number;
  props: Prisma.InputJsonValue | null;
  clientAt: Date;
};

/** What riders do on the WhatsApp ride page, step by step (the ride_page_* views read it). */
export const ridePageEventClient = {
  /** A batch from the page; a step sent twice (a retry) is kept once. */
  recordMany: (events: RidePageEventInput[]) =>
    events.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.ridePageEvent.createMany({
          data: events.map((e) => ({
            sessionId: e.sessionId,
            userId: e.userId,
            rideId: e.rideId,
            event: e.event,
            phase: e.phase,
            seq: e.seq,
            ...(e.props ? { props: e.props } : {}),
            clientAt: e.clientAt,
          })),
          skipDuplicates: true,
        }),
};
