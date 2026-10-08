import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnvFile } from './load-env.js';
import { initTelemetry, createLogger } from '@repo/telemetry';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

const logger = createLogger('main');

async function bootstrap(): Promise<void> {
  // Before anything reads process.env. The README tells you to create a `.env`
  // and, until now, nothing on the Node path read it — `yarn dev` is bare
  // `tsx src/main.ts`, and every variable came from the ambient shell.
  loadEnvFile();

  initTelemetry('agent-service');

  // Nest aborts the process (SIGABRT, exit 134, a core dump and no message)
  // when a provider factory throws during initialization. A misconfigured
  // memory axis is a configuration mistake, and the operator needs to read
  // which variable was wrong — not a native stack trace.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { abortOnError: false });

  // Authentication, the body parser, trace context, `/health` and the A2A
  // routes, in that order. There is no `enableCors()`: see `configureApp`.
  configureApp(app);

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);

  logger.info({ msg: 'agent-service.ready', port });
}

bootstrap().catch((err: unknown) => {
  logger.error({
    msg: 'agent-service.fatal',
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
