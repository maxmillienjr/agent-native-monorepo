import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CaseRepository } from '@repo/memory-core';
import {
  BundleSchema,
  ClaimResponseSchema,
  inquiryMatches,
  inquiryResult,
  loadPayer,
  operationOutcome,
  readInquiry,
  type FhirBundle,
  type FhirParameters,
  type Payer,
} from '@repo/prior-auth';
import { withServiceSpan } from '@repo/telemetry';
import { CASE_REPOSITORY } from '../memory/memory.tokens.js';
import { OperationOutcomeException } from './prior-auth.service.js';

/**
 * `Claim/$inquire` (P3-E), shaped after PAS 2.2.1's query by example.
 *
 * Each case that matches the inquiry's member, insurer and provider, and its
 * items when it has any, contributes the response bundle it holds now: a
 * pended case answers `queued` until a clinician decides it and `complete`
 * after, and an overdue case is still `queued`, because the sweep flags and
 * never decides.
 *
 * PAS says a payer "SHALL permit access to the prior authorization response
 * to systems other than the original submitter" (§spec-52), so nothing here
 * scopes results to whoever submitted the request. P5-A's authentication is
 * what decides who may call it.
 */
@Injectable()
export class InquiryService {
  private readonly payer: Payer = loadPayer();

  constructor(@Inject(CASE_REPOSITORY) private readonly cases: CaseRepository) {}

  inquire(body: unknown): Promise<FhirParameters> {
    return withServiceSpan('fhir.inquire', async (span) => {
      const reading = readInquiry(body, this.payer);
      if (reading.kind === 'invalid') {
        throw new OperationOutcomeException(
          HttpStatus.BAD_REQUEST,
          operationOutcome(reading.issues),
        );
      }
      if (reading.kind === 'unprocessable') {
        throw new OperationOutcomeException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          operationOutcome(reading.issues),
        );
      }

      const { inquiry } = reading;
      // The store narrows by code only when every item names one: an item
      // without a code matches any.
      const codes = inquiry.items.map((item) => item.hcpcs);
      const rows = await this.cases.match({
        memberId: inquiry.memberId,
        insurerId: inquiry.insurerId,
        providerId: inquiry.providerId,
        ...(codes.length > 0 && codes.every((code) => code !== undefined)
          ? { hcpcs: codes.filter((code): code is string => code !== undefined) }
          : {}),
      });

      const bundles: FhirBundle[] = rows.flatMap((row) => {
        const bundle = BundleSchema.parse(row.response);
        const claimResponse = ClaimResponseSchema.parse(bundle.entry?.[0]?.resource);
        return inquiryMatches(inquiry, { hcpcs: row.hcpcs, preAuthRef: claimResponse.preAuthRef })
          ? [bundle]
          : [];
      });
      span.setAttribute('prior_auth.match_count', bundles.length);
      return inquiryResult(bundles);
    });
  }
}
