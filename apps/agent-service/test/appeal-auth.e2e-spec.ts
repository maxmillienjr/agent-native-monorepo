import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { canonicalJson } from '@repo/agent-cassette';
import { ClaimResponseSchema } from '@repo/prior-auth';
import { FHIR_JSON } from '../src/configure-app.js';
import { bootService, type ServiceApp } from './service-app.js';

/**
 * The criterion P3-F left to P5-A: with authentication enforced, a valid
 * reconsideration from a key registered to principal `a`, sent with principal
 * `b`'s token, is 403, and the appeal stays filed. Model stub, memory
 * unconfigured. The keys are generated here; the synthetic labels are ADR
 * 0003's.
 */
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const BUNDLE = resolve(
  process.cwd(),
  '../../packages/eval-harness/datasets/prior-auth/bundles/pa-e0601-one-missing.bundle.json',
);

interface Reviewer {
  readonly entry: {
    reviewerKeyId: string;
    reviewerId: string;
    credential: { type: string; jurisdiction: string };
    publicKey: string;
    principal: string;
  };
  readonly privateKey: KeyObject;
}

function reviewer(n: number, principal: string): Reviewer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('no public key');
  return {
    entry: {
      reviewerKeyId: `synthetic-key-appeal-auth-00${n}`,
      reviewerId: `synthetic-reviewer-appeal-auth-00${n}`,
      credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
      publicKey: x,
      principal,
    },
    privateKey,
  };
}

describe('an appeal under service authentication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-appeal-auth-'));
  /** Denies, as principal `b`. */
  const denier = reviewer(1, 'b');
  /** Reconsiders, and is registered to principal `a`. */
  const reconsiderer = reviewer(2, 'a');
  const saved: Record<string, string | undefined> = {};
  let service: ServiceApp;

  beforeAll(async () => {
    const registry = join(dir, 'registry.json');
    writeFileSync(registry, JSON.stringify([denier.entry, reconsiderer.entry]));
    for (const name of ['REVIEWER_REGISTRY', 'REVIEW_SWEEP_MS']) saved[name] = process.env[name];
    process.env['REVIEWER_REGISTRY'] = registry;
    process.env['REVIEW_SWEEP_MS'] = '0';
    service = await bootService({
      SERVICE_CREDENTIALS: `a:${digest('token-a')},b:${digest('token-b')}`,
    });
  });

  afterAll(async () => {
    await service.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const http = () => request(service.app.getHttpServer());

  const attestation = (by: Reviewer) => ({
    reviewerId: by.entry.reviewerId,
    credential: by.entry.credential,
    attestedAt: '2026-10-05T09:00:00+00:00',
  });

  function signed(bytes: string, by: Reviewer): string {
    return sign(null, Buffer.from(bytes, 'utf8'), by.privateKey).toString('base64url');
  }

  it("answers 403 to a valid reconsideration from a's key sent with b's token, and 200 with a's", async () => {
    const submitted = await http()
      .post('/fhir/Claim/$submit')
      .set('Authorization', 'Bearer token-b')
      .set('Content-Type', FHIR_JSON)
      .send(readFileSync(BUNDLE, 'utf8'));
    expect(submitted.status).toBe(200);
    const caseId = String(
      ClaimResponseSchema.parse(submitted.body.entry[0].resource).identifier?.[0]?.value,
    );

    const determination = {
      kind: 'denial',
      specificReason: 'Synthetic: the sleep study is out of date.',
      attestation: attestation(denier),
    };
    const denied = await http()
      .post(`/review/cases/${caseId}/determination`)
      .set('Authorization', 'Bearer token-b')
      .send({
        determination,
        recommendationSeq: null,
        reviewerKeyId: denier.entry.reviewerKeyId,
        signature: signed(
          canonicalJson({ determination, recommendationSeq: null, runId: caseId }),
          denier,
        ),
      });
    expect(denied.status).toBe(200);

    const unauthenticated = await http().post('/review/appeals').send({});
    expect(unauthenticated.status).toBe(401);

    const filed = await http()
      .post('/review/appeals')
      .set('Authorization', 'Bearer token-b')
      .send({
        caseId,
        filer: { role: 'enrollee', name: 'Synthetic Enrollee' },
        channel: 'written',
        expedite: { requested: false, physicianSupport: false },
        statement: 'Synthetic: the enrollee asks the plan to look again.',
      });
    expect(filed.status).toBe(201);
    const appealId = String(filed.body.appealId);

    const reconsideration = {
      kind: 'reversal',
      explanation: 'Synthetic: the appeal evidence documents the criterion.',
      goodCauseFound: false,
      attestation: attestation(reconsiderer),
    };
    const body = {
      reconsideration,
      reviewerKeyId: reconsiderer.entry.reviewerKeyId,
      signature: signed(
        canonicalJson({
          action: 'reconsideration',
          appealId,
          body: reconsideration,
          runId: caseId,
        }),
        reconsiderer,
      ),
    };

    const asB = await http()
      .post(`/review/appeals/${appealId}/reconsideration`)
      .set('Authorization', 'Bearer token-b')
      .send(body);
    expect(asB.status).toBe(403);
    const view = await http()
      .get(`/review/appeals/${appealId}`)
      .set('Authorization', 'Bearer token-a');
    expect(view.body.status).toBe('filed');

    const asA = await http()
      .post(`/review/appeals/${appealId}/reconsideration`)
      .set('Authorization', 'Bearer token-a')
      .send(body);
    expect(asA.status).toBe(200);
  });
});
