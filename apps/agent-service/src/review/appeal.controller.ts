import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { FhirBundle } from '@repo/prior-auth';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { authenticatedPrincipal } from '../auth/require-credential.js';
import {
  AppealService,
  type AppealQueueItem,
  type AppealView,
  type CaseFileView,
} from './appeal.service.js';

const QueueQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(1000).default(100) })
  .strict();

/**
 * Appeals (P3-F): requests for reconsideration of a denied case, under
 * `/review/` beside the queue that made the denial.
 *
 * Not FHIR. PAS defines no appeal transaction and says so (HL7 FHIR-24326),
 * and base R4 has no appeal resource, so a FHIR surface here would be a
 * profile this repository invented and presented as a standard. What a
 * provider sees through FHIR changes in one place: a reversal becomes the
 * case's response, so `$inquire` returns the approval.
 *
 * Filing is staff intake, because a request can arrive orally
 * (§ 422.584(c)(1)) and a member portal is not built. Every route here needs
 * a bearer credential when `SERVICE_CREDENTIALS` is set (P5-A): the
 * signature on a reconsideration or a dismissal binds it to a reviewer, and
 * the credential binds it to a caller.
 */
@Controller('review/appeals')
export class AppealController {
  constructor(@Inject(AppealService) private readonly appeals: AppealService) {}

  /** Files an appeal: `201` with the appeal, or `400`, `404`, `409` or `422`. */
  @Post()
  @HttpCode(201)
  file(@Body() body: unknown): Promise<AppealView> {
    return this.appeals.file(body);
  }

  /** Filed appeals, in the reconsideration clock's order and nothing else. */
  @Get()
  async queue(
    @Query(new ZodValidationPipe(QueueQuerySchema)) query: z.infer<typeof QueueQuerySchema>,
  ): Promise<{ appeals: AppealQueueItem[] }> {
    return { appeals: await this.appeals.queue(query.limit) };
  }

  /** One appeal: the case and its findings, the denial, the filing, and what to sign. */
  @Get(':appealId')
  view(@Param('appealId') appealId: string): Promise<AppealView> {
    return this.appeals.view(appealId);
  }

  /** The case file forwarded, or to be forwarded, to the independent entity. */
  @Get(':appealId/case-file')
  caseFile(@Param('appealId') appealId: string): Promise<CaseFileView> {
    return this.appeals.caseFile(appealId);
  }

  /**
   * A physician's signed reconsideration: `200` with the response in force.
   * It is given the principal the bearer token named, so a key registered to
   * a principal can be used by that caller only (403 otherwise), as P5-A
   * binds a determination. In open mode there is none, and the check does
   * not apply.
   */
  @Post(':appealId/reconsideration')
  @HttpCode(200)
  reconsider(
    @Param('appealId') appealId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<FhirBundle> {
    return this.appeals.reconsider(appealId, body, authenticatedPrincipal(req));
  }

  /** A signed dismissal: `200` with the appeal. The caller is bound as for a reconsideration. */
  @Post(':appealId/dismissal')
  @HttpCode(200)
  dismiss(
    @Param('appealId') appealId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<AppealView> {
    return this.appeals.dismiss(appealId, body, authenticatedPrincipal(req));
  }
}
