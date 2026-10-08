import { Module } from '@nestjs/common';
import { systemClock } from '@repo/prior-auth';
import { MemoryModule } from '../memory/memory.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { FhirController } from './fhir.controller.js';
import { PRIOR_AUTH_CLOCK, PriorAuthService } from './prior-auth.service.js';

@Module({
  imports: [RunsModule, MemoryModule],
  controllers: [FhirController],
  providers: [PriorAuthService, { provide: PRIOR_AUTH_CLOCK, useValue: systemClock }],
  exports: [PriorAuthService],
})
export class FhirModule {}
