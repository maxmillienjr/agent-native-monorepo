import { Global, Module } from '@nestjs/common';
import { parseCredentials, SERVICE_CREDENTIALS, type ServiceCredentials } from './credentials.js';

/**
 * Provides the parsed `SERVICE_CREDENTIALS` to `configureApp`, which mounts the
 * middleware, and to the Agent Card, which declares the scheme only when it is
 * enforced. One parse, so the card cannot disagree with the endpoint.
 *
 * A malformed value throws from the factory; `main.ts` turns that into exit 1
 * with the message, which names the variable.
 */
@Global()
@Module({
  providers: [
    {
      provide: SERVICE_CREDENTIALS,
      useFactory: (): ServiceCredentials => parseCredentials(process.env),
    },
  ],
  exports: [SERVICE_CREDENTIALS],
})
export class AuthModule {}
