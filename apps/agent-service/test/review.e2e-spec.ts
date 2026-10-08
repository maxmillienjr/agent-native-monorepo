import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { unlistedAttributeKeys } from '@repo/telemetry';
import type { CaseRepository, NewCase } from '@repo/memory-core';
import type { AgentDisposition } from '@repo/determination';
import { canonicalJson } from '@repo/agent-cassette';
import {
  AUTHORIZATION_NUMBER_EXTENSION,
  BundleSchema,
  ClaimResponseSchema,
  OperationOutcomeSchema,
  ParametersSchema,
} from '@repo/prior-auth';
import { AppModule } from '../src/app.module.js';
import { FHIR_JSON, configureApp } from '../src/configure-app.js';
import { PRIOR_AUTH_CLOCK } from '../src/fhir/prior-auth.service.js';
import { CASE_REPOSITORY } from '../src/memory/memory.tokens.js';
import { RunsService } from '../src/runs/runs.service.js';
import { ReviewSweep } from '../src/review/review.sweep.js';

/**
 * The clinician review surface over HTTP (P3-E), on model `stub` and on both
 * memory axes.
 *
 * Memory unconfigured always runs, under `yarn turbo test:service`. Memory
 * live runs when `DATABASE_URL` and `NEO4J_URI` are set, which is
 * `yarn turbo test:integration`: the integration job in `e2e.yml` exports
 * them and sets `REQUIRE_INTEGRATION_ENV`, under which a missing variable
 * fails this file instead of skipping the axis. The live axis never empties
 * the table; every assertion reads only the cases it created.
 */
const LIVE_VARIABLES = ['DATABASE_URL', 'NEO4J_URI'] as const;

function liveAxisAvailable(): boolean {
  const missing = LIVE_VARIABLES.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length === 0) return true;
  const required = (process.env['REQUIRE_INTEGRATION_ENV'] ?? '').trim().toLowerCase();
  if (required !== '' && required !== '0' && required !== 'false') {
    throw new Error(
      `review.e2e-spec.ts runs memory live because REQUIRE_INTEGRATION_ENV is set, but ` +
        `${missing.join(', ')} is missing or empty.`,
    );
  }
  return false;
}

type Axis = 'unconfigured' | 'live';
const AXES: Axis[] = liveAxisAvailable() ? ['unconfigured', 'live'] : ['unconfigured'];

const BUNDLES = resolve(
  process.cwd(),
  '..',
  '..',
  'packages',
  'eval-harness',
  'datasets',
  'prior-auth',
  'bundles',
);
const readBundle = (task: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(BUNDLES, `${task}.bundle.json`), 'utf8')) as Record<string, unknown>;

/**
 * A committed bundle with its member number replaced, so that a test's cases
 * are the only ones an inquiry for that member can match, on a live table
 * that holds every earlier run's cases too.
 */
function bundleForMember(task: string, member: string): Record<string, unknown> {
  const body = readBundle(task) as { entry: { resource: Record<string, unknown> }[] };
  const patient = body.entry.find((entry) => entry.resource['resourceType'] === 'Patient');
  const identifiers = patient?.resource['identifier'] as { value: string }[] | undefined;
  if (identifiers?.[0] === undefined) throw new Error(`${task} has no member identifier`);
  identifiers[0].value = member;
  return body;
}

/**
 * Every `$inquire` response this spec receives is written to
 * `FHIR_CAPTURE_DIR` when it is set, as `fhir.e2e-spec.ts` does for `$submit`,
 * so `fhir-validate.yml` validates them: the `Parameters` as a whole, and
 * each returned bundle on its own for the PAS report.
 */
const captureDir = process.env['FHIR_CAPTURE_DIR'];
function captureInquiry(name: string, body: { parameter?: { resource?: unknown }[] }): void {
  if (captureDir === undefined || captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(join(captureDir, `${name}.inquiry.json`), `${JSON.stringify(body, null, 2)}\n`);
  for (const [index, parameter] of (body.parameter ?? []).entries()) {
    writeFileSync(
      join(captureDir, `${name}.inquiry-return-${index + 1}.json`),
      `${JSON.stringify(parameter.resource, null, 2)}\n`,
    );
  }
}

/** Every span the spec's requests and sweeps open, for the sweep's events. */
const exporter = new InMemorySpanExporter();
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

const RECEIVED = new Date('2026-09-22T10:00:00Z');
const DECIDED = new Date('2026-09-23T15:00:00Z');
const SENTINEL = 'SENTINEL-REVIEW-RATIONALE-5b1d';

/**
 * Reviewer keys, generated in the test: no private key exists anywhere else.
 * Every reviewer, credential and key id is labelled synthetic (ADR 0003).
 */
interface Reviewer {
  readonly reviewerKeyId: string;
  readonly reviewerId: string;
  readonly credential: { readonly type: string; readonly jurisdiction: string };
  readonly privateKey: KeyObject;
  readonly publicKey: string;
  readonly revokedAt?: string;
}

function reviewer(
  reviewerKeyId: string,
  reviewerId: string,
  type: string,
  revokedAt?: string,
): Reviewer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('no public key');
  return {
    reviewerKeyId,
    reviewerId,
    credential: { type, jurisdiction: 'synthetic-jurisdiction' },
    privateKey,
    publicKey: x,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

const PHYSICIAN = reviewer(
  'synthetic-key-physician-001',
  'synthetic-reviewer-001',
  'synthetic-physician',
);
const PHARMACIST = reviewer(
  'synthetic-key-pharmacist-001',
  'synthetic-reviewer-002',
  'synthetic-pharmacist',
);
const REVOKED = reviewer(
  'synthetic-key-revoked-001',
  'synthetic-reviewer-003',
  'synthetic-physician',
  '2026-01-01T00:00:00Z',
);
const UNREGISTERED = reviewer(
  'synthetic-key-unregistered',
  'synthetic-reviewer-004',
  'synthetic-physician',
);

function writeRegistry(reviewers: readonly Reviewer[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'synthetic-review-registry-')), 'registry.json');
  writeFileSync(
    path,
    JSON.stringify(
      reviewers.map(({ privateKey: _private, ...entry }) => entry),
      null,
      2,
    ),
  );
  return path;
}
const REGISTRY = writeRegistry([PHYSICIAN, PHARMACIST, REVOKED]);

const attestation = (by: Reviewer) => ({
  reviewerId: by.reviewerId,
  credential: by.credential,
  attestedAt: '2026-09-23T15:00:00+00:00',
});
const denialBy = (by: Reviewer, specificReason = 'Synthetic: the sleep study is out of date.') => ({
  kind: 'denial',
  specificReason,
  attestation: attestation(by),
});
const approvalBy = (by: Reviewer) => ({ kind: 'clinician-approval', attestation: attestation(by) });

/** The body a reviewer's client sends: the determination, signed over the case's bytes. */
function signedBody(
  caseId: string,
  determination: object,
  by: Reviewer,
  options: { signFor?: string; recommendationSeq?: number | null } = {},
) {
  const recommendationSeq = options.recommendationSeq ?? null;
  const bytes = canonicalJson({
    determination,
    recommendationSeq,
    runId: options.signFor ?? caseId,
  });
  return {
    determination,
    recommendationSeq,
    reviewerKeyId: by.reviewerKeyId,
    signature: sign(null, Buffer.from(bytes, 'utf8'), by.privateKey).toString('base64url'),
  };
}

describe.each(AXES)('clinician review surface (e2e), memory %s', (axis) => {
  let app: NestExpressApplication;
  let fixture: TestingModule;
  let cases: CaseRepository;
  let now = RECEIVED;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const cleared = ['GOOGLE_API_KEY', ...(axis === 'unconfigured' ? LIVE_VARIABLES : [])];
    for (const name of [...cleared, 'REVIEWER_REGISTRY', 'REVIEW_SWEEP_MS']) {
      saved[name] = process.env[name];
    }
    for (const name of cleared) delete process.env[name];
    process.env['REVIEWER_REGISTRY'] = REGISTRY;
    // The spec runs each sweep itself, at a clock it sets.
    process.env['REVIEW_SWEEP_MS'] = '0';

    fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRIOR_AUTH_CLOCK)
      .useValue({ now: () => now })
      .compile();
    app = fixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    cases = fixture.get<CaseRepository>(CASE_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    now = RECEIVED;
    fixture.get(RunsService).setModelDecorator((deps) => deps);
  });

  const http = () => request(app.getHttpServer());
  const submit = (task: string) =>
    http()
      .post('/fhir/Claim/$submit')
      .set('Content-Type', FHIR_JSON)
      .send(JSON.stringify(readBundle(task)));
  const caseIdOf = (body: { entry: { resource: unknown }[] }): string =>
    String(ClaimResponseSchema.parse(body.entry[0]?.resource).identifier?.[0]?.value);

  /** Every criterion met, citing the first evidence item: the request is approved. */
  const approveEverything = () =>
    fixture.get(RunsService).setModelDecorator((live) => ({
      ...live,
      assess: {
        assessCriteria: async (criteria, evidence) =>
          criteria.map((criterion) => ({
            criterionId: criterion.id,
            status: 'met' as const,
            evidence: evidence.slice(0, 1).map((item) => item.reference),
            rationale: `${SENTINEL}: ${criterion.title}`,
          })),
      },
    }));

  /** Every criterion insufficient, each rationale carrying the sentinel: the request pends. */
  const referWithSentinel = () =>
    fixture.get(RunsService).setModelDecorator((live) => ({
      ...live,
      assess: {
        assessCriteria: async (criteria, evidence) =>
          criteria.map((criterion) => ({
            criterionId: criterion.id,
            status: 'insufficient' as const,
            evidence: evidence.slice(0, 1).map((item) => item.reference),
            rationale: `${SENTINEL}: ${criterion.title}`,
          })),
      },
    }));

  describe('$submit enqueues', () => {
    it('leaves a pended case for a queued response and an approved-automated one for a complete one', async () => {
      const referred = await submit('pa-e0470-one-missing');
      expect(referred.status).toBe(HttpStatus.OK);
      const pendedId = caseIdOf(referred.body);

      approveEverything();
      const approved = await submit('pa-e0470-all-met-structured');
      expect(approved.status).toBe(HttpStatus.OK);
      expect(ClaimResponseSchema.parse(approved.body.entry[0].resource).outcome).toBe('complete');
      const approvedId = caseIdOf(approved.body);

      const pendedView = await http().get(`/review/cases/${pendedId}`);
      expect(pendedView.status).toBe(HttpStatus.OK);
      expect(pendedView.body.status).toBe('pended');
      expect(pendedView.body.response).toEqual(referred.body);

      const approvedView = await http().get(`/review/cases/${approvedId}`);
      expect(approvedView.body.status).toBe('approved-automated');
      expect(approvedView.body.response).toEqual(approved.body);

      const queue = await http().get('/review/cases?limit=1000');
      const queued = (queue.body.cases as { caseId: string }[]).map((item) => item.caseId);
      expect(queued).toContain(pendedId);
      expect(queued).not.toContain(approvedId);
    });
  });

  describe('the queue', () => {
    /**
     * Pairs of cases with identical clocks, one all met and one all not met.
     * In world 1 the first of each pair is the met one; in world 2 it is the
     * not-met one. If the queue read findings, the two worlds would order
     * differently. Clocks are in 2025, ahead of every other case here.
     */
    function world(prefix: string, firstMet: boolean): NewCase[] {
      const clocks = [
        ['2025-01-02T09:00:00Z', '2025-01-09T09:00:00Z', 'standard'],
        ['2025-01-03T09:00:00Z', '2025-01-06T09:00:00Z', 'expedited'],
        ['2025-01-01T09:00:00Z', '2025-01-08T09:00:00Z', 'standard'],
        ['2025-01-01T09:00:00Z', '2025-01-08T09:00:00Z', 'standard'],
      ] as const;
      const findings = (status: 'met' | 'not-met'): AgentDisposition => ({
        kind: 'refer-to-clinician',
        findings: ['synthetic-c1', 'synthetic-c2'].map((criterionId) => ({
          criterionId,
          status,
          evidence: ['Condition/synthetic'],
          rationale: `Synthetic fixture: ${status}.`,
        })),
      });
      return clocks.flatMap(([received, due, priority], index) =>
        [0, 1].map((member) => ({
          caseId: `${prefix}-0000-4000-8000-${String(index * 2 + member).padStart(12, '0')}`,
          status: 'pended' as const,
          priority,
          receivedAt: new Date(received),
          decisionDueBy: new Date(due),
          memberId: `https://example.org/fhir/sid/member-id|SYN-QUEUE-${prefix}`,
          insurerId: 'https://example.org/fhir/sid/payer-id|QHP-SYN-001',
          providerId: 'https://example.org/fhir/sid/supplier-id|SUP-01',
          hcpcs: 'E0601',
          request: { resourceType: 'Bundle', type: 'collection' },
          disposition: findings((member === 0) === firstMet ? 'met' : 'not-met'),
          response: { resourceType: 'Bundle', id: 'synthetic' },
          recommendationSeq: null,
        })),
      );
    }

    it('orders two worlds with identical clocks and opposite findings identically', async () => {
      const run = randomUUID().slice(0, 4);
      const one = world(`1${run}aaa`, true);
      const two = world(`2${run}aaa`, false);
      for (const row of [...one, ...two]) await cases.enqueue(row);

      const response = await http().get('/review/cases?limit=1000');
      expect(response.status).toBe(HttpStatus.OK);
      const order = (response.body.cases as { caseId: string }[]).map((item) => item.caseId);
      const positions = (rows: NewCase[]) =>
        order.filter((id) => rows.some((row) => row.caseId === id)).map((id) => id.slice(-12));

      expect(positions(one)).toEqual(positions(two));
      // Deadline, then receipt, then case id: the expedited pair, then the two
      // pairs due 2025-01-08 (tied, so by id), then the pair due 2025-01-09.
      expect(positions(one)).toEqual([
        '000000000002',
        '000000000003',
        '000000000004',
        '000000000005',
        '000000000006',
        '000000000007',
        '000000000000',
        '000000000001',
      ]);
    });

    it('shows a case as overdue from its deadline, before any sweep has run', async () => {
      const referred = await submit('pa-e0601-ambiguous');
      const caseId = caseIdOf(referred.body);
      const item = async () =>
        (
          (await http().get('/review/cases?limit=1000')).body.cases as {
            caseId: string;
            overdue: boolean;
            overdueFlaggedAt: string | null;
          }[]
        ).find((candidate) => candidate.caseId === caseId);

      now = new Date('2026-09-25T09:59:59Z');
      expect((await item())?.overdue).toBe(false);
      now = new Date('2026-09-25T10:00:00Z');
      expect(await item()).toMatchObject({ overdue: true, overdueFlaggedAt: null });
    });

    it('carries no finding and no rationale in a queue item', async () => {
      referWithSentinel();
      const referred = await submit('pa-k0823-ambiguous');
      expect(referred.status).toBe(HttpStatus.OK);
      const queue = await http().get('/review/cases?limit=1000');
      expect(queue.text).not.toContain(SENTINEL);
    });
  });

  describe('one case', () => {
    it('serves the findings with their evidence and rationale, and what to sign', async () => {
      referWithSentinel();
      const referred = await submit('pa-k0823-ambiguous');
      const caseId = caseIdOf(referred.body);

      const view = await http().get(`/review/cases/${caseId}`);
      expect(view.status).toBe(HttpStatus.OK);
      expect(view.text).toContain(SENTINEL);
      expect(view.body.findings.length).toBeGreaterThan(0);
      expect(view.body.findings[0]).toMatchObject({ status: 'insufficient' });
      expect(view.body.findings[0].evidence.length).toBe(1);
      expect(view.body.policy.reviewerCredentials).toContain('synthetic-physician');
      expect(view.body.signing).toEqual({
        algorithm: 'Ed25519',
        encoding: 'base64url',
        payload: 'canonicalJson({ determination, recommendationSeq, runId })',
        runId: caseId,
        recommendationSeq: null,
      });
      expect(view.body.decision).toBeNull();
      expect(view.body).not.toHaveProperty('recommendation');
    });

    it('answers 404 for an unknown case and for one that is not a case id', async () => {
      expect((await http().get(`/review/cases/${randomUUID()}`)).status).toBe(HttpStatus.NOT_FOUND);
      expect((await http().get('/review/cases/not-a-case')).status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('the determination', () => {
    const decide = (caseId: string, body: unknown) =>
      http()
        .post(`/review/cases/${caseId}/determination`)
        .send(body as object);
    const pended = async (task = 'pa-e0601-one-missing') => caseIdOf((await submit(task)).body);

    it('issues a denial signed by a registered key whose credential the policy lists', async () => {
      const caseId = await pended();
      now = DECIDED;
      const body = signedBody(caseId, denialBy(PHYSICIAN), PHYSICIAN);

      const response = await decide(caseId, body);
      expect(response.status).toBe(HttpStatus.OK);
      const bundle = BundleSchema.parse(response.body);
      const claimResponse = ClaimResponseSchema.parse(bundle.entry?.[0]?.resource);
      expect(claimResponse.outcome).toBe('complete');
      expect(claimResponse.preAuthRef).toBeUndefined();
      expect(claimResponse.processNote?.[0]?.text).toBe(
        'Synthetic: the sleep study is out of date.',
      );

      const row = await cases.get(caseId);
      expect(row?.status).toBe('decided');
      expect(row?.reviewerId).toBe('synthetic-reviewer-001');
      expect(row?.reviewerKeyId).toBe('synthetic-key-physician-001');
      expect(row?.signature).toBe(body.signature);
      expect(row?.decidedAt?.toISOString()).toBe(DECIDED.toISOString());
      expect(row?.determination).toEqual(denialBy(PHYSICIAN));

      const queue = await http().get('/review/cases?limit=1000');
      expect((queue.body.cases as { caseId: string }[]).map((c) => c.caseId)).not.toContain(caseId);
    });

    it('issues a clinician approval with a preAuthRef', async () => {
      const caseId = await pended('pa-k0823-one-missing');
      now = DECIDED;
      const response = await decide(caseId, signedBody(caseId, approvalBy(PHYSICIAN), PHYSICIAN));
      expect(response.status).toBe(HttpStatus.OK);
      const claimResponse = ClaimResponseSchema.parse(response.body.entry[0].resource);
      expect(claimResponse.outcome).toBe('complete');
      expect(claimResponse.preAuthRef).toBe(caseId);
      // K0823's policy approves for 180 days from the service date.
      expect(claimResponse.preAuthPeriod).toEqual({ start: '2026-09-30', end: '2027-03-28' });
    });

    it('refuses each malformed, unverified or unqualified determination and leaves the case pended', async () => {
      const caseId = await pended();
      const other = await pended('pa-e0470-one-missing');
      const unknown = randomUUID();
      const { signature: _dropped, ...unsigned } = signedBody(
        caseId,
        denialBy(PHYSICIAN),
        PHYSICIAN,
      );
      const wrongReviewer = {
        ...denialBy(PHYSICIAN),
        attestation: { ...attestation(PHYSICIAN), reviewerId: 'synthetic-reviewer-002' },
      };
      const partial = { ...denialBy(PHYSICIAN), kind: 'partial-approval' };

      const attempts: [string, string, unknown, number][] = [
        ['no signature', caseId, unsigned, 400],
        [
          'a key not in the registry',
          caseId,
          signedBody(caseId, denialBy(UNREGISTERED), UNREGISTERED),
          401,
        ],
        ['a revoked key', caseId, signedBody(caseId, denialBy(REVOKED), REVOKED), 401],
        [
          'a signature over another case id',
          caseId,
          signedBody(caseId, denialBy(PHYSICIAN), PHYSICIAN, { signFor: other }),
          401,
        ],
        [
          "an attestation that is not the key's reviewer",
          caseId,
          signedBody(caseId, wrongReviewer, PHYSICIAN),
          401,
        ],
        [
          'a credential the policy does not list',
          caseId,
          signedBody(caseId, denialBy(PHARMACIST), PHARMACIST),
          403,
        ],
        ['a partial approval', caseId, signedBody(caseId, partial, PHYSICIAN), 422],
        [
          'an empty specificReason',
          caseId,
          signedBody(caseId, denialBy(PHYSICIAN, '  '), PHYSICIAN),
          400,
        ],
        ['an unknown case id', unknown, signedBody(unknown, denialBy(PHYSICIAN), PHYSICIAN), 404],
      ];
      for (const [label, target, body, status] of attempts) {
        const response = await decide(target, body);
        expect({ label, status: response.status }).toEqual({ label, status });
      }

      for (const id of [caseId, other]) {
        const view = await http().get(`/review/cases/${id}`);
        expect(view.body.status).toBe('pended');
        expect(view.body.decision).toBeNull();
      }
    });

    it('answers a byte-identical resubmission with the stored body, and another determination with 409', async () => {
      const caseId = await pended('pa-e0260-one-missing');
      now = DECIDED;
      const body = signedBody(caseId, denialBy(PHYSICIAN), PHYSICIAN);
      const first = await decide(caseId, body);
      expect(first.status).toBe(HttpStatus.OK);

      now = new Date('2026-09-24T09:00:00Z');
      const retry = await decide(caseId, body);
      expect(retry.status).toBe(HttpStatus.OK);
      expect(retry.text).toBe(first.text);

      const different = await decide(caseId, signedBody(caseId, approvalBy(PHYSICIAN), PHYSICIAN));
      expect(different.status).toBe(HttpStatus.CONFLICT);
      expect((await cases.get(caseId))?.signature).toBe(body.signature);
    });

    it('answers 409 to a determination on an automated approval', async () => {
      approveEverything();
      const caseId = caseIdOf((await submit('pa-e0470-all-met-structured')).body);
      const response = await decide(caseId, signedBody(caseId, approvalBy(PHYSICIAN), PHYSICIAN));
      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect((await cases.get(caseId))?.status).toBe('approved-automated');
    });
  });

  describe('Claim/$inquire', () => {
    const inquire = (body: unknown) =>
      http()
        .post('/fhir/Claim/$inquire')
        .set('Content-Type', FHIR_JSON)
        .send(typeof body === 'string' ? body : JSON.stringify(body));
    const outcomes = (body: { parameter?: { name: string; resource: unknown }[] }) =>
      (body.parameter ?? []).map((parameter) => {
        expect(parameter.name).toBe('return');
        const bundle = BundleSchema.parse(parameter.resource);
        expect(bundle.entry?.[0]?.resource?.resourceType).toBe('ClaimResponse');
        const claimResponse = ClaimResponseSchema.parse(bundle.entry?.[0]?.resource);
        return [String(claimResponse.identifier?.[0]?.value), claimResponse.outcome];
      });

    it('returns each matching case, queued until it is decided and complete after', async () => {
      const member = `SYN-INQ-${randomUUID().slice(0, 8)}`;
      const body = bundleForMember('pa-e0601-one-missing', member);
      const first = caseIdOf(
        (await http().post('/fhir/Claim/$submit').set('Content-Type', FHIR_JSON).send(body)).body,
      );
      // A minute later, so the two are returned in order of receipt.
      now = new Date(RECEIVED.getTime() + 60_000);
      const second = caseIdOf(
        (await http().post('/fhir/Claim/$submit').set('Content-Type', FHIR_JSON).send(body)).body,
      );

      const before = await inquire(body);
      expect(before.status).toBe(HttpStatus.OK);
      expect(before.headers['content-type']).toContain(FHIR_JSON);
      ParametersSchema.parse(before.body);
      captureInquiry(`${axis}-pended`, before.body);
      expect(outcomes(before.body)).toEqual([
        [first, 'queued'],
        [second, 'queued'],
      ]);

      now = DECIDED;
      const decided = await http()
        .post(`/review/cases/${first}/determination`)
        .send(signedBody(first, approvalBy(PHYSICIAN), PHYSICIAN));
      expect(decided.status).toBe(HttpStatus.OK);

      const after = await inquire(body);
      captureInquiry(`${axis}-decided`, after.body);
      expect(outcomes(after.body)).toEqual([
        [first, 'complete'],
        [second, 'queued'],
      ]);

      // An authorization number narrows the match to the case it was issued for.
      const byNumber = bundleForMember('pa-e0601-one-missing', member) as {
        entry: { resource: { item: Record<string, unknown>[] } }[];
      };
      const item = byNumber.entry[0]?.resource.item[0];
      if (item === undefined) throw new Error('no item');
      item['extension'] = [{ url: AUTHORIZATION_NUMBER_EXTENSION, valueString: first }];
      expect(outcomes((await inquire(byNumber)).body)).toEqual([[first, 'complete']]);
    });

    it('ignores the inquiry Claim.identifier, and returns no return parameter for no match', async () => {
      const member = `SYN-INQ-${randomUUID().slice(0, 8)}`;
      const body = bundleForMember('pa-e0470-one-missing', member) as {
        entry: { resource: Record<string, unknown> }[];
      };
      const caseId = caseIdOf(
        (await http().post('/fhir/Claim/$submit').set('Content-Type', FHIR_JSON).send(body)).body,
      );

      const asSubmitted = await inquire(body);
      const claim = body.entry[0]?.resource;
      if (claim === undefined) throw new Error('no claim');
      claim['identifier'] = [{ system: 'https://example.org/fhir/sid/inquiry', value: 'INQ-1' }];
      const reidentified = await inquire(body);
      expect(outcomes(reidentified.body)).toEqual(outcomes(asSubmitted.body));
      expect(outcomes(reidentified.body)).toEqual([[caseId, 'queued']]);

      const nobody = await inquire(bundleForMember('pa-e0470-one-missing', `${member}-absent`));
      expect(nobody.status).toBe(HttpStatus.OK);
      expect(nobody.body).toEqual({
        resourceType: 'Parameters',
        meta: { security: [expect.objectContaining({ code: 'HTEST' })] },
      });
      captureInquiry(`${axis}-no-match`, nobody.body);
    });

    it('answers a body that is not a Bundle with 400, and one with nothing to match on with 422', async () => {
      const notABundle = await inquire({ resourceType: 'Patient', id: 'synthetic' });
      expect(notABundle.status).toBe(HttpStatus.BAD_REQUEST);
      expect(OperationOutcomeSchema.safeParse(notABundle.body).success).toBe(true);

      const anonymous = readBundle('pa-e0470-one-missing') as {
        entry: { resource: Record<string, unknown> }[];
      };
      for (const entry of anonymous.entry) delete entry.resource['identifier'];
      const unmatched = await inquire(anonymous);
      expect(unmatched.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(OperationOutcomeSchema.safeParse(unmatched.body).success).toBe(true);
    });
  });

  describe('the sentinel', () => {
    it('shows the rationale to the reviewer, and never in a determination or an inquiry', async () => {
      referWithSentinel();
      const member = `SYN-SEN-${randomUUID().slice(0, 8)}`;
      const body = bundleForMember('pa-k0823-ambiguous', member);
      const submitted = await http()
        .post('/fhir/Claim/$submit')
        .set('Content-Type', FHIR_JSON)
        .send(body);
      const caseId = caseIdOf(submitted.body);
      expect(submitted.text).not.toContain(SENTINEL);

      const view = await http().get(`/review/cases/${caseId}`);
      expect(view.text).toContain(SENTINEL);

      const pendedInquiry = await http()
        .post('/fhir/Claim/$inquire')
        .set('Content-Type', FHIR_JSON)
        .send(body);
      expect(pendedInquiry.body.parameter).toHaveLength(1);
      expect(pendedInquiry.text).not.toContain(SENTINEL);

      now = DECIDED;
      const decided = await http()
        .post(`/review/cases/${caseId}/determination`)
        .send(signedBody(caseId, denialBy(PHYSICIAN), PHYSICIAN));
      expect(decided.status).toBe(HttpStatus.OK);
      expect(decided.text).not.toContain(SENTINEL);

      const decidedInquiry = await http()
        .post('/fhir/Claim/$inquire')
        .set('Content-Type', FHIR_JSON)
        .send(body);
      expect(decidedInquiry.body.parameter).toHaveLength(1);
      expect(decidedInquiry.text).not.toContain(SENTINEL);
      captureInquiry(`${axis}-denied`, decidedInquiry.body);
    });
  });

  describe('the overdue sweep', () => {
    it('flags an overdue case once, with one event, and leaves it pended and queued', async () => {
      const member = `SYN-SWP-${randomUUID().slice(0, 8)}`;
      const body = bundleForMember('pa-e0601-one-missing', member);
      const submitted = await http()
        .post('/fhir/Claim/$submit')
        .set('Content-Type', FHIR_JSON)
        .send(body);
      const caseId = caseIdOf(submitted.body);
      const due = new Date('2026-09-29T10:00:00Z');
      expect((await cases.get(caseId))?.decisionDueBy.toISOString()).toBe(due.toISOString());

      const sweep = fixture.get(ReviewSweep);
      exporter.reset();
      now = new Date(due.getTime() - 1000);
      await sweep.sweep();
      now = new Date(due.getTime() + 60_000);
      await sweep.sweep();
      now = new Date(due.getTime() + 2 * 60 * 60_000);
      await sweep.sweep();

      const sweeps = exporter
        .getFinishedSpans()
        .filter((span) => span.name === 'review.overdue_sweep');
      expect(sweeps).toHaveLength(3);
      expect(unlistedAttributeKeys(sweeps)).toEqual([]);
      const events = sweeps
        .flatMap((span) => span.events)
        .filter((event) => event.attributes?.['prior_auth.case_id'] === caseId);
      expect(events).toHaveLength(1);
      expect(events[0]?.name).toBe('review.case.overdue');
      expect(events[0]?.attributes).toEqual({
        'prior_auth.case_id': caseId,
        'prior_auth.priority': 'standard',
        'prior_auth.minutes_past_due': 1,
      });

      const row = await cases.get(caseId);
      expect(row?.status).toBe('pended');
      expect(row?.overdueFlaggedAt?.toISOString()).toBe('2026-09-29T10:01:00.000Z');

      const inquiry = await http()
        .post('/fhir/Claim/$inquire')
        .set('Content-Type', FHIR_JSON)
        .send(body);
      const returned = BundleSchema.parse(inquiry.body.parameter[0].resource);
      expect(ClaimResponseSchema.parse(returned.entry?.[0]?.resource).outcome).toBe('queued');

      const queue = await http().get('/review/cases?limit=1000');
      expect(
        (queue.body.cases as { caseId: string }[]).find((item) => item.caseId === caseId),
      ).toMatchObject({ overdue: true, overdueFlaggedAt: '2026-09-29T10:01:00.000Z' });
    });
  });
});

describe('the reviewer registry (e2e), memory unconfigured', () => {
  const saved: Record<string, string | undefined> = {};
  const variables = ['GOOGLE_API_KEY', ...LIVE_VARIABLES, 'REVIEWER_REGISTRY'];

  beforeAll(() => {
    for (const name of variables) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('unset: the determination route answers 503 and the queue still serves', async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = fixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    try {
      const submitted = await request(app.getHttpServer())
        .post('/fhir/Claim/$submit')
        .set('Content-Type', FHIR_JSON)
        .send(JSON.stringify(readBundle('pa-e0601-one-missing')));
      const caseId = String(
        ClaimResponseSchema.parse(submitted.body.entry[0].resource).identifier?.[0]?.value,
      );

      const decided = await request(app.getHttpServer())
        .post(`/review/cases/${caseId}/determination`)
        .send(signedBody(caseId, denialBy(PHYSICIAN), PHYSICIAN));
      expect(decided.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(decided.text).toContain('REVIEWER_REGISTRY');

      const queue = await request(app.getHttpServer()).get('/review/cases');
      expect(queue.status).toBe(HttpStatus.OK);
      expect((queue.body.cases as { caseId: string }[]).map((c) => c.caseId)).toContain(caseId);
    } finally {
      await app.close();
    }
  });

  it('malformed: the application does not start, and the error names REVIEWER_REGISTRY', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'synthetic-review-registry-')), 'bad.json');
    writeFileSync(path, JSON.stringify([{ reviewerKeyId: 'synthetic-key', publicKey: 'short' }]));
    process.env['REVIEWER_REGISTRY'] = path;
    try {
      await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
        /^REVIEWER_REGISTRY names .* which is not a reviewer registry/,
      );
    } finally {
      delete process.env['REVIEWER_REGISTRY'];
    }
  });
});
