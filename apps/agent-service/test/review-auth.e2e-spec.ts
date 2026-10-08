import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { canonicalJson } from '@repo/agent-cassette';
import { ClaimResponseSchema } from '@repo/prior-auth';
import { FHIR_JSON } from '../src/configure-app.js';
import { bootService, type ServiceApp } from './service-app.js';

/**
 * The criterion P3-E left to P5-A: with authentication enforced, a valid
 * signature from a key registered to principal `a`, sent with principal `b`'s
 * token, is 403, and the case stays pended. Model stub, memory unconfigured.
 * The reviewer key is generated here; the synthetic labels are ADR 0003's.
 */
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const BUNDLE = resolve(
  process.cwd(),
  '../../packages/eval-harness/datasets/prior-auth/bundles/pa-e0470-one-missing.bundle.json',
);

describe('a determination under service authentication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-review-auth-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const reviewer = {
    reviewerKeyId: 'synthetic-key-auth-001',
    reviewerId: 'synthetic-reviewer-auth-001',
    credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
    publicKey: publicKey.export({ format: 'jwk' }).x,
    principal: 'a',
  };
  const saved: Record<string, string | undefined> = {};
  let service: ServiceApp;

  beforeAll(async () => {
    const registry = join(dir, 'registry.json');
    writeFileSync(registry, JSON.stringify([reviewer]));
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

  function approval(caseId: string) {
    const determination = {
      kind: 'clinician-approval',
      attestation: {
        reviewerId: reviewer.reviewerId,
        credential: reviewer.credential,
        attestedAt: '2026-09-23T15:00:00+00:00',
      },
    };
    const bytes = canonicalJson({ determination, recommendationSeq: null, runId: caseId });
    return {
      determination,
      recommendationSeq: null,
      reviewerKeyId: reviewer.reviewerKeyId,
      signature: sign(null, Buffer.from(bytes, 'utf8'), privateKey).toString('base64url'),
    };
  }

  it("answers 403 to a valid signature from a's key sent with b's token, and 200 with a's", async () => {
    const submitted = await http()
      .post('/fhir/Claim/$submit')
      .set('Authorization', 'Bearer token-a')
      .set('Content-Type', FHIR_JSON)
      .send(readFileSync(BUNDLE, 'utf8'));
    expect(submitted.status).toBe(200);
    const caseId = String(
      ClaimResponseSchema.parse(submitted.body.entry[0].resource).identifier?.[0]?.value,
    );

    const asB = await http()
      .post(`/review/cases/${caseId}/determination`)
      .set('Authorization', 'Bearer token-b')
      .send(approval(caseId));
    expect(asB.status).toBe(403);

    const view = await http().get(`/review/cases/${caseId}`).set('Authorization', 'Bearer token-a');
    expect(view.body.status).toBe('pended');

    const asA = await http()
      .post(`/review/cases/${caseId}/determination`)
      .set('Authorization', 'Bearer token-a')
      .send(approval(caseId));
    expect(asA.status).toBe(200);
  });
});
