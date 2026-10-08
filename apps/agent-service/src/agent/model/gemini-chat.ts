import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { chatUsage, createLogger, withInferenceSpan, type InferenceSeam } from '@repo/telemetry';
import { usageOf, type CallUsage } from './usage.js';

const logger = createLogger('gemini-chat');

/**
 * As much of a LangChain chat reply as anything here reads.
 *
 * Structural so a test can hand in a fake reply, and so the finish reason is
 * read from where the pinned client puts it: `@langchain/google-genai` spreads
 * the first candidate, minus its content, into `additional_kwargs`, and
 * `@langchain/core` copies generation info into `response_metadata`.
 */
export interface ChatReply {
  readonly content: unknown;
  readonly usage_metadata?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly response_metadata?: Readonly<Record<string, unknown>>;
  readonly additional_kwargs?: Readonly<Record<string, unknown>>;
}

export interface ChatClient {
  invoke(messages: [SystemMessage, HumanMessage]): Promise<ChatReply>;
}

export interface ChatRequest {
  readonly model: string;
  readonly seam: Exclude<InferenceSeam, 'embed'>;
  /** The client was built with `json: true`, which asks Gemini for `application/json`. */
  readonly json: boolean;
}

export interface ChatResult {
  readonly content: string;
  /**
   * The span's figures, from the same derivation: `completion` is billed
   * output, thought tokens included (P1-F). It used to be the candidate count,
   * which left out most of what a thinking model is billed for.
   */
  readonly tokenCounts: CallUsage;
}

function finishReasonsOf(reply: ChatReply): string[] {
  const reason =
    reply.response_metadata?.['finishReason'] ?? reply.additional_kwargs?.['finishReason'];
  return typeof reason === 'string' ? [reason] : [];
}

/**
 * One `generateContent` call, inside its inference span.
 *
 * The span is opened here, at the client, rather than at the `ModelDeps` seam:
 * a seam-level span would exist on the stub axis too and describe a canned
 * string as a Gemini call, and only here is the raw reply — finish reason and
 * total token count — still in reach.
 */
export async function invokeChat(
  client: ChatClient,
  request: ChatRequest,
  systemPrompt: string,
  userPrompt: string,
): Promise<ChatResult> {
  return withInferenceSpan(
    {
      operation: 'generate_content',
      model: request.model,
      seam: request.seam,
      ...(request.json ? { outputType: 'json' as const } : {}),
    },
    async (span) => {
      const reply = await client.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);
      const meta = reply.usage_metadata;

      if (meta !== undefined) {
        span.recordUsage(chatUsage(meta));
        // The client's own counts, beside the span's derived ones: the only
        // way to check the derivation against a live reply.
        logger.debug({ msg: 'gen_ai.usage.reported', seam: request.seam, usage: meta });
      }
      span.recordFinishReasons(finishReasonsOf(reply));

      return {
        content: typeof reply.content === 'string' ? reply.content : '',
        tokenCounts: usageOf(meta),
      };
    },
  );
}
