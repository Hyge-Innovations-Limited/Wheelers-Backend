import { createHmac } from 'crypto';

/**
 * The STUN and TURN servers a call connects through: our own coturn machine
 * (infra/turn). The TURN login is made for one person and runs out by itself,
 * signed with the secret coturn shares with us (its "TURN REST API" scheme):
 *
 *   username   = <expiry, unix seconds>:<userId>
 *   credential = base64(HMAC-SHA1(secret, username))
 *
 * coturn checks the signature and the expiry itself; nothing is stored.
 */

export interface TurnConfig {
  host?: string;
  secret?: string;
  ttlSeconds: number;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export function turnCredentials(userId: string, secret: string, ttlSeconds: number, nowMs: number = Date.now()) {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt };
}

export function iceServersFor(userId: string, config: TurnConfig, nowMs: number = Date.now()): IceServer[] {
  if (!config.host) return [];
  const stun: IceServer = { urls: [`stun:${config.host}:3478`] };
  if (!config.secret) return [stun];
  const { username, credential } = turnCredentials(userId, config.secret, config.ttlSeconds, nowMs);
  return [
    stun,
    {
      // UDP first; TCP when UDP is blocked; TLS on 443 when only web traffic gets out.
      urls: [
        `turn:${config.host}:3478?transport=udp`,
        `turn:${config.host}:3478?transport=tcp`,
        `turns:${config.host}:443?transport=tcp`,
      ],
      username,
      credential,
    },
  ];
}
