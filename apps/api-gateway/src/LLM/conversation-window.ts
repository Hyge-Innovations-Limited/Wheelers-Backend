/**
 * What of the past the model may read when it works out a trip.
 *
 * A rider who booked on Monday and types a new pickup and destination on
 * Friday got Monday's addresses back: the model was shown the last messages
 * however old they were (Monday's "Pickup: …" / "Destination: …"), and the
 * rider's past trips, and used them in place of what was typed. A booking is
 * a conversation of minutes, so only the last hour of it is shown; past trips
 * and places only when the message asks for them ("home", "the usual",
 * "same as last time").
 */

/** A booking's conversation: the booking state itself lives an hour (BOOKING_TTL). */
export const CONVERSATION_WINDOW_MS = 60 * 60 * 1000;

/** The messages of the conversation under way: the last hour, nothing older (and nothing undated). */
export function currentConversation<T extends { timestamp: string }>(messages: readonly T[], now = Date.now()): T[] {
  return messages.filter((message) => {
    const at = Date.parse(message.timestamp);
    return Number.isFinite(at) && at >= now - CONVERSATION_WINDOW_MS;
  });
}

const ASKS_FOR_MEMORY = /\b(home|house|work|office|usual|same|again|last time|before|regular|my place|my side)\b/i;

/** The message refers to a place we know from before, so the rider's trips and places may be used. */
export function asksForRiderMemory(message: string): boolean {
  return ASKS_FOR_MEMORY.test(message);
}
