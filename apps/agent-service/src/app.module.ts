import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { RunsModule } from './runs/runs.module.js';
import { FhirModule } from './fhir/fhir.module.js';
import { ReviewModule } from './review/review.module.js';
import { AuthModule } from './auth/auth.module.js';
import { A2aModule } from './a2a/a2a.module.js';
import { AuditInterceptor } from './common/interceptors/audit.interceptor.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { GlobalHttpExceptionFilter } from './common/filters/http-exception.filter.js';

@Module({
  imports: [AuthModule, RunsModule, FhirModule, ReviewModule, A2aModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: GlobalHttpExceptionFilter },
  ],
})
export class AppModule {}
