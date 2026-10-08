import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Node } from '../graph/node.js';
import { IO_RETRY } from '../graph/retry.js';
import { assessNode, disposeNode, intakeNode, lookupNode } from './nodes.js';
import type { PriorAuthGraphDeps, PriorAuthState } from './state.js';

/**
 * Every channel the nodes read or write. A key absent here is dropped between
 * nodes, so `PriorAuthState` and this annotation change together.
 */
const PriorAuthStateAnnotation = Annotation.Root({
  caseId: Annotation<PriorAuthState['caseId']>,
  bundle: Annotation<PriorAuthState['bundle']>,
  receivedAt: Annotation<PriorAuthState['receivedAt']>,
  request: Annotation<PriorAuthState['request']>,
  priority: Annotation<PriorAuthState['priority']>,
  decisionDueBy: Annotation<PriorAuthState['decisionDueBy']>,
  policy: Annotation<PriorAuthState['policy']>,
  referralReason: Annotation<PriorAuthState['referralReason']>,
  findings: Annotation<PriorAuthState['findings']>,
  disposition: Annotation<PriorAuthState['disposition']>,
});

export const PRIOR_AUTH_NODES = ['intake', 'lookup', 'assess', 'dispose'] as const;

/**
 * The prior-authorization graph: a second compiled graph, not a branch of the
 * chat graph, whose `ingress` parses a `RunRequest` and whose middle nodes
 * retrieve, plan, act, distill and reflect a conversation (P3-D, "The graph").
 *
 *   START → intake → lookup ─┬→ assess → dispose → END
 *                            └──────────→ dispose
 *
 * The nodes are typed with P3-A's `Node` alias over this graph's state, so a
 * wrapper that returned an adverse value, or a key the state does not have,
 * fails `yarn turbo typecheck` here as it does in the chat graph. It compiles
 * with the service's checkpointer, under the case id as `thread_id`; that
 * checkpoint is P3-B's audit record. On the unconfigured memory axis there is
 * no checkpointer, and the case lives only in the response.
 */
export function buildPriorAuthGraph(deps: PriorAuthGraphDeps, checkpointer?: BaseCheckpointSaver) {
  const intake: Node<PriorAuthState> = async (state) => intakeNode(state, deps);
  const lookup: Node<PriorAuthState> = async (state) => lookupNode(state, deps);
  const assess: Node<PriorAuthState> = async (state) => assessNode(state, deps);
  const dispose: Node<PriorAuthState> = async (state) => disposeNode(state, deps);

  // IO_RETRY on the one node that performs I/O. The other three are pure;
  // retrying them would only repeat a parse.
  const graph = new StateGraph(PriorAuthStateAnnotation)
    .addNode('intake', intake)
    .addNode('lookup', lookup)
    .addNode('assess', assess, { retryPolicy: IO_RETRY })
    .addNode('dispose', dispose)
    .addEdge(START, 'intake')
    .addEdge('intake', 'lookup')
    .addConditionalEdges(
      'lookup',
      (state) => ((state as PriorAuthState).referralReason === undefined ? 'assess' : 'dispose'),
      { assess: 'assess', dispose: 'dispose' },
    )
    .addEdge('assess', 'dispose')
    .addEdge('dispose', END);

  return graph.compile(checkpointer ? { checkpointer } : undefined);
}
