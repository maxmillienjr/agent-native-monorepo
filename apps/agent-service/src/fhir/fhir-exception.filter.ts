import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { createLogger } from '@repo/telemetry';
import { OperationOutcomeSchema, operationOutcome } from '@repo/prior-auth';
import { FHIR_JSON } from '../configure-app.js';

const logger = createLogger('fhir-exception');

/**
 * Writes every error on a FHIR route as an `OperationOutcome`.
 *
 * A 4xx that already carries one is written unchanged. Any other 4xx is
 * wrapped, keeping its message. A 5xx says only that the server failed: its
 * message can quote a prompt or a store error, and neither belongs in a
 * response, the same rule `GlobalHttpExceptionFilter` applies.
 */
export function writeOperationOutcome(exception: unknown, res: Response): void {
  const status =
    exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  const payload = exception instanceof HttpException ? exception.getResponse() : undefined;
  const carried = OperationOutcomeSchema.safeParse(payload);

  const body = carried.success
    ? carried.data
    : status < HttpStatus.INTERNAL_SERVER_ERROR
      ? operationOutcome([
          {
            code: status === HttpStatus.BAD_REQUEST ? 'structure' : 'processing',
            diagnostics: exception instanceof Error ? exception.message : 'Bad Request',
          },
        ])
      : operationOutcome([{ code: 'exception', diagnostics: 'Internal Server Error' }]);

  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
    logger.error({
      msg: 'fhir.exception',
      status,
      stack: exception instanceof Error ? exception.stack : undefined,
    });
  }

  res.status(status).type(FHIR_JSON).send(JSON.stringify(body));
}

@Catch()
export class FhirExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    writeOperationOutcome(exception, host.switchToHttp().getResponse<Response>());
  }
}
