import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express, RequestHandler } from 'express';
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import type { A2ARequestHandler, User } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { legacyAgentCardRouter } from '@a2a-js/sdk/compat/v0_3/server/express';
import { runWithCorrelationId } from '@repo/telemetry';
import { OPEN_PRINCIPAL } from '../auth/credentials.js';
import { principalOf } from '../auth/require-credential.js';
import { A2A_CARD, A2A_REQUEST_HANDLER, type A2aCard } from './a2a.module.js';
import { JSONRPC_PATH, JWKS_PATH } from './agent-card.js';

/** How long a caller may cache the card and the keys. Rotation waits this out. */
export const CARD_MAX_AGE_SECONDS = 3600;

/** The SDK's caller, named by the principal the auth middleware attached. */
class Principal implements User {
  constructor(
    readonly userName: string,
    readonly isAuthenticated: boolean,
  ) {}
}

/**
 * The correlation id, by the rule `LoggingInterceptor` applies to Nest
 * routes, which never see these: the caller's `x-correlation-id` or a minted
 * one, echoed on the response and written back to the request, and the
 * handler run inside it so every log line and the run record carry it.
 */
const withCorrelationId: RequestHandler = (req, res, next) => {
  const header = req.headers['x-correlation-id'];
  const correlationId = typeof header === 'string' && header !== '' ? header : randomUUID();
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  runWithCorrelationId(correlationId, next);
};

/**
 * The SDK's v1.0 handler sets `Vary` only when its own compat flag is on, and
 * that flag would hand the v0.3 router the signed ProtoJSON card, which its
 * translation does not read. Both answers depend on the header, so both say so.
 */
const varyOnVersion: RequestHandler = (_req, res, next) => {
  res.append('Vary', 'A2A-Version');
  next();
};

/**
 * Mounts the A2A routes on the Express instance under Nest (P5-A):
 *
 * - `/.well-known/agent-card.json`: the v1.0 card, signed when keys are
 *   configured, to a caller that sends `A2A-Version: 1.0`; the v0.3 card to a
 *   caller that sends no version, which §3.6.2 says to treat as 0.3.
 * - `/.well-known/jwks.json`: the public keys.
 * - `/a2a/jsonrpc`: JSON-RPC, v1.0 methods and their v0.3 names.
 *
 * The v0.3 card is unsigned. The SDK's translation copies the v1.0 signatures
 * onto it, and they cover the v1.0 shape, so a caller verifying the v0.3 card
 * as served would find signatures that fail. A card with none is honest.
 *
 * Express handlers rather than Nest controllers, so the authentication
 * middleware covers them, the body parser has already run, and no Nest pipe
 * or interceptor does.
 */
export function mountA2a(app: NestExpressApplication): void {
  const card = app.get<A2aCard>(A2A_CARD);
  const requestHandler = app.get<A2ARequestHandler>(A2A_REQUEST_HANDLER);
  const cache = { maxAge: CARD_MAX_AGE_SECONDS };

  // The legacy router answers a 0.3 or absent version and passes anything
  // else on with next('router'), to the v1.0 handler below it.
  app.use(
    `/${AGENT_CARD_PATH}`,
    legacyAgentCardRouter({ agentCardProvider: async () => card.card, cache }),
  );
  app.use(
    `/${AGENT_CARD_PATH}`,
    varyOnVersion,
    // `served` is already JSON in ProtoJSON's form, which is what the handler
    // writes out with `JSON.stringify`.
    agentCardHandler({
      agentCardProvider: async () => card.served as unknown as AgentCard,
      cache,
    }),
  );

  const express = app.getHttpAdapter().getInstance() as Express;
  express.get(JWKS_PATH, (_req, res) => {
    res.setHeader('Cache-Control', `public, max-age=${CARD_MAX_AGE_SECONDS}`);
    res.json(card.jwks);
  });

  app.use(
    JSONRPC_PATH,
    withCorrelationId,
    jsonRpcHandler({
      requestHandler,
      userBuilder: async (req) => {
        const principal = principalOf(req);
        return principal === undefined || principal === OPEN_PRINCIPAL
          ? new Principal(OPEN_PRINCIPAL, false)
          : new Principal(principal, true);
      },
      legacyCompat: { enabled: true },
    }),
  );
}
