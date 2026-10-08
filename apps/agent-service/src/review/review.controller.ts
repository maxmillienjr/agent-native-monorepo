import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { FhirBundle } from '@repo/prior-auth';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { authenticatedPrincipal } from '../auth/require-credential.js';
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
 * lint rule forbids under `src/agent/**`. Every route here needs a bearer
 * credential when `SERVICE_CREDENTIALS` is set (P5-A); the signature on a
 * determination is what binds it to a reviewer, and the credential is what
 * binds it to a caller.
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

  /**
   * A clinician's signed determination. The body is read at the boundary by
   * `ReviewService.determine`, which says what each status means. It is given
   * the principal the bearer token named, so a key registered to a principal
   * can be used by that caller only (403 otherwise). In open mode there is no
   * authenticated principal, and the check does not apply.
   */
  @Post('cases/:caseId/determination')
  @HttpCode(200)
  determine(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<FhirBundle> {
    return this.review.determine(caseId, body, authenticatedPrincipal(req));
  }
}
