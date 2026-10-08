import {
  type ExceptionFilter,
  Catch,
  type ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { createLogger, getCorrelationId } from '@repo/telemetry';
import { writeOperationOutcome } from '../../fhir/fhir-exception.filter.js';

const logger = createLogger('http-exception');

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // A FHIR route answers in FHIR even when the failure is upstream of its
    // controller, where `FhirExceptionFilter` cannot see it: a body the JSON
    // parser rejected reaches this filter, not that one.
    if (req.path.startsWith('/fhir/')) {
      writeOperationOutcome(exception, res);
      return;
    }

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException ? exception.message : 'Internal Server Error';

    const correlationId =
      getCorrelationId() ?? (req as Request & { correlationId?: string }).correlationId;

    // A 4xx HttpException may carry a structured payload: ZodValidationPipe puts
    // `error: 'Validation Error'` and the Zod `issues` array there. Flattening it
    // to a generic 'Bad Request' discards the only part of the response a client
    // can act on. 5xx payloads are never forwarded — they may carry internals.
    const detail =
      exception instanceof HttpException && status < HttpStatus.INTERNAL_SERVER_ERROR
        ? exception.getResponse()
        : undefined;

    const body = {
      error: status >= HttpStatus.INTERNAL_SERVER_ERROR ? 'Internal Server Error' : 'Bad Request',
      message,
      ...(typeof detail === 'object' && detail !== null ? detail : {}),
      statusCode: status,
      correlationId,
    };

    logger.error({
      msg: 'unhandled.exception',
      ...body,
      stack: exception instanceof Error ? exception.stack : undefined,
    });

    res.status(status).json(body);
  }
}
