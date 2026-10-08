import { Module } from '@nestjs/common';
import { createLogger } from '@repo/telemetry';
import { FhirModule } from '../fhir/fhir.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';
import { ReviewSweep } from './review.sweep.js';
import { REVIEWER_REGISTRY, loadReviewerRegistry, type ReviewerRegistry } from './registry.js';

const logger = createLogger('review');

/**
 * The clinician review surface (P3-E, ADR 0010): the queue, one case, the
 * determination route, and the overdue sweep that flags and never decides.
 * It reads and decides `prior_auth_cases` through `CASE_REPOSITORY`, and
 * takes the request clock from `FhirModule`, so the queue's `overdue`, the
 * sweep and `$submit`'s deadline all read the same clock.
 */
@Module({
  imports: [MemoryModule, FhirModule],
  controllers: [ReviewController],
  providers: [
    ReviewService,
    ReviewSweep,
    {
      // Unset: no registry, and the determination route answers 503 while the
      // read routes serve. Malformed: the factory throws naming the variable,
      // and boot exits 1 with that message.
      provide: REVIEWER_REGISTRY,
      useFactory: (): ReviewerRegistry | null => {
        const registry = loadReviewerRegistry();
        if (registry === null) {
          logger.warn({
            msg: 'review.registry.absent',
            detail: 'REVIEWER_REGISTRY is unset: determinations answer 503 until it names a file.',
          });
        } else {
          logger.info({ msg: 'review.registry.ready', keys: registry.size });
        }
        return registry;
      },
    },
  ],
})
export class ReviewModule {}
