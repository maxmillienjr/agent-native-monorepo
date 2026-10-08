import type { NestExpressApplication } from '@nestjs/platform-express';

/** FHIR's JSON media type (R4 §2.6.1). */
export const FHIR_JSON = 'application/fhir+json';

/**
 * What the HTTP application needs beyond its modules, in one place so that
 * `main.ts` and the service spec cannot drift apart.
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
 */
export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser('json', { type: ['application/json', FHIR_JSON] });
}
