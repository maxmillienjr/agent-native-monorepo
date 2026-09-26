import type { AgentState } from './state.js';

/**
 * The type every node registered with a graph is written against.
 *
 * LangGraph does not check a node's return value against the state
 * annotation: an inline `addNode('x', async () => ({ anything: 42 }))`
 * compiles, whether the key is undeclared or the value is the wrong type.
 * Checked on `@langchain/langgraph` 0.4.10 (P3-A). A function typed `Node`
 * fails instead — TS2322 for a wrong value or a key the state does not have.
 *
 * One case needs more than the alias. An undeclared key returned beside a
 * declared one, `{ outcome, determination }`, compiles under `Node` alone,
 * because a contextually typed arrow's object literal gets no excess-property
 * check. An explicit return type does check it (TS2353), which is why every
 * node file declares `Promise<Partial<AgentState>>` and why a node written
 * inline that returns a literal should too. LangGraph drops the undeclared key
 * between nodes at runtime, and the strict parse in `buildRunResponse` refuses
 * one at egress. `disposition.test-d.ts` holds all of these.
 *
 * So a node file's `Promise<Partial<AgentState>>` stops being a convention each
 * file happens to follow and becomes a property of the place nodes are
 * registered. It is generic because a second graph with its own state (P3-D's)
 * is typed the same way. Keep it until a LangGraph version is shown to check
 * returns itself.
 */
export type Node<S = AgentState> = (state: S) => Promise<Partial<S>>;
