import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';

/**
 * Every variable that selects an axis or a mode. A spec must not pass or fail
 * according to the developer's shell (`.context/conventions.md`, Testing), so
 * each is cleared unless the spec sets it.
 */
const AXIS_VARIABLES = [
  'GOOGLE_API_KEY',
  'DATABASE_URL',
  'NEO4J_URI',
  'SERVICE_CREDENTIALS',
  'A2A_PUBLIC_URL',
  'A2A_CARD_SIGNING_KEYS',
] as const;

export interface ServiceApp {
  readonly app: NestExpressApplication;
  close(): Promise<void>;
}

/**
 * The application as `main.ts` builds it, on the stub model and memory axes,
 * with `env` set for the duration of the boot and restored by `close`.
 */
export async function bootService(
  env: Partial<Record<(typeof AXIS_VARIABLES)[number], string>> = {},
): Promise<ServiceApp> {
  const saved = new Map(AXIS_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of AXIS_VARIABLES) delete process.env[name];
  Object.assign(process.env, env);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();

  return {
    app,
    async close() {
      await app.close();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}
