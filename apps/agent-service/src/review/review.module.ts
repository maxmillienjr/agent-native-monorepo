import { Module } from '@nestjs/common';
import { FhirModule } from '../fhir/fhir.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';

/**
 * The clinician review surface (P3-E, ADR 0010): the queue, one case, and the
 * determination route. It reads and decides `prior_auth_cases` through
 * `CASE_REPOSITORY`, and takes the request clock from `FhirModule`, so the
 * queue's `overdue` and `$submit`'s deadline read the same clock.
 */
@Module({
  imports: [MemoryModule, FhirModule],
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
