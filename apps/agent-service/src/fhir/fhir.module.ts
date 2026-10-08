import { Module } from '@nestjs/common';
import { systemClock } from '@repo/prior-auth';
import { MemoryModule } from '../memory/memory.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { FhirController } from './fhir.controller.js';
import { InquiryService } from './inquiry.service.js';
import { PRIOR_AUTH_CLOCK, PriorAuthService } from './prior-auth.service.js';

@Module({
  imports: [RunsModule, MemoryModule, LedgerModule],
  controllers: [FhirController],
  providers: [
    PriorAuthService,
    InquiryService,
    { provide: PRIOR_AUTH_CLOCK, useValue: systemClock },
  ],
  exports: [PriorAuthService, PRIOR_AUTH_CLOCK],
})
export class FhirModule {}
