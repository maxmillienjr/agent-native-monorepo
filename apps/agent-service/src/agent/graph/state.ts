import { z } from 'zod';
import { WorkingMemorySchema } from '@repo/memory-core';
import { REVERSIBILITY_TIERS } from '../tools/types.js';

/**
 * One step of the `act` loop, and the saga's log of it.
 *
 * `effect` is what compensation reads: `applied` is a compensable step that
 * succeeded and has not been undone, `compensated` one that has, and `none`
 * every step that changed nothing or failed. `tier` is absent only for a
 * selection naming a tool the registry does not hold. `approver` is set on an
 * irreversible call a person approved or rejected.
 */
export const ToolOutputSchema = z.object({
  toolName: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().optional(),
  tier: z.enum(REVERSIBILITY_TIERS).optional(),
  idempotencyKey: z.string(),
  effect: z.enum(['none', 'applied', 'compensated']),
  approver: z.string().optional(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

/**
 * An irreversible call waiting on a person: what `approve` passes to
 * `interrupt()` and what a resume is asked to decide. The input has already
 * passed the tool's schema; `approve` parses it again on resume, because a
 * checkpoint is deserialized JSON no schema has seen.
 */
export const PendingApprovalSchema = z.object({
  toolName: z.string(),
  input: z.unknown(),
  tier: z.literal('irreversible'),
  idempotencyKey: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;

/**
 * The resume value `approve` accepts. Strict, and passed to `interrupt()` as
 * its `responseSchema`, so on LangGraph 1.4 a resume with any other shape
 * throws a `ZodError` and leaves the thread paused: a malformed decision is
 * refused rather than read as one.
 */
export const ApprovalDecisionSchema = z
  .object({ approved: z.boolean(), approver: z.string().min(1) })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * What `distill` extracts and `reflect` writes.
 *
 * It lives in state rather than inside one node because the two halves are
 * separated on purpose: `reflect` must be a function of its input state for a
 * retry to replay identical writes. See `distill.node.ts`.
 */
export const ExtractionSchema = z.object({
  entities: z.array(
    z.object({ id: z.string(), label: z.string(), description: z.string().optional() }),
  ),
  relationships: z.array(
    z.object({
      fromId: z.string(),
      toId: z.string(),
      type: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  facts: z.array(z.object({ text: z.string() })),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export const AgentStateSchema = WorkingMemorySchema.extend({
  stepCount: z.number().int().nonnegative().default(0),
  maxSteps: z.number().int().positive().default(10),
  // The retrieval knob from RunRequestConfig. It was validated at the boundary
  // and then dropped: `retrieve` hardcoded topK 10, so a client could set it
  // and nothing downstream read it. `hopDepth` was removed with ADR 0009,
  // which made retrieval vector-only and left nothing to read it.
  topK: z.number().int().positive().default(10),
  shouldContinue: z.boolean().default(true),
  currentPlan: z.string().optional(),
  toolOutputs: z.array(ToolOutputSchema).default([]),
  /**
   * A step failed, so the loop stops and the applied effects are undone. Any
   * failure aborts — a throw, an invalid input, an unknown tool, a rejected
   * approval — so a partial sequence of effects is never left standing.
   */
  aborted: z.boolean().default(false),
  /** Set by `act` on an irreversible selection, and cleared by `approve` once decided. */
  pendingApproval: PendingApprovalSchema.nullable().default(null),
  extraction: ExtractionSchema.optional(),
});

export type AgentState = z.infer<typeof AgentStateSchema>;
