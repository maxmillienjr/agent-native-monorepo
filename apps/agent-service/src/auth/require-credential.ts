import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { createLogger } from '@repo/telemetry';
import { OPEN_PRINCIPAL, type ServiceCredentials } from './credentials.js';

const logger = createLogger('auth');

/** RFC 6750 §3. The same challenge for a missing token and a wrong one. */
export const BEARER_CHALLENGE = 'Bearer realm="agent-service"';

/**
 * What a caller may reach without a token: health, and discovery. A caller has
 * to be able to read the card to learn that it needs a credential at all.
 * Everything else is covered, including routes added after this was written:
 * the rule is deny by default, so `/fhir/*` (P3-D) and `/review/*` (P3-E) are
 * covered without being named.
 */
const ANONYMOUS_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/.well-known/agent-card.json',
  '/.well-known/jwks.json',
]);

function isAnonymous(req: Request): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && ANONYMOUS_PATHS.has(req.path);
}

const principals = new WeakMap<Request, string>();

/**
 * The principal the middleware attached to a request, or undefined when the
 * request never passed through it.
 */
export function principalOf(req: Request): string | undefined {
  return principals.get(req);
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header === undefined ? null : /^bearer +(\S+) *$/i.exec(header);
  return match?.[1];
}

/**
 * Bearer authentication for the whole external surface, enforced at the
 * service and not at the gateway: compose publishes the service's own port, so
 * a check at the gateway alone would leave what it protects reachable around
 * it (P5-A).
 *
 * The presented token is hashed and compared with every configured digest in
 * constant time, with no early exit, so the time taken does not say which
 * principal nearly matched. The principal is logged; the token never is.
 *
 * Mounted before the body parser, so an unauthenticated body is never read.
 */
export function requireCredential(config: ServiceCredentials): RequestHandler {
  if (config.mode === 'open') {
    return (req, _res, next) => {
      principals.set(req, OPEN_PRINCIPAL);
      next();
    };
  }

  return (req, res, next) => {
    if (isAnonymous(req)) {
      next();
      return;
    }

    const token = bearerToken(req.headers.authorization);
    let principal: string | undefined;
    if (token !== undefined) {
      const presented = createHash('sha256').update(token, 'utf8').digest();
      for (const credential of config.credentials) {
        if (timingSafeEqual(presented, credential.digest)) principal ??= credential.principal;
      }
    }

    if (principal === undefined) {
      logger.warn({
        msg: 'auth.rejected',
        method: req.method,
        path: req.path,
        reason: token === undefined ? 'missing' : 'invalid',
      });
      res.setHeader('WWW-Authenticate', BEARER_CHALLENGE);
      res.status(401).json({ error: 'Unauthorized', statusCode: 401 });
      return;
    }

    logger.debug({ msg: 'auth.accepted', principal, method: req.method, path: req.path });
    principals.set(req, principal);
    next();
  };
}

/**
 * The boot line that says which mode the service is in. Open mode is `warn`:
 * it is a supported configuration, and a reader of the log should still see it.
 */
export function announceAuthMode(config: ServiceCredentials): void {
  if (config.mode === 'open') {
    logger.warn({
      msg: 'auth.open',
      detail:
        'SERVICE_CREDENTIALS is unset: every route is served without a credential, every caller is the principal "anonymous", and the Agent Card declares no security',
    });
    return;
  }
  logger.info({
    msg: 'auth.enforced',
    principals: config.credentials.map((c) => c.principal),
  });
}
