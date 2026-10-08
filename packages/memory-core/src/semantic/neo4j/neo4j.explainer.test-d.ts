/**
 * Type tests, checked by `tsc --noEmit` under `yarn turbo typecheck` and never
 * run by Vitest.
 *
 * The explainer has no unscoped form. An explanation returns the concept ids
 * and edge types it crosses, so a call that names no session would show one
 * session's graph to another — the leak P4-B's M1 closes, reached by a
 * different reader. If someone makes the scope optional, or adds a
 * `crossSession` escape, these lines stop compiling.
 */
import { expectTypeOf } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { CypherNeo4jExplainer, type ExplanationScope } from './neo4j.explainer.js';
import { CypherNeo4jReader } from './neo4j.reader.js';

declare const driver: Driver;
const explainer = new CypherNeo4jExplainer(driver);

expectTypeOf<ExplanationScope>().toEqualTypeOf<{ readonly sessionId: string }>();
expectTypeOf<Parameters<CypherNeo4jExplainer['explain']>[2]>().toEqualTypeOf<ExplanationScope>();

// @ts-expect-error TS2554: the scope is required.
void explainer.explain(['plan_a'], ['hash']);

// @ts-expect-error TS2741: a scope without a session is not a scope.
void explainer.explain(['plan_a'], ['hash'], {});

// @ts-expect-error TS2353: there is no cross-session explanation.
void explainer.explain(['plan_a'], ['hash'], { sessionId: 's', crossSession: true });

// @ts-expect-error TS2554: nor a cross-session linker.
void explainer.linkQuestionConcepts('Which plan?');

// The retrieval reader carries the same scope since M1.
// @ts-expect-error TS2554: expandFromSeeds has no unscoped form either.
void new CypherNeo4jReader(driver).expandFromSeeds(['plan_a'], 2);
