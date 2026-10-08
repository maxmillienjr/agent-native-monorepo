import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import * as jose from 'jose';
import canonicalize from 'canonicalize';
import { AgentCard, verifyAgentCardSignature } from '@a2a-js/sdk';
import { RunsService } from '../src/runs/runs.service.js';
import { bootService, type ServiceApp } from './service-app.js';

type Json = Record<string, unknown>;
type Signature = { protected: string; signature: string };

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const CARD = '/.well-known/agent-card.json';
const JSONRPC = '/a2a/jsonrpc';

let rpcId = 0;
const message = (text: string, extra: Json = {}) => ({
  messageId: `spec-${++rpcId}`,
  role: 'ROLE_USER',
  parts: [{ text }],
  ...extra,
});

/** A v1.0 JSON-RPC call, as the TCK and an SDK 1.x client send it. */
function rpc(service: ServiceApp, method: string, params: Json, token?: string) {
  const call = request(service.app.getHttpServer())
    .post(JSONRPC)
    .set('A2A-Version', '1.0')
    .set('Content-Type', 'application/json');
  if (token !== undefined) call.set('Authorization', `Bearer ${token}`);
  return call.send({ jsonrpc: '2.0', id: ++rpcId, method, params });
}

/** The `result` of every SSE frame, in order. */
function frames(text: string): Json[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => (JSON.parse(chunk.slice('data: '.length)) as { result: Json }).result);
}

describe('A2A, open', () => {
  let service: ServiceApp;

  beforeAll(async () => {
    service = await bootService();
  });

  afterAll(async () => {
    await service.close();
  });

  describe('the Agent Card', () => {
    let card: Json;

    beforeAll(async () => {
      const response = await request(service.app.getHttpServer())
        .get(CARD)
        .set('A2A-Version', '1.0');
      expect(response.status).toBe(200);
      card = response.body as Json;
    });

    it('round-trips through AgentCard.fromJSON unchanged', () => {
      expect(AgentCard.toJSON(AgentCard.fromJSON(card))).toEqual(card);
    });

    it('declares JSON-RPC at 1.0 and at 0.3, streaming and no push notifications', () => {
      expect(card['supportedInterfaces']).toEqual([
        {
          url: 'http://localhost:3000/a2a/jsonrpc',
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        },
        {
          url: 'http://localhost:3000/a2a/jsonrpc',
          protocolBinding: 'JSONRPC',
          protocolVersion: '0.3',
        },
      ]);
      expect(card['capabilities']).toMatchObject({ streaming: true, pushNotifications: false });
    });

    it('declares no security when none is enforced, and carries no signature with no key', () => {
      expect(card['securitySchemes']).toBeUndefined();
      expect(card['securityRequirements']).toBeUndefined();
      expect(card['signatures']).toBeUndefined();
    });
  });

  describe('SendStreamingMessage', () => {
    it('emits the task, a WORKING status per node, both artifacts and COMPLETED, then closes', async () => {
      const text = 'What is LangGraph?';
      const response = await rpc(service, 'SendStreamingMessage', { message: message(text) });
      expect(response.headers['content-type']).toContain('text/event-stream');

      const events = frames(response.text);
      const kinds = events.map((event) => Object.keys(event)[0]);

      const traced = await service.app.get(RunsService).executeTraced({
        body: {
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          messages: [{ role: 'user', content: text }],
        },
        correlationId: 'spec-traced',
      });
      const nodes = traced.nodeSequence;

      expect(kinds).toEqual([
        'task',
        ...nodes.map(() => 'statusUpdate'),
        'artifactUpdate',
        'artifactUpdate',
        'statusUpdate',
      ]);

      const task = events[0]!['task'] as Json;
      expect((task['status'] as Json)['state']).toBe('TASK_STATE_SUBMITTED');

      const working = events.slice(1, 1 + nodes.length).map((e) => e['statusUpdate'] as Json);
      expect(working.map((u) => (u['status'] as Json)['state'])).toEqual(
        nodes.map(() => 'TASK_STATE_WORKING'),
      );
      expect(working.map((u) => (u['metadata'] as Json)['node'])).toEqual(nodes);

      const artifacts = events
        .slice(1 + nodes.length, 3 + nodes.length)
        .map((e) => (e['artifactUpdate'] as Json)['artifact'] as Json);
      expect(artifacts.map((a) => a['name'])).toEqual(['answer', 'run']);
      const run = ((artifacts[1]!['parts'] as Json[])[0]!['data'] as Json) ?? {};
      expect(run).toMatchObject({ runId: task['id'], outcome: 'success', messageCount: 1 });

      const last = events[events.length - 1]!['statusUpdate'] as Json;
      expect((last['status'] as Json)['state']).toBe('TASK_STATE_COMPLETED');
    });
  });

  describe('v0.3', () => {
    it('completes a task for message/send with no A2A-Version header', async () => {
      const response = await request(service.app.getHttpServer())
        .post(JSONRPC)
        .send({
          jsonrpc: '2.0',
          id: ++rpcId,
          method: 'message/send',
          params: {
            message: {
              kind: 'message',
              messageId: `spec-${rpcId}`,
              role: 'user',
              parts: [{ kind: 'text', text: 'What is LangGraph?' }],
            },
          },
        });

      expect(response.body.error).toBeUndefined();
      expect(response.body.result).toMatchObject({ kind: 'task', status: { state: 'completed' } });
    });
  });
});

describe('A2A, when reflect fails on every attempt', () => {
  let service: ServiceApp;
  const SECRET = 'reflect-store-said-something-private';

  beforeAll(async () => {
    service = await bootService();
    const embedding = async () => new Array(4).fill(0);
    service.app.get(RunsService).setDeps({
      retrieve: { retrievalFacade: { retrieve: async () => [] }, embedQuery: embedding },
      plan: {
        callLlm: async () => ({ content: 'an answer', tokenCounts: { prompt: 1, completion: 1 } }),
      },
      act: {
        tools: [],
        selectTool: async () => ({ selection: null, tokenCounts: { prompt: 0, completion: 0 } }),
      },
      distill: {
        extractEntities: async () => ({
          extraction: { entities: [], relationships: [], facts: [] },
          tokenCounts: { prompt: 0, completion: 0 },
        }),
      },
      reflect: {
        episodicRepo: {
          write: async () => {
            throw new Error(SECRET);
          },
          findBySession: async () => [],
        },
        neo4jWriter: {
          mergeEntity: async () => {},
          mergeRelationship: async () => {},
          mergeFact: async () => {},
        },
        pgvectorWriter: { upsertFact: async () => {} },
        embedText: embedding,
      },
    });
  });

  afterAll(async () => {
    await service.close();
  });

  it('ends the stream FAILED, naming reflect and not the error', async () => {
    const response = await rpc(service, 'SendStreamingMessage', { message: message('Hello') });
    const events = frames(response.text);
    const last = events[events.length - 1]!['statusUpdate'] as Json;
    const status = last['status'] as Json;

    expect(status['state']).toBe('TASK_STATE_FAILED');
    const text = JSON.stringify(status['message']);
    expect(text).toContain('reflect');
    expect(response.text).not.toContain(SECRET);
  }, 20_000);
});

describe('A2A, enforced', () => {
  let service: ServiceApp;

  beforeAll(async () => {
    service = await bootService({
      SERVICE_CREDENTIALS: `a:${digest('token-a')},b:${digest('token-b')}`,
    });
  });

  afterAll(async () => {
    await service.close();
  });

  it('declares the bearer scheme and its requirement on the card', async () => {
    const response = await request(service.app.getHttpServer()).get(CARD).set('A2A-Version', '1.0');

    expect(response.body.securitySchemes).toEqual({
      bearer: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          description: 'Opaque service token issued out of band',
        },
      },
    });
    expect(response.body.securityRequirements).toEqual([
      { schemes: { bearer: { list: ['agent.invoke'] } } },
    ]);
  });

  it("does not show principal a's task to principal b", async () => {
    const sent = await rpc(service, 'SendMessage', { message: message('Hello') }, 'token-a');
    const taskId = (sent.body.result.task as Json)['id'] as string;

    const own = await rpc(service, 'GetTask', { id: taskId }, 'token-a');
    expect(own.body.result.id).toBe(taskId);

    const other = await rpc(service, 'GetTask', { id: taskId }, 'token-b');
    expect(other.body.error.code).toBe(-32001);

    const listed = await rpc(service, 'ListTasks', {}, 'token-b');
    const ids = ((listed.body.result.tasks ?? []) as Json[]).map((t) => t['id']);
    expect(ids).not.toContain(taskId);
  });
});

describe('A2A card signing', () => {
  let dir: string;
  let service: ServiceApp;
  let card: Json;
  let keys: { keys: (jose.JWK & { kid: string })[] };
  const debug = console.debug;

  beforeAll(async () => {
    // The SDK's verifier logs every signature that fails at debug, and half of
    // this block is signatures that must fail.
    console.debug = () => undefined;
    dir = await mkdtemp(join(tmpdir(), 'a2a-keys-'));
    const paths: string[] = [];
    for (const name of ['old', 'new']) {
      const { privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
      const path = join(dir, `${name}.pem`);
      await writeFile(path, await jose.exportPKCS8(privateKey));
      paths.push(path);
    }

    service = await bootService({
      SERVICE_CREDENTIALS: `spec:${digest('t')}`,
      A2A_CARD_SIGNING_KEYS: paths.join(','),
    });
    const server = service.app.getHttpServer();
    card = (await request(server).get(CARD).set('A2A-Version', '1.0')).body as Json;
    keys = (await request(server).get('/.well-known/jwks.json')).body;
  });

  afterAll(async () => {
    console.debug = debug;
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });

  const signatures = () => card['signatures'] as Signature[];

  const publicKey = async (kid: string) => {
    const jwk = keys.keys.find((k) => k.kid === kid);
    if (jwk === undefined) throw new Error(`no JWKS entry for ${kid}`);
    return jose.importJWK(jwk, 'ES256');
  };

  /** The SDK's verifier, over a card carrying this one signature. */
  const sdkVerifies = async (subject: Json, signature: Signature) =>
    verifyAgentCardSignature((kid) => publicKey(kid))({
      ...(subject as unknown as AgentCard),
      signatures: [{ ...signature, header: undefined }],
    }).then(
      () => true,
      () => false,
    );

  /** RFC 8785 over the card as served, minus `signatures`, with jose. */
  const independentVerifies = async (subject: Json, signature: Signature) => {
    const { signatures: _omitted, ...unsigned } = subject;
    const header = jose.decodeProtectedHeader(signature);
    try {
      await jose.flattenedVerify(
        {
          payload: jose.base64url.encode(canonicalize(unsigned)!),
          protected: signature.protected,
          signature: signature.signature,
        },
        await publicKey(header.kid!),
      );
      return true;
    } catch {
      return false;
    }
  };

  it('carries one signature per configured key, each verifiable by both verifiers', async () => {
    expect(signatures()).toHaveLength(2);
    expect(keys.keys).toHaveLength(2);
    expect(keys.keys.every((k) => k.d === undefined)).toBe(true);

    for (const signature of signatures()) {
      const header = jose.decodeProtectedHeader(signature);
      expect(header).toMatchObject({ alg: 'ES256', typ: 'JOSE' });
      expect(header.jku).toBe('http://localhost:3000/.well-known/jwks.json');
      expect(await sdkVerifies(card, signature)).toBe(true);
      expect(await independentVerifies(card, signature)).toBe(true);
    }
  });

  it('fails both verifiers for both signatures when the interface URL changes', async () => {
    const interfaces = card['supportedInterfaces'] as Json[];
    const tampered = {
      ...card,
      supportedInterfaces: interfaces.map((i) => ({ ...i, url: 'https://evil.example/a2a' })),
    };
    for (const signature of signatures()) {
      expect(await sdkVerifies(tampered, signature)).toBe(false);
      expect(await independentVerifies(tampered, signature)).toBe(false);
    }
  });

  it('fails both verifiers for both signatures when securityRequirements is deleted', async () => {
    const { securityRequirements: _deleted, ...tampered } = card;
    for (const signature of signatures()) {
      expect(await sdkVerifies(tampered, signature)).toBe(false);
      expect(await independentVerifies(tampered, signature)).toBe(false);
    }
  });

  it('serves the v0.3 card, to a caller with no A2A-Version, with no signature', async () => {
    const response = await request(service.app.getHttpServer()).get(CARD);

    expect(response.status).toBe(200);
    expect(response.body.protocolVersion).toBe('0.3');
    expect(response.body.signatures).toBeUndefined();
    expect(response.headers['vary']).toContain('A2A-Version');
  });
});
