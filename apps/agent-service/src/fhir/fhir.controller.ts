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
  type FhirParameters,
} from '@repo/prior-auth';
import { FHIR_JSON } from '../configure-app.js';
import { FhirExceptionFilter } from './fhir-exception.filter.js';
import { InquiryService } from './inquiry.service.js';
import { PriorAuthService } from './prior-auth.service.js';

/**
 * The FHIR surface: `Claim/$submit`, `Claim/$inquire` and `metadata`, shaped
 * after Da Vinci PAS 2.2.1 and not conformant to it (P3-D, "What is
 * claimed"; P3-E for `$inquire`).
 *
 * It lives under `src/fhir/`, outside `src/agent/`, beside the clinician
 * review surface in `src/review/`. Every error on these routes is an
 * `OperationOutcome`.
 */
@Controller('fhir')
@UseFilters(FhirExceptionFilter)
export class FhirController {
  constructor(
    @Inject(PriorAuthService) private readonly priorAuth: PriorAuthService,
    @Inject(InquiryService) private readonly inquiry: InquiryService,
  ) {}

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

  /**
   * Query by example over the case table: a `Parameters` with one `return`
   * bundle per matching case, and none when nothing matches. The inquiry
   * `Claim`'s own identifier is not searched on.
   */
  @Post('Claim/$inquire')
  @HttpCode(200)
  @Header('Content-Type', FHIR_JSON)
  inquire(@Body() body: unknown): Promise<FhirParameters> {
    return this.inquiry.inquire(body);
  }

  /** The operations implemented, and nothing else. */
  @Get('metadata')
  @Header('Content-Type', FHIR_JSON)
  metadata(): FhirCapabilityStatement {
    return capabilityStatement(new Date().toISOString().slice(0, 10));
  }
}
