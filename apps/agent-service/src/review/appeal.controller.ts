import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { FhirBundle } from '@repo/prior-auth';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
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
 * (§ 422.584(c)(1)) and a member portal is not built. P5-A's authentication
 * is meant to cover `/review/*`, these routes included; until then the
 * signature on a reconsideration or a dismissal is what binds it to a
 * reviewer, and the reads are anonymous.
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

  /** A physician's signed reconsideration: `200` with the response in force. */
  @Post(':appealId/reconsideration')
  @HttpCode(200)
  reconsider(@Param('appealId') appealId: string, @Body() body: unknown): Promise<FhirBundle> {
    return this.appeals.reconsider(appealId, body, undefined);
  }

  /** A signed dismissal: `200` with the appeal. */
  @Post(':appealId/dismissal')
  @HttpCode(200)
  dismiss(@Param('appealId') appealId: string, @Body() body: unknown): Promise<AppealView> {
    return this.appeals.dismiss(appealId, body, undefined);
  }
}
