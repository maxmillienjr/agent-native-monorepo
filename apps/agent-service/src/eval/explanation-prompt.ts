import type { ConceptPath } from '@repo/memory-core';
import type { AgentState } from '../agent/graph/state.js';
import { PLAN_INSTRUCTION, PLAN_SYSTEM_PROMPT, buildPlanPrompt } from '../agent/nodes/plan.node.js';

/**
 * The two prompts P2-D's stage 2 compares.
 *
 * `without` is `plan`'s prompt exactly as `planNode` builds it, for a state
 * whose transcript is the query as one user turn and whose retrieved context
 * is what `VectorRetrievalFacade` returned. It is `buildPlanPrompt`'s output,
 * not a copy of its template, and a test holds it equal to what `planNode`
 * sends.
 *
 * `with` is the same prompt plus one block, `renderExplanationBlock`'s, placed
 * after the retrieved context it refers to and before the instruction, so the
 * instruction stays the last thing the model reads in both conditions.
 *
 * Under a keep outcome, P2-E wires the block into `plan` as it is measured
 * here; until then it is the evaluation's.
 */

export const EXPLANATION_HEADING = 'Connections in memory:';

/** One path: ids joined by their `RELATES_TO` type, undirected, since a path is matched in either direction. */
export function renderConceptPath(path: ConceptPath): string {
  return path.concepts
    .map((concept, i) => (i === 0 ? concept : `-[${path.edgeTypes[i - 1]!}]- ${concept}`))
    .join(' ');
}

/**
 * `Connections in memory:` and then, per retrieved fact with a path, one line:
 * `- context <n>: <id> -[<TYPE>]- <id> …`, numbered from 1 in the order the
 * context lists the facts, with a fact's paths (at most three, in the
 * explainer's order) separated by `; `. A length-0 path, where the fact
 * mentions a question concept itself, is that concept's id alone.
 *
 * Empty when no retrieved fact has a path: a heading over nothing would be a
 * difference between the conditions that carries no explanation.
 */
export function renderExplanationBlock(
  retrieved: readonly { readonly contentHash?: string | undefined }[],
  explanations: ReadonlyMap<string, readonly ConceptPath[]>,
): string {
  const lines = retrieved.flatMap((candidate, i) => {
    const paths =
      candidate.contentHash === undefined ? undefined : explanations.get(candidate.contentHash);
    if (paths === undefined || paths.length === 0) return [];
    return [`- context ${i + 1}: ${paths.map(renderConceptPath).join('; ')}`];
  });
  return lines.length === 0 ? '' : `${EXPLANATION_HEADING}\n${lines.join('\n')}`;
}

export interface Stage2Prompts {
  readonly system: string;
  readonly without: string;
  readonly with: string;
}

/** The state `planNode` would see for a query asked alone, with this context retrieved. */
export function stage2State(
  queryText: string,
  retrieved: AgentState['retrievedContext'],
): Pick<AgentState, 'messages' | 'retrievedContext'> {
  return { messages: [{ role: 'user', content: queryText }], retrievedContext: retrieved };
}

export function stage2Prompts(
  queryText: string,
  retrieved: AgentState['retrievedContext'],
  explanations: ReadonlyMap<string, readonly ConceptPath[]>,
): Stage2Prompts {
  const without = buildPlanPrompt(stage2State(queryText, retrieved));
  const block = renderExplanationBlock(retrieved, explanations);
  if (block === '') return { system: PLAN_SYSTEM_PROMPT, without, with: without };

  const tail = `\n\n${PLAN_INSTRUCTION}`;
  if (!without.endsWith(tail)) {
    throw new Error("plan's prompt no longer ends with its instruction; the block has no place");
  }
  const body = without.slice(0, without.length - tail.length);
  return { system: PLAN_SYSTEM_PROMPT, without, with: `${body}\n\n${block}${tail}` };
}
