/**
 * A route change (or its quote) that is refused on purpose, with a message for the rider. The ws handler
 * keeps it as it is, so the ride page can answer 409 (429 when `tooMany`) with the same words instead of a 500.
 */
export class RouteChangeRefused extends Error {
  readonly code = 'ROUTE_CHANGE_REFUSED';
  constructor(message: string, readonly tooMany = false) {
    super(message);
  }
}
