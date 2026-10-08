import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  UseFilters,
} from '@nestjs/common';
import {
  capabilityStatement,
  type FhirBundle,
  type FhirCapabilityStatement,
} from '@repo/prior-auth';
import { FHIR_JSON } from '../configure-app.js';
import { FhirExceptionFilter } from './fhir-exception.filter.js';
import { PriorAuthService } from './prior-auth.service.js';

/**
 * The FHIR surface: `Claim/$submit` and `metadata`, shaped after Da Vinci PAS
 * 2.2.1 and not conformant to it (P3-D, "What is claimed").
 *
 * It lives under `src/fhir/`, outside `src/agent/`, because P3-E's clinician
 * route will import `@repo/determination/clinician`, which the lint rule
 * forbids under `src/agent/**`. Every error on these routes is an
 * `OperationOutcome`.
 */
@Controller('fhir')
@UseFilters(FhirExceptionFilter)
export class FhirController {
  constructor(@Inject(PriorAuthService) private readonly priorAuth: PriorAuthService) {}

  /**
   * One `Bundle` in, one `Bundle` out, with the `ClaimResponse` first. The body
   * is read at the boundary by `readSubmission`, which answers 400 for a body
   * that is not a `Bundle` with a `Claim` first and 422 for a claim the surface
   * cannot act on.
   */
  @Post('Claim/$submit')
  @HttpCode(200)
  @Header('Content-Type', FHIR_JSON)
  async submit(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<FhirBundle> {
    const run = await this.priorAuth.submit(body, correlationId ?? 'none');
    return run.response;
  }

  /** The operations implemented, and nothing else. */
  @Get('metadata')
  @Header('Content-Type', FHIR_JSON)
  metadata(): FhirCapabilityStatement {
    return capabilityStatement(new Date().toISOString().slice(0, 10));
  }
}
