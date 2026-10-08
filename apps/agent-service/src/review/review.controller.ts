import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { ReviewService, type CaseView, type QueueItem } from './review.service.js';

const QueueQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(1000).default(100) })
  .strict();

/**
 * The clinician review surface (P3-E): internal utilization-management routes,
 * not FHIR resources, so errors are the service's JSON envelope rather than
 * an `OperationOutcome`.
 *
 * It lives under `src/review/`, outside `src/agent/`, because the
 * determination route imports `@repo/determination/clinician`, which P3-A's
 * lint rule forbids under `src/agent/**`. P5-A's authentication is meant to
 * cover `/review/*` when it lands; until then the signature on a
 * determination is what binds it to a reviewer.
 */
@Controller('review')
export class ReviewController {
  constructor(@Inject(ReviewService) private readonly review: ReviewService) {}

  /** Pended cases, in clock order and nothing else. */
  @Get('cases')
  async queue(
    @Query(new ZodValidationPipe(QueueQuerySchema)) query: z.infer<typeof QueueQuerySchema>,
  ): Promise<{ cases: QueueItem[] }> {
    return { cases: await this.review.queue(query.limit) };
  }

  /** One case: the request, the findings with their rationale, and what to sign. */
  @Get('cases/:caseId')
  view(@Param('caseId') caseId: string): Promise<CaseView> {
    return this.review.view(caseId);
  }
}
