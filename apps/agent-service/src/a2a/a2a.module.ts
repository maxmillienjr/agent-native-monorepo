import { Module } from '@nestjs/common';
import type { JWK } from 'jose';
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import type { EpisodicRepository } from '@repo/memory-core';
import { createLogger } from '@repo/telemetry';
import { SERVICE_CREDENTIALS, type ServiceCredentials } from '../auth/credentials.js';
import { MemoryModule } from '../memory/memory.module.js';
import { EPISODIC_REPOSITORY } from '../memory/memory.tokens.js';
import { RunsModule } from '../runs/runs.module.js';
import { RunsService } from '../runs/runs.service.js';
import { JWKS_PATH, buildAgentCard, cardJson, readPublicUrl } from './agent-card.js';
import { jwks, loadSigningKeys, signCard } from './card-signing.js';
import { RunExecutor } from './run-executor.js';

const logger = createLogger('a2a');

export const A2A_CARD = 'A2A_CARD';
export const A2A_REQUEST_HANDLER = 'A2A_REQUEST_HANDLER';

/** The card in the three forms the routes need, built once at boot. */
export interface A2aCard {
  /** In memory and unsigned: what the request handler reads, and the v0.3 card's source. */
  readonly card: AgentCard;
  /** ProtoJSON, signed by every configured key: the v1.0 card as served. */
  readonly served: Record<string, unknown>;
  readonly jwks: { keys: JWK[] };
}

/**
 * The A2A server's providers (P5-A). The routes themselves are Express
 * handlers that `mount.ts` attaches, not Nest controllers, so nothing a Nest
 * pipe or interceptor does reaches them.
 *
 * The card is signed once, here. The SDK's request handler can sign on every
 * read instead, but ES256 signatures are randomized, so that would give each
 * fetch a new body and a new `ETag`, and sign on every `SendMessage` too,
 * which reads the card to check the version.
 */
@Module({
  imports: [RunsModule, MemoryModule],
  providers: [
    {
      provide: A2A_CARD,
      inject: [SERVICE_CREDENTIALS],
      useFactory: async (credentials: ServiceCredentials): Promise<A2aCard> => {
        const publicUrl = readPublicUrl(process.env);
        const keys = await loadSigningKeys(process.env);
        const card = buildAgentCard({ publicUrl, secured: credentials.mode === 'enforced' });

        if (keys.length === 0) {
          logger.warn({
            msg: 'a2a.card.unsigned',
            detail: 'A2A_CARD_SIGNING_KEYS is unset: the Agent Card is served with no signature',
          });
        } else {
          logger.info({ msg: 'a2a.card.signed', kids: keys.map((k) => k.kid) });
        }

        return {
          card,
          served: await signCard(cardJson(card), keys, `${publicUrl}${JWKS_PATH}`),
          jwks: jwks(keys),
        };
      },
    },
    {
      provide: A2A_REQUEST_HANDLER,
      inject: [A2A_CARD, RunsService, EPISODIC_REPOSITORY],
      useFactory: (card: A2aCard, runs: RunsService, episodes: EpisodicRepository | null) =>
        new DefaultRequestHandler(
          card.card,
          new InMemoryTaskStore(),
          new RunExecutor(runs, episodes),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          // The card says text/plain in, so a part declaring another media
          // type is refused with ContentTypeNotSupportedError (§3.1.1).
          { validateInputModes: true },
        ),
    },
  ],
  exports: [A2A_CARD, A2A_REQUEST_HANDLER],
})
export class A2aModule {}
