import { StateGraph, END, START, Annotation } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { AgentState } from './state.js';
import type { Node } from './node.js';
import { shouldContinueActing, shouldKeepCompensating } from './edges.js';
import { ingressNode } from '../nodes/ingress.node.js';
import { retrieveNode, type RetrieveNodeDeps } from '../nodes/retrieve.node.js';
import { planNode, type PlanNodeDeps } from '../nodes/plan.node.js';
import { actNode, type ActNodeDeps } from '../nodes/act.node.js';
import { approveNode } from '../nodes/approve.node.js';
import { compensateNode } from '../nodes/compensate.node.js';
import { distillNode, type DistillNodeDeps } from '../nodes/distill.node.js';
import { reflectNode, type ReflectNodeDeps } from '../nodes/reflect.node.js';
import { egressNode } from '../nodes/egress.node.js';
import { IO_RETRY } from './retry.js';

export interface GraphDeps {
  retrieve: RetrieveNodeDeps;
  plan: PlanNodeDeps;
  act: ActNodeDeps;
  distill: DistillNodeDeps;
  reflect: ReflectNodeDeps;
}

const AgentStateAnnotation = Annotation.Root({
  runId: Annotation<string>,
  sessionId: Annotation<string>,
  correlationId: Annotation<string>,
  messages: Annotation<AgentState['messages']>,
  retrievedContext: Annotation<AgentState['retrievedContext']>,
  currentPlan: Annotation<string | undefined>,
  toolOutputs: Annotation<AgentState['toolOutputs']>,
  tokenCounts: Annotation<AgentState['tokenCounts']>,
  outcome: Annotation<AgentState['outcome']>,
  stepCount: Annotation<number>,
  maxSteps: Annotation<number>,
  topK: Annotation<number>,
  shouldContinue: Annotation<boolean>,
  aborted: Annotation<boolean>,
  pendingApproval: Annotation<AgentState['pendingApproval']>,
  // Must be here as well as in AgentStateSchema. A key absent from the
  // annotation is dropped between nodes, and the failure mode is a `reflect`
  // that silently writes nothing.
  extraction: Annotation<AgentState['extraction']>,
});

export function buildAgentGraph(
  deps: GraphDeps,
  rawBody: unknown,
  correlationId: string,
  checkpointer?: BaseCheckpointSaver,
) {
  // Every wrapper is typed `Node`, because LangGraph does not check what an
  // inline node returns against the annotation. See `node.ts`.
  const ingress: Node = async (state) => ingressNode(state, rawBody, correlationId);
  const retrieve: Node = async (state) => retrieveNode(state, deps.retrieve);
  const plan: Node = async (state) => planNode(state, deps.plan);
  // The approval gate pauses on `interrupt()`, which needs a checkpointer to
  // pause on. Without one, `act` refuses an irreversible call instead of
  // routing it to a node that would throw.
  const approvals = checkpointer ? 'pause' : 'refuse';
  const act: Node = async (state) => actNode(state, deps.act, approvals);
  const approve: Node = async (state) => approveNode(state, deps.act);
  const compensate: Node = async (state) => compensateNode(state, deps.act);
  const distill: Node = async (state) => distillNode(state, deps.distill);
  const reflect: Node = async (state) => reflectNode(state, deps.reflect);
  const egress: Node = async (state) => egressNode(state);

  // IO_RETRY goes on every node that performs I/O and on none that does not.
  // `ingress` and `egress` are pure; retrying them would only repeat a Zod
  // parse. `distill` carries it too — it makes a model call, and having no
  // side effects makes it the safest node in the graph to re-run.
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('ingress', ingress)
    .addNode('retrieve', retrieve, { retryPolicy: IO_RETRY })
    .addNode('plan', plan, { retryPolicy: IO_RETRY })
    .addNode('act', act, { retryPolicy: IO_RETRY })
    // A compensation is a call to the world like any other, and a retried
    // attempt repeats it under the same key.
    .addNode('compensate', compensate, { retryPolicy: IO_RETRY })
    // Executes the approved call, so it carries the policy too. A retried
    // attempt re-enters at `interrupt()`, which returns the same decision.
    .addNode('approve', approve, { retryPolicy: IO_RETRY })
    .addNode('distill', distill, { retryPolicy: IO_RETRY })
    .addNode('reflect', reflect, { retryPolicy: IO_RETRY })
    .addNode('egress', egress)
    .addEdge(START, 'ingress')
    .addEdge('ingress', 'retrieve')
    .addEdge('retrieve', 'plan')
    .addEdge('plan', 'act')
    .addConditionalEdges('act', (state) => shouldContinueActing(state as AgentState), {
      act: 'act',
      approve: 'approve',
      compensate: 'compensate',
      distill: 'distill',
    })
    .addConditionalEdges('approve', (state) => shouldContinueActing(state as AgentState), {
      act: 'act',
      approve: 'approve',
      compensate: 'compensate',
      distill: 'distill',
    })
    .addConditionalEdges('compensate', (state) => shouldKeepCompensating(state as AgentState), {
      compensate: 'compensate',
      distill: 'distill',
    })
    .addEdge('distill', 'reflect')
    .addEdge('reflect', 'egress')
    .addEdge('egress', END);

  return graph.compile(checkpointer ? { checkpointer } : undefined);
}
