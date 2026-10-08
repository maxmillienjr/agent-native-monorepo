import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { CypherNeo4jWriter } from '../src/semantic/neo4j/neo4j.writer.js';
import { CypherNeo4jExplainer } from '../src/semantic/neo4j/neo4j.explainer.js';
import { ensureSemanticConstraints } from '../src/semantic/neo4j/neo4j.constraints.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'password';

const SKIP = skipUnlessIntegrationEnv('Neo4j explainer (integration)', 'NEO4J_URI');

const SESSION_A = '550e8400-e29b-41d4-a716-44665544e0a1';
const SESSION_B = '550e8400-e29b-41d4-a716-44665544e0b2';
const EPISODE = '550e8400-e29b-41d4-a716-44665544e000';

/**
 * A hand-built graph, and the paths `explain` must return over it, computed
 * by hand from the specification rather than by running the explainer.
 *
 * Session A wrote these edges:
 *
 *     d -[T4]-> q -[T1]-> b        q -[T6]-> b
 *               q -[T2]-> x -[T3]-> c -[T5]-> far
 *
 * Session B wrote `q -[TB]-> c` and `zeta -[TZ]-> c`. Under A's scope neither
 * exists: `c` is two hops from `q`, not one, and `zeta` is not A's concept.
 */
describe.skipIf(SKIP)('Neo4j explainer (integration)', () => {
  let driver: Driver;
  let explainer: CypherNeo4jExplainer;

  const edge = (fromId: string, toId: string, type: string, sessionId = SESSION_A) => ({
    fromId,
    toId,
    type,
    confidence: 0.9,
    episodeId: EPISODE,
    sessionId,
  });
  const fact = (contentHash: string, entityIds: string[], sessionId = SESSION_A) => ({
    contentHash,
    text: `Fixture fact ${contentHash}.`,
    episodeId: EPISODE,
    sessionId,
    entityIds,
  });

  beforeAll(async () => {
    driver = neo4j.driver(NEO4J_URI!, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    const session = driver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
    await ensureSemanticConstraints(driver);

    const writer = new CypherNeo4jWriter(driver);
    for (const [id, label] of [
      ['q', 'Quarry Plan'],
      ['b', 'Bravo Review'],
      ['c', 'Charlie Network'],
      ['d', 'Delta Payer'],
      ['x', 'Xray Vendor'],
      ['far', 'Far Program'],
      ['zeta', 'Zeta Plan'],
    ] as const) {
      await writer.mergeEntity({ id, label });
    }
    for (const rel of [
      edge('q', 'b', 'T1'),
      edge('q', 'b', 'T6'),
      edge('q', 'x', 'T2'),
      edge('x', 'c', 'T3'),
      edge('d', 'q', 'T4'),
      edge('c', 'far', 'T5'),
      edge('q', 'c', 'TB', SESSION_B),
      edge('zeta', 'c', 'TZ', SESSION_B),
    ]) {
      await writer.mergeRelationship(rel);
    }
    for (const f of [
      fact('f-bravo', ['b']),
      fact('f-many', ['q', 'b', 'c', 'd']),
      fact('f-far', ['far']),
      fact('f-charlie', ['c']),
      fact('f-unmentioned', []),
      fact('f-session-b', ['q'], SESSION_B),
      // First writer A; B's restatement adds B's MENTIONS but not the fact.
      fact('f-shared', ['b']),
      fact('f-shared', ['b'], SESSION_B),
    ]) {
      await writer.mergeFact(f);
    }

    explainer = new CypherNeo4jExplainer(driver);
  });

  afterAll(async () => {
    await driver.close();
  });

  const explainA = (hashes: string[]) => explainer.explain(['q'], hashes, { sessionId: SESSION_A });

  it('returns every shortest path to a mentioned concept, one per edge type', async () => {
    expect((await explainA(['f-bravo'])).get('f-bravo')).toEqual([
      { concepts: ['q', 'b'], edgeTypes: ['T1'] },
      { concepts: ['q', 'b'], edgeTypes: ['T6'] },
    ]);
  });

  it('orders by length then key and returns at most three, a direct mention first', async () => {
    expect((await explainA(['f-many'])).get('f-many')).toEqual([
      { concepts: ['q'], edgeTypes: [] },
      { concepts: ['q', 'b'], edgeTypes: ['T1'] },
      { concepts: ['q', 'd'], edgeTypes: ['T4'] },
    ]);
  });

  it('stops at two hops', async () => {
    expect((await explainA(['f-far'])).get('f-far')).toEqual([]);
  });

  it('crosses only edges the session wrote', async () => {
    // B's q-[TB]->c would make this one hop.
    expect((await explainA(['f-charlie'])).get('f-charlie')).toEqual([
      { concepts: ['q', 'x', 'c'], edgeTypes: ['T2', 'T3'] },
    ]);
    expect(
      (await explainer.explain(['q'], ['f-session-b'], { sessionId: SESSION_B })).get(
        'f-session-b',
      ),
    ).toEqual([{ concepts: ['q'], edgeTypes: [] }]);
  });

  it('returns nothing for a fact another session owns, even one it restated', async () => {
    const forA = await explainA(['f-session-b', 'f-shared', 'f-unmentioned']);
    expect(forA.has('f-session-b')).toBe(false);
    expect(forA.get('f-shared')).toEqual([
      { concepts: ['q', 'b'], edgeTypes: ['T1'] },
      { concepts: ['q', 'b'], edgeTypes: ['T6'] },
    ]);
    expect(forA.get('f-unmentioned')).toEqual([]);

    const forB = await explainer.explain(['q'], ['f-shared', 'f-bravo'], { sessionId: SESSION_B });
    expect([...forB.keys()]).toEqual([]);
  });

  it('links only concepts the session has an edge to', async () => {
    const text = 'Does Zeta Plan or Quarry Plan use Charlie Network?';
    expect(await explainer.linkQuestionConcepts(text, { sessionId: SESSION_A })).toEqual([
      'q',
      'c',
    ]);
    expect(await explainer.linkQuestionConcepts(text, { sessionId: SESSION_B })).toEqual([
      'zeta',
      'q',
      'c',
    ]);
  });
});
