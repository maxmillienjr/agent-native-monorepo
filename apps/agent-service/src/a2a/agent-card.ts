import { z } from 'zod';
import { AgentCard } from '@a2a-js/sdk';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';

/** Where JSON-RPC is served, relative to the public URL. */
export const JSONRPC_PATH = '/a2a/jsonrpc';
export const JWKS_PATH = '/.well-known/jwks.json';

/** The one skill. Its id is public vocabulary: a client may route on it. */
export const SKILL_ID = 'answer-with-memory';

/**
 * The scope the bearer requirement names. A role name, which OpenAPI 3.1 and
 * 3.2 allow for a non-OAuth scheme. It is also what keeps the requirement
 * inside the signature: the SDK's canonical form drops an empty list, and the
 * requirement with it (P5-A, "What the protocol and the SDK are, measured").
 */
export const INVOKE_SCOPE = 'agent.invoke';

/** Bumped when the card's skill, interfaces or security change. */
export const CARD_VERSION = '1.0.0';

const PublicUrlSchema = z
  .string()
  .url()
  .refine((url) => /^https?:\/\//.test(url), 'must be an http or https URL')
  .transform((url) => url.replace(/\/+$/, ''));

/** A configured-but-broken A2A variable. Boot exits 1 on it. */
export class A2aConfigError extends Error {
  override readonly name = 'A2aConfigError';
}

/**
 * `A2A_PUBLIC_URL`: where a caller reaches this service. Compose sets the
 * gateway's URL, and the TCK job the auth proxy's, so the interface URL on the
 * card routes a caller through them. Unset is `http://localhost:3000`.
 */
export function readPublicUrl(env: NodeJS.ProcessEnv): string {
  const raw = env['A2A_PUBLIC_URL']?.trim() || 'http://localhost:3000';
  const parsed = PublicUrlSchema.safeParse(raw);
  if (!parsed.success) {
    throw new A2aConfigError(`A2A_PUBLIC_URL is not an http or https URL`);
  }
  return parsed.data;
}

/**
 * The Agent Card, unsigned, in the SDK's in-memory form.
 *
 * Security is declared only when it is enforced. In open mode the card says
 * nothing, so it tells the truth about the endpoint.
 *
 * Every field the card carries is non-empty and none holds a default value.
 * The SDK's canonical form drops empty values, including ones the
 * specification says to keep, so a card with none is one where the SDK's
 * canonical form and RFC 8785's agree and both verifiers check the same bytes.
 * The service spec's two-verifier test is what notices a card that stops
 * doing so.
 */
export function buildAgentCard(options: { publicUrl: string; secured: boolean }): AgentCard {
  return {
    name: 'agent-service',
    description:
      'A research assistant on a LangGraph agent with a three-tier memory. It answers from the conversation so far and from facts it distilled from earlier conversations.',
    version: CARD_VERSION,
    supportedInterfaces: duplicateInterfacesForLegacy(
      [
        {
          url: `${options.publicUrl}${JSONRPC_PATH}`,
          protocolBinding: 'JSONRPC',
          tenant: '',
          protocolVersion: '1.0',
        },
      ],
      ['JSONRPC'],
    ),
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: options.secured
      ? {
          bearer: {
            scheme: {
              $case: 'httpAuthSecurityScheme',
              value: {
                scheme: 'Bearer',
                description: 'Opaque service token issued out of band',
                bearerFormat: '',
              },
            },
          },
        }
      : {},
    securityRequirements: options.secured
      ? [{ schemes: { bearer: { list: [INVOKE_SCOPE] } } }]
      : [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: SKILL_ID,
        name: 'Answer with memory',
        description:
          'Answers a question in a conversation. The answer is a text artifact; a JSON artifact beside it carries the run id, the outcome and token counts.',
        tags: ['research', 'memory'],
        examples: ['What is LangGraph?'],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

/**
 * The card as JSON, ProtoJSON's way: oneofs as their field name and fields
 * at their default omitted. This is what is signed and what is served.
 * `JSON.stringify` of the in-memory form would serialize a security scheme's
 * oneof as `$case` and `value`, which no client parses.
 */
export function cardJson(card: AgentCard): Record<string, unknown> {
  return AgentCard.toJSON(card) as Record<string, unknown>;
}
