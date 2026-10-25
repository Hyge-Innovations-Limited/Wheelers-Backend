import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { loadWorkspaceEnv, startAlerts, validateMcpEnv } from '@wheleers/config';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GatewayClient } from './gateway/client';
import { Geocoder } from './gateway/geocoding';
import { RideSessionManager } from './gateway/ride-session';
import { createLoginRouter } from './oauth/login';
import { WheelersOAuthProvider, WHEELERS_SCOPE } from './oauth/provider';
import { OAuthStore } from './oauth/store';
import { createRedis } from './redis';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server';
import type { ToolContext } from './tools/common';

const SERVICE_ID = 'mcp-server';

function log(message: string, meta?: Record<string, unknown>): void {
  console.info(`[${SERVICE_ID}] ${message}`, meta ?? '');
}

function deriveWsUrl(httpBase: string): string {
  const url = new URL(httpBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
}

function corsMiddleware(allowedOrigins: Set<string>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization,content-type,mcp-session-id,mcp-protocol-version');
      res.setHeader('access-control-expose-headers', 'mcp-session-id,www-authenticate');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  startAlerts();
  const env = validateMcpEnv();

  const publicUrl = new URL(env.MCP_PUBLIC_URL);
  const mcpEndpoint = new URL('/mcp', publicUrl);
  const redis = createRedis(env.REDIS_URL);
  const gateway = new GatewayClient(env.MCP_GATEWAY_BASE_URL);
  const store = new OAuthStore(redis);
  const provider = new WheelersOAuthProvider({
    store,
    gateway,
    accessTokenTtlSeconds: env.MCP_ACCESS_TOKEN_TTL_S,
    allowGatewayTokens: env.MCP_ALLOW_GATEWAY_TOKENS === 'true',
  });
  const rides = new RideSessionManager({
    wsUrl: env.MCP_GATEWAY_WS_URL ?? deriveWsUrl(env.MCP_GATEWAY_BASE_URL),
    redis,
    log: (message, meta) => log(`ride-session: ${message}`, meta),
  });
  const geocoder = env.GOOGLE_MAPS_API_KEY
    ? new Geocoder({
        apiKey: env.GOOGLE_MAPS_API_KEY,
        region: env.GEOCODE_REGION,
        fallbackCountry: env.GEOCODE_FALLBACK_COUNTRY,
      })
    : null;
  if (!geocoder) {
    log('GOOGLE_MAPS_API_KEY not set — tools will require lat/lng instead of addresses');
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(corsMiddleware(new Set(env.MCP_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean))));

  // OAuth 2.1 authorization server + discovery:
  //   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp,
  //   /authorize, /token, /register (dynamic client registration), /revoke
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      resourceServerUrl: mcpEndpoint,
      resourceName: 'Wheelers',
      scopesSupported: [WHEELERS_SCOPE],
      serviceDocumentationUrl: new URL('/', publicUrl),
    }),
  );

  // Some clients probe the origin-level path instead of the path-scoped one.
  const protectedResourceMetadata = {
    resource: mcpEndpoint.href,
    authorization_servers: [publicUrl.href],
    scopes_supported: [WHEELERS_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Wheelers',
  };
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json(protectedResourceMetadata);
  });

  app.use(createLoginRouter({ store, gateway }));

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', publicUrl).href,
  });

  const mcpHandler: RequestHandler = async (req, res) => {
    const auth = req.auth;
    const userId = typeof auth?.extra?.['userId'] === 'string' ? auth.extra['userId'] : null;
    const gatewayToken = typeof auth?.extra?.['gatewayToken'] === 'string' ? auth.extra['gatewayToken'] : null;
    if (!auth || !userId || !gatewayToken) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Token is not bound to a Wheelers user.' });
      return;
    }

    const ctx: ToolContext = {
      userId,
      gatewayToken,
      gw: gateway.withToken(gatewayToken),
      rides,
      geocoder,
    };

    // Stateless: a fresh server + transport per request, so any pm2 instance
    // can answer any request and nothing is lost on restart.
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log('mcp request failed', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };

  app.post('/mcp', express.json({ limit: '4mb' }), bearer, mcpHandler);
  app.get('/mcp', bearer, mcpHandler);
  app.delete('/mcp', bearer, mcpHandler);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_ID, name: SERVER_NAME, version: SERVER_VERSION, timestamp: new Date().toISOString() });
  });

  app.get('/', (_req, res) => {
    res.type('text/plain').send(
      [
        `Wheelers MCP server (${SERVER_VERSION})`,
        '',
        `MCP endpoint:      ${mcpEndpoint.href}`,
        `OAuth metadata:    ${new URL('/.well-known/oauth-authorization-server', publicUrl).href}`,
        '',
        'Add this URL as a custom connector in Claude, or:',
        `  claude mcp add --transport http wheelers ${mcpEndpoint.href}`,
      ].join('\n'),
    );
  });

  const port = Number(env.MCP_PORT);
  const httpServer = app.listen(port, () => {
    log(`listening on :${port}`, { publicUrl: publicUrl.href, gateway: env.MCP_GATEWAY_BASE_URL });
  });

  const shutdown = (signal: string) => {
    log(`received ${signal}, shutting down`);
    httpServer.close();
    void rides.close().finally(() => {
      void redis.quit().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error(`[${SERVICE_ID}] fatal`, error);
  process.exit(1);
});
