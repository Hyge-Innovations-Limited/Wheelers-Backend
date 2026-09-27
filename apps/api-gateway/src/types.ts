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
