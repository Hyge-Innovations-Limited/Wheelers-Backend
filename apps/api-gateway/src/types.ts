export type GatewayRole = 'RIDER' | 'DRIVER' | 'BOTH';

export interface GatewayAuthContext {
  userId: string;
  privyDid: string;
  role: GatewayRole;
  driverId?: string;
  email?: string;
  name?: string;
  /** Which client opened this socket: the Wheelers app, or the MCP server acting for the user. */
  client?: 'app' | 'mcp';
  /**
   * A socket opened by the WhatsApp rider's Trip chat page, with its link
   * instead of a login. It may only chat and call, and only on this ride.
   */
  page?: { scope: 'trip'; rideId: string };
  /**
   * A socket opened by the WhatsApp booking page with its link: it only listens
   * (rides/ride-page-live sends it the page's state) and is registered under
   * ridePageChannel(rider), never the rider's own id.
   */
  ridePage?: true;
}

export interface InboundWsMessage {
  type: string;
  payload?: Record<string, unknown>;
}

export interface OutboundWsMessage {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}
