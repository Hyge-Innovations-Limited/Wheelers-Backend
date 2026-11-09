import { outboxClient } from '@wheleers/db';
import type { WheelersProducer } from '@wheleers/kafka-client';

export interface RawProducer {
  send(record: {
    topic: string;
    messages: Array<{ key?: string | null; value: string }>;
  }): Promise<unknown>;
}

export function asRawProducer(producer: WheelersProducer): RawProducer {
  return {
    send: async (record) => {
      for (const msg of record.messages) {
        await producer.send(record.topic, JSON.parse(msg.value), {
          key: msg.key ?? undefined,
        });
      }
    },
  };
}

export function startOutboxPublisher(params: {
  producer: RawProducer;
  intervalMs?: number;
  batchSize?: number;
  /** With more than one gateway process, only the one this says yes to publishes. */
  shouldRun?: () => Promise<boolean>;
}): { shutdown: () => void } {
  const { producer, intervalMs = 2_000, batchSize = 100, shouldRun } = params;
  let active = true;
  let polling = false;

  async function poll(): Promise<void> {
    if (!active || polling) {
      return;
    }
    polling = true;
    try {
      await doPoll();
    } finally {
      polling = false;
    }
  }

  async function doPoll(): Promise<void> {
    // Two processes reading the same unpublished rows would each send them.
    if (shouldRun && !(await shouldRun())) return;

    let events: Awaited<ReturnType<typeof outboxClient.findUnpublished>>;
    try {
      events = await outboxClient.findUnpublished(batchSize);
    } catch (err) {
      console.warn('[outbox-publisher] db read error:', (err as Error).message);
      return;
    }

    if (events.length === 0) {
      return;
    }

    const published: string[] = [];

    for (const ev of events) {
      try {
        await producer.send({
          topic: ev.topic,
          messages: [
            {
              key: ev.key ?? null,
              value: JSON.stringify(ev.payload),
            },
          ],
        });
        published.push(ev.id);
      } catch (err) {
        console.warn(
          `[outbox-publisher] send failed for event ${ev.id}:`,
          (err as Error).message,
        );
        break;
      }
    }

    if (published.length > 0) {
      try {
        await outboxClient.markPublished(published);
      } catch (err) {
        console.warn(
          '[outbox-publisher] markPublished error (will retry):',
          (err as Error).message,
        );
      }
    }
  }

  void poll();

  const timer = setInterval(() => {
    void poll();
  }, intervalMs);
  timer.unref();

  const purgeTimer = setInterval(() => {
    void outboxClient.purgePublished(7).catch(console.warn);
  }, 24 * 60 * 60 * 1_000);
  purgeTimer.unref();

  return {
    shutdown() {
      active = false;
      clearInterval(timer);
      clearInterval(purgeTimer);
    },
  };
}
