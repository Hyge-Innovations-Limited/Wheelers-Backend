import type { Admin } from 'kafkajs';
import { getKafkaInstance } from './connection';

/**
 * How far behind each consumer group is: messages on its topics it has not committed yet, summed over
 * partitions. For the Health page and its alert (ride-service behind means offers and bookings are slow).
 * One admin connection, kept and reused; on any failure the next call starts a fresh one.
 */
let admin: Admin | null = null;
let connecting: Promise<Admin> | null = null;

async function getAdmin(): Promise<Admin> {
  if (admin) return admin;
  if (!connecting) {
    connecting = (async () => {
      const a = getKafkaInstance().admin();
      await a.connect();
      admin = a;
      return a;
    })().finally(() => { connecting = null; });
  }
  return connecting;
}

export async function consumerLag(groupIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const a = await getAdmin();
    const ends = new Map<string, Map<number, number>>();
    for (const groupId of groupIds) {
      let lag = 0;
      const committed = await a.fetchOffsets({ groupId });
      for (const { topic, partitions } of committed) {
        if (!ends.has(topic)) {
          ends.set(topic, new Map((await a.fetchTopicOffsets(topic)).map((p) => [p.partition, Number(p.high)])));
        }
        const high = ends.get(topic)!;
        for (const p of partitions) {
          const at = Number(p.offset);
          const end = high.get(p.partition) ?? 0;
          // -1: nothing committed yet on this partition (a new group starts at the end).
          if (at >= 0) lag += Math.max(0, end - at);
        }
      }
      out[groupId] = lag;
    }
    return out;
  } catch (error) {
    const stale = admin;
    admin = null;
    await stale?.disconnect().catch(() => undefined);
    throw error;
  }
}
