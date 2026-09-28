/**
 * Everything the trip chat and Live call refuse, with the words the person
 * sees. The code is for the apps and the page to act on; the message is shown.
 */
export type TripChatErrorCode =
  | 'NOT_FOUND'
  | 'NOT_ON_TRIP'
  | 'CHAT_CLOSED'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'PHONE_NUMBER'
  | 'RATE_LIMITED'
  | 'CALLS_OFF'
  | 'CALL_BUSY'
  | 'CALL_LIMIT'
  | 'CALL_GONE'
  | 'NOT_IN_CALL'
  | 'BAD_SIGNAL';

const STATUS: Record<TripChatErrorCode, number> = {
  NOT_FOUND: 404,
  NOT_ON_TRIP: 403,
  CHAT_CLOSED: 409,
  EMPTY: 400,
  TOO_LONG: 400,
  PHONE_NUMBER: 400,
  RATE_LIMITED: 429,
  CALLS_OFF: 503,
  CALL_BUSY: 409,
  CALL_LIMIT: 429,
  CALL_GONE: 409,
  NOT_IN_CALL: 403,
  BAD_SIGNAL: 400,
};

export class TripChatError extends Error {
  readonly status: number;

  constructor(readonly code: TripChatErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}
