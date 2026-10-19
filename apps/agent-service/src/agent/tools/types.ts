import type { z } from 'zod';

/**
 * What a tool changes, and whether the change can be taken back.
 *
 * - `read-only` changes nothing. Running it twice costs time and nothing else.
 * - `compensable` changes something outside the run, and declares the step
 *   that undoes it. An aborted loop runs that step (the saga, `compensate`).
 * - `irreversible` changes something nothing can undo. It runs only after a
 *   person approves the call (`approve`), and never on a graph that cannot
 *   pause to ask.
 */
export const REVERSIBILITY_TIERS = ['read-only', 'compensable', 'irreversible'] as const;
export type ReversibilityTier = (typeof REVERSIBILITY_TIERS)[number];

/**
 * What a tool is told about the call besides its input.
 *
 * The key is what makes a retried step safe for a tool with an effect. A retry
 * of `act`, or a run resumed from its checkpoint, re-enters with the same step
 * and so the same key, and a tool that deduplicates on it returns the effect it
 * already applied instead of applying a second one.
 */
export interface ToolContext {
  readonly runId: string;
  /** `${runId}:${stepCount}`: stable across a retry of one step, unique across steps. */
  readonly idempotencyKey: string;
}

/**
 * The input every tool declares. An object, so that the model is asked for
 * named fields and a bare string where an object belongs is refused by the
 * schema rather than coerced into one (a live `web-search` call did send its
 * query as a string).
 */
export type ToolInput = z.AnyZodObject;

/** A validated input, as any tool's `execute` takes one. */
export type ToolArgs = z.infer<ToolInput>;

interface ToolBase<I extends ToolInput, O> {
  /** `/^[a-z][a-z0-9-]{2,40}$/`, checked by `defineRegistry`. */
  readonly name: string;
  /** What it does, when to choose it, and what it changes. At least 40 characters. */
  readonly description: string;
  readonly input: I;
  execute(input: z.infer<I>, ctx: ToolContext): Promise<O>;
}

export interface ReadOnlyTool<I extends ToolInput = ToolInput, O = unknown> extends ToolBase<I, O> {
  readonly tier: 'read-only';
}

export interface CompensableTool<I extends ToolInput = ToolInput, O = unknown> extends ToolBase<
  I,
  O
> {
  readonly tier: 'compensable';
  /**
   * A semantic undo, not a restoration: whoever saw the effect may already
   * have acted on it. Called with the input and output the step recorded, and
   * must be idempotent on `ctx.idempotencyKey`, because a retried compensation
   * calls it again.
   */
  compensate(input: z.infer<I>, output: O, ctx: ToolContext): Promise<void>;
}

export interface IrreversibleTool<I extends ToolInput = ToolInput, O = unknown> extends ToolBase<
  I,
  O
> {
  readonly tier: 'irreversible';
}

/**
 * A tool, discriminated on its tier, so the type checker holds the rule rather
 * than a review note: a `compensable` definition without `compensate` does not
 * compile, and a `read-only` or `irreversible` one that carries a `compensate`
 * fails the excess-property check. `types.test-d.ts` holds both under
 * `@ts-expect-error`, the approach P3-A takes for the clinician gate.
 */
export type ToolDefinition<I extends ToolInput = ToolInput, O = unknown> =
  ReadOnlyTool<I, O> | CompensableTool<I, O> | IrreversibleTool<I, O>;

/**
 * Infers a definition's input and output from the literal, so `execute` and
 * `compensate` are checked against the schema they declare. `satisfies
 * ToolDefinition` would check the shape and leave both as `any` and `unknown`.
 */
export function defineTool<I extends ToolInput, O>(
  tool: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return tool;
}
