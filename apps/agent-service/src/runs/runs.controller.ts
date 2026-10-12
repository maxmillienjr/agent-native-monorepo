import { Controller, Post, Body, Headers, Req, Res, HttpCode, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunRequestSchema, type RunRequest, type RunResponse } from '@repo/agent-contracts';
import { RunsService } from './runs.service.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { OPEN_PRINCIPAL } from '../auth/credentials.js';
import { principalOf } from '../auth/require-credential.js';
import { runsSessionId } from '../auth/session-scope.js';

/**
 * The request-body pipe, on the two parameters that take a `RunRequest`.
 *
 * It used to be global, which parsed every `@Body()` in every controller as a
 * `RunRequest`; the FHIR controller's `Bundle` got `400` naming `sessionId`.
 */
const runRequest = new ZodValidationPipe(RunRequestSchema);

/**
 * The body the run loop is given: the client's, with its session moved into
 * the caller's namespace (P5-D, ADR 0017).
 *
 * `principalOf` and not `authenticatedPrincipal`, which answers whether an
 * action can be bound to a person and so is undefined in open mode. Every
 * open-mode caller is `anonymous`, and so is a request that never passed the
 * middleware, as `mountA2a`'s `userBuilder` has it.
 *
 * Here and not in `RunsService`, which the evaluation harness calls in process
 * on the session its task seeded. The controller is this surface's half, as
 * `RunExecutor` is A2A's.
 */
function scoped(body: RunRequest, req: Request): RunRequest {
  return { ...body, sessionId: runsSessionId(principalOf(req) ?? OPEN_PRINCIPAL, body.sessionId) };
}

@Controller('runs')
export class RunsController {
  // The token is explicit because `yarn dev` runs through tsx, and esbuild does
  // not implement emitDecoratorMetadata. Without it Nest has no design:paramtypes
  // to resolve, injects undefined, and every request fails with "Cannot read
  // properties of undefined (reading 'execute')" — on the compiled path only,
  // where tsc does emit the metadata, so it works. This is the sole DI site.
  constructor(@Inject(RunsService) private readonly runsService: RunsService) {}

  @Post()
  @HttpCode(200)
  async createRun(
    @Body(runRequest) body: RunRequest,
    @Headers('x-correlation-id') correlationId: string,
    @Req() req: Request,
  ): Promise<RunResponse> {
    const response = await this.runsService.execute({ body: scoped(body, req), correlationId });
    // The client's id, not the stored one. A client continues a conversation by
    // sending its id again, and a derived id sent back would be derived twice.
    return { ...response, sessionId: body.sessionId };
  }

  // 200, not Nest's default 201 for a POST: a stream creates nothing the
  // response could locate, and the README's quickstart curl is promised a 200.
  @Post('stream')
  @HttpCode(200)
  async streamRun(
    @Body(runRequest) body: RunRequest,
    @Headers('x-correlation-id') correlationId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // The terminal frame carries a session id, and it is the client's, for the
    // reason `createRun` maps it back.
    await this.runsService.stream({
      body: scoped(body, req),
      correlationId,
      res,
      clientSessionId: body.sessionId,
    });
  }
}
