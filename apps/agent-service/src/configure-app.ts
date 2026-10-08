import type { NestExpressApplication } from '@nestjs/platform-express';
import { SERVICE_CREDENTIALS, type ServiceCredentials } from './auth/credentials.js';
import { announceAuthMode, requireCredential } from './auth/require-credential.js';

/** FHIR's JSON media type (R4 §2.6.1). */
export const FHIR_JSON = 'application/fhir+json';

/**
 * What the HTTP application needs beyond its modules, in one place so that
 * `main.ts` and the service spec cannot drift apart.
 *
 * Order matters, and it is the order of the calls below. Authentication comes
 * first, so an unauthenticated body is never parsed. Then the body parser,
 * then the routes this function owns. Nest's controllers are registered at
 * `init()`, after all of it.
 *
 * One JSON parser for both media types, replacing Nest's default rather than
 * sitting beside it. Nest registers its own `jsonParser` at `init()` only if
 * no middleware of that name is already applied, and `express.json` always
 * has that name, so a second parser registered here for FHIR alone would
 * silently stop `application/json` being parsed at all.
 *
 * There is deliberately no global pipe. `ZodValidationPipe(RunRequestSchema)`
 * used to be installed here for every `@Body()`, so a FHIR `Bundle` got `400`
 * naming `sessionId` (P3-D's probe). It now sits on `RunsController`'s two
 * parameters, the only bodies that are a `RunRequest`.
 *
 * There is deliberately no CORS either. The console reaches the service
 * same-origin, through nginx or the Vite proxy, and with bearer tokens in play
 * `Access-Control-Allow-Origin: *` only helps a page that should not hold one.
 */
export function configureApp(app: NestExpressApplication): void {
  const credentials = app.get<ServiceCredentials>(SERVICE_CREDENTIALS);
  announceAuthMode(credentials);
  app.use(requireCredential(credentials));

  app.useBodyParser('json', { type: ['application/json', FHIR_JSON] });

  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/health', (_req, res) => {
    httpAdapter.reply(res, { status: 'ok' }, 200);
  });
}
