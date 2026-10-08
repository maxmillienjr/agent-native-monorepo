import { Module } from '@nestjs/common';
import { createLogger } from '@repo/telemetry';
import { FhirModule } from '../fhir/fhir.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { RUN_LEDGER } from '../ledger/ledger.tokens.js';
import type { RunLedger } from '../ledger/run-ledger.js';
import { AppealController } from './appeal.controller.js';
import { AppealService } from './appeal.service.js';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';
import { ReviewSweep } from './review.sweep.js';
import { REVIEWER_REGISTRY, loadReviewerRegistry, type ReviewerRegistry } from './registry.js';

const logger = createLogger('review');

/**
 * The clinician review surface (P3-E, ADR 0010): the queue, one case, the
 * determination route, and the overdue sweep that flags and never decides.
 * Appeals (P3-F) are beside them under `/review/appeals`, and the same sweep
 * forwards an appeal whose reconsideration deadline has passed (ADR 0015).
 * It reads and decides `prior_auth_cases` through `CASE_REPOSITORY`, and
 * takes the request clock from `FhirModule`, so the queue's `overdue`, the
 * sweep and `$submit`'s deadline all read the same clock.
 */
@Module({
  imports: [MemoryModule, FhirModule, LedgerModule],
  controllers: [ReviewController, AppealController],
  providers: [
    ReviewService,
    AppealService,
    ReviewSweep,
    {
      // Unset: no registry, and the determination route answers 503 while the
      // read routes serve. Malformed: the factory throws naming the variable,
      // and boot exits 1 with that message.
      //
      // With a ledger configured (P3-C), every key is registered in it before
      // the route serves, and a revocation in the file is appended as one. A
      // key whose entry no longer matches its registration fails boot: once
      // the ledger holds a key, the ledger is authoritative.
      provide: REVIEWER_REGISTRY,
      inject: [RUN_LEDGER],
      useFactory: async (runLedger: RunLedger | null): Promise<ReviewerRegistry | null> => {
        const registry = loadReviewerRegistry();
        if (registry === null) {
          logger.warn({
            msg: 'review.registry.absent',
            detail: 'REVIEWER_REGISTRY is unset: determinations answer 503 until it names a file.',
          });
          return null;
        }
        logger.info({ msg: 'review.registry.ready', keys: registry.size });
        if (runLedger !== null) {
          const { registered, revoked } = await runLedger.registerKeys(registry.entries());
          logger.info({ msg: 'review.registry.ledgered', keys: registered, revoked });
        }
        return registry;
      },
    },
  ],
})
export class ReviewModule {}
