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

/**
 * A reply with no answer text in it: no parts, or only thought parts, or text
 * parts that are all empty. The nightly of 2026-11-11 and 2026-11-12 met one
 * on `plan`; it reached `reflect` as an empty assistant turn and the episodic
 * schema aborted the suite before its first trial finished.
 *
 * Deliberately not a `ZodError` and with no `status`, so `IO_RETRY` re-runs
 * the node and makes the call again, as it does for `ExtractionFormatError`.
 * An empty answer is never a legitimate reply from any seam that calls this.
 */
export class EmptyReplyError extends Error {
  constructor(
    readonly seam: ChatRequest['seam'],
    readonly finishReasons: readonly string[],
  ) {
    super(
      `${seam}: the model replied with no text` +
        (finishReasons.length > 0 ? ` (finish reason ${finishReasons.join(', ')})` : ''),
    );
    this.name = 'EmptyReplyError';
  }
}

/**
 * The answer text of a reply.
 *
 * `@langchain/google-genai` returns a string only when the candidate has one
 * non-thought text part. Two or more parts — a split answer, or a text part
 * beside a part carrying only a thought signature — arrive as an array of
 * typed parts, and this used to read every array as `''`. The answer is the
 * `text` parts joined; `thinking` parts are the model's reasoning, not its
 * answer, and are left out.
 */
export function replyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      if (typeof part !== 'object' || part === null) return '';
      const { type, text } = part as { type?: unknown; text?: unknown };
      return type === 'text' && typeof text === 'string' ? text : '';
    })
    .join('');
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
      const finishReasons = finishReasonsOf(reply);
      span.recordFinishReasons(finishReasons);

      const content = replyText(reply.content);
      if (content.trim() === '') throw new EmptyReplyError(request.seam, finishReasons);

      return {
        content,
        tokenCounts: usageOf(meta),
      };
    },
  );
}
