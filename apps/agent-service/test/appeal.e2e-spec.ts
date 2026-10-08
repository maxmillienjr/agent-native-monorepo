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
import type { AppealRepository, CaseRepository, NewCase } from '@repo/memory-core';
import type { AgentDisposition } from '@repo/determination';
import { canonicalJson } from '@repo/agent-cassette';
import { BundleSchema, CapabilityStatementSchema, ClaimResponseSchema } from '@repo/prior-auth';
import { AppModule } from '../src/app.module.js';
import { FHIR_JSON, configureApp } from '../src/configure-app.js';
import { PRIOR_AUTH_CLOCK } from '../src/fhir/prior-auth.service.js';
import { APPEAL_REPOSITORY, CASE_REPOSITORY } from '../src/memory/memory.tokens.js';
import { RunsService } from '../src/runs/runs.service.js';
import { ReviewSweep } from '../src/review/review.sweep.js';

/**
 * Appeals over HTTP (P3-F): Medicare Advantage reconsiderations, on model
 * `stub` and on both memory axes, with no ledger and no authentication.
 *
 * Memory unconfigured always runs, under `yarn turbo test:service`. Memory
 * live runs when `DATABASE_URL` and `NEO4J_URI` are set, which is
 * `yarn turbo test:integration`, as `review.e2e-spec.ts` does; under
 * `REQUIRE_INTEGRATION_ENV` a missing variable fails this file instead of
 * skipping the axis. The live axis never empties a table; every assertion
 * reads only the cases and appeals it created.
 *
 * Every reviewer, filer, credential and key id is labelled synthetic (ADR 0003).
 */
const LIVE_VARIABLES = ['DATABASE_URL', 'NEO4J_URI'] as const;

function liveAxisAvailable(): boolean {
  const missing = LIVE_VARIABLES.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length === 0) return true;
  const required = (process.env['REQUIRE_INTEGRATION_ENV'] ?? '').trim().toLowerCase();
  if (required !== '' && required !== '0' && required !== 'false') {
    throw new Error(
      `appeal.e2e-spec.ts runs memory live because REQUIRE_INTEGRATION_ENV is set, but ` +
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

/** A committed bundle with its member number replaced, so an inquiry matches only this test's case. */
function bundleForMember(task: string, member: string): Record<string, unknown> {
  const body = readBundle(task) as { entry: { resource: Record<string, unknown> }[] };
  const patient = body.entry.find((entry) => entry.resource['resourceType'] === 'Patient');
  const identifiers = patient?.resource['identifier'] as { value: string }[] | undefined;
  if (identifiers?.[0] === undefined) throw new Error(`${task} has no member identifier`);
  identifiers[0].value = member;
  return body;
}

/**
 * The reversal's response and the `$inquire` that returns it are written to
 * `FHIR_CAPTURE_DIR` when it is set, so `fhir-validate.yml` validates them
 * against base R4 and US Core 6.1.0 with the rest.
 */
const captureDir = process.env['FHIR_CAPTURE_DIR'];
function capture(name: string, body: unknown): void {
  if (captureDir === undefined || captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(join(captureDir, name), `${JSON.stringify(body, null, 2)}\n`);
}
function captureInquiry(name: string, body: { parameter?: { resource?: unknown }[] }): void {
  capture(`${name}.inquiry.json`, body);
  for (const [index, parameter] of (body.parameter ?? []).entries()) {
    capture(`${name}.inquiry-return-${index + 1}.json`, parameter.resource);
  }
}

const exporter = new InMemorySpanExporter();
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

const RECEIVED = new Date('2026-09-22T10:00:00Z');
const DECIDED = new Date('2026-09-23T15:00:00Z');
const FILED = new Date('2026-10-01T10:00:00Z');
const RECONSIDERED = new Date('2026-10-05T09:00:00Z');
const SENTINEL = 'SENTINEL-APPEAL-RATIONALE-9c2e';

interface Reviewer {
  readonly reviewerKeyId: string;
  readonly reviewerId: string;
  readonly credential: { readonly type: string; readonly jurisdiction: string };
  readonly privateKey: KeyObject;
  readonly publicKey: string;
}

function reviewer(reviewerKeyId: string, reviewerId: string, type: string): Reviewer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('no public key');
  return {
    reviewerKeyId,
    reviewerId,
    credential: { type, jurisdiction: 'synthetic-jurisdiction' },
    privateKey,
    publicKey: x,
  };
}

/** Makes every initial denial here. */
const DENIER = reviewer(
  'synthetic-key-denier-001',
  'synthetic-reviewer-001',
  'synthetic-physician',
);
/** The same person as DENIER under a second key and credential: one person to § 422.590(h)(1). */
const DENIER_SECOND_KEY = reviewer(
  'synthetic-key-denier-002',
  'synthetic-reviewer-001',
  'synthetic-sleep-medicine-physician',
);
/** A physician who took no part in the denial. */
const RECONSIDERER = reviewer(
  'synthetic-key-reconsider-001',
  'synthetic-reviewer-002',
  'synthetic-physician',
);
/** Not a physician: may dismiss, may not reconsider. */
const PHARMACIST = reviewer(
  'synthetic-key-pharmacist-001',
  'synthetic-reviewer-003',
  'synthetic-pharmacist',
);

const REGISTRY = (() => {
  const path = join(mkdtempSync(join(tmpdir(), 'synthetic-appeal-registry-')), 'registry.json');
  writeFileSync(
    path,
    JSON.stringify(
      [DENIER, DENIER_SECOND_KEY, RECONSIDERER, PHARMACIST].map(
        ({ privateKey: _private, ...entry }) => entry,
      ),
      null,
      2,
    ),
  );
  return path;
})();

const attestation = (by: Reviewer, at = '2026-10-05T09:00:00+00:00') => ({
  reviewerId: by.reviewerId,
  credential: by.credential,
  attestedAt: at,
});

/** P3-E's body for a determination, signed over the case's bytes. */
function signedDenial(caseId: string, by: Reviewer = DENIER) {
  const determination = {
    kind: 'denial',
    specificReason: 'Synthetic: the sleep study is out of date.',
    attestation: attestation(by, '2026-09-23T15:00:00+00:00'),
  };
  const bytes = canonicalJson({ determination, recommendationSeq: null, runId: caseId });
  return {
    determination,
    recommendationSeq: null,
    reviewerKeyId: by.reviewerKeyId,
    signature: sign(null, Buffer.from(bytes, 'utf8'), by.privateKey).toString('base64url'),
  };
}

const reconsiderationBy = (
  by: Reviewer,
  kind: 'reversal' | 'affirmation',
  goodCauseFound = false,
) => ({
  kind,
  explanation: `Synthetic: ${kind} on reconsideration; the appeal evidence was read.`,
  goodCauseFound,
  attestation: attestation(by),
});

const dismissalBy = (by: Reviewer, reason = 'withdrawn') => ({
  reason,
  explanation: `Synthetic: dismissed as ${reason}.`,
  attestation: attestation(by),
});

/** The body a reviewer's client sends for an appeal action, signed over the appeal's bytes. */
function signedAction(
  action: 'reconsideration' | 'dismissal',
  target: { appealId: string; caseId: string },
  body: object,
  by: Reviewer,
) {
  const bytes = canonicalJson({
    action,
    appealId: target.appealId,
    body,
    runId: target.caseId,
  });
  return {
    [action]: body,
    reviewerKeyId: by.reviewerKeyId,
    signature: sign(null, Buffer.from(bytes, 'utf8'), by.privateKey).toString('base64url'),
  };
}

const enrollee = (overrides: Record<string, unknown> = {}) => ({
  filer: { role: 'enrollee', name: 'Synthetic Enrollee' },
  channel: 'written',
  expedite: { requested: false, physicianSupport: false },
  statement: 'Synthetic: the enrollee asks the plan to look again at a new sleep study.',
  ...overrides,
});

describe.each(AXES)('appeals: Medicare Advantage reconsiderations (e2e), memory %s', (axis) => {
  let app: NestExpressApplication;
  let fixture: TestingModule;
  let cases: CaseRepository;
  let appeals: AppealRepository;
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
    appeals = fixture.get<AppealRepository>(APPEAL_REPOSITORY);
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
  const caseIdOf = (body: { entry: { resource: unknown }[] }): string =>
    String(ClaimResponseSchema.parse(body.entry[0]?.resource).identifier?.[0]?.value);
  const submitBody = (body: Record<string, unknown>) =>
    http().post('/fhir/Claim/$submit').set('Content-Type', FHIR_JSON).send(JSON.stringify(body));
  const inquire = (body: Record<string, unknown>) =>
    http().post('/fhir/Claim/$inquire').set('Content-Type', FHIR_JSON).send(JSON.stringify(body));
  const fileAppeal = (body: object) => http().post('/review/appeals').send(body);
  const reconsider = (appealId: string, body: unknown) =>
    http()
      .post(`/review/appeals/${appealId}/reconsideration`)
      .send(body as object);
  const dismiss = (appealId: string, body: unknown) =>
    http()
      .post(`/review/appeals/${appealId}/dismissal`)
      .send(body as object);

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

  /** Submits a request, which pends on the stub model, and denies it as DENIER at DECIDED. */
  async function deniedCase(
    task = 'pa-e0601-one-missing',
    member = `SYN-APL-${randomUUID().slice(0, 8)}`,
  ): Promise<{ caseId: string; bundle: Record<string, unknown> }> {
    now = RECEIVED;
    const bundle = bundleForMember(task, member);
    const submitted = await submitBody(bundle);
    expect(submitted.status).toBe(HttpStatus.OK);
    const caseId = caseIdOf(submitted.body);
    now = DECIDED;
    const decided = await http()
      .post(`/review/cases/${caseId}/determination`)
      .send(signedDenial(caseId));
    expect(decided.status).toBe(HttpStatus.OK);
    return { caseId, bundle };
  }

  /** A denied case and a timely standard appeal on it, filed at FILED. */
  async function filedAppeal(task?: string): Promise<{
    caseId: string;
    appealId: string;
    bundle: Record<string, unknown>;
  }> {
    const { caseId, bundle } = await deniedCase(task);
    now = FILED;
    const filed = await fileAppeal({ caseId, ...enrollee() });
    expect(filed.status).toBe(HttpStatus.CREATED);
    return { caseId, appealId: String(filed.body.appealId), bundle };
  }

  describe('filing', () => {
    it('files an appeal on a denied case with the computed deadlines, and a late one as untimely', async () => {
      const { caseId } = await deniedCase();
      now = FILED;
      const filed = await fileAppeal({ caseId, ...enrollee() });
      expect(filed.status).toBe(HttpStatus.CREATED);
      expect(filed.body).toMatchObject({
        caseId,
        status: 'filed',
        priority: 'standard',
        receivedAt: '2026-10-01T10:00:00.000Z',
        reconsiderationDueBy: '2026-10-31T10:00:00.000Z',
        // decided 2026-09-23: 65 days, to the end of the UTC day
        filingDeadline: '2026-11-27T23:59:59.999Z',
        timely: true,
        lapsed: false,
        initialReviewerId: 'synthetic-reviewer-001',
        reconsideration: null,
        forward: null,
      });
      expect(filed.body.reconsiderationCredentials).toEqual([
        'synthetic-physician',
        'synthetic-sleep-medicine-physician',
      ]);
      expect((await appeals.get(String(filed.body.appealId)))?.status).toBe('filed');

      const late = await deniedCase();
      now = new Date('2026-11-28T00:00:00Z');
      const lateFiling = await fileAppeal({ caseId: late.caseId, ...enrollee() });
      expect(lateFiling.status).toBe(HttpStatus.CREATED);
      expect(lateFiling.body).toMatchObject({ status: 'filed', timely: false });
      expect(lateFiling.body.reconsiderationDueBy).toBe('2026-12-28T00:00:00.000Z');
    });

    it('refuses a physician standard filing without notice, and expedites a request that asks', async () => {
      const { caseId } = await deniedCase();
      now = FILED;
      const physician = { role: 'physician', name: 'Synthetic Treating Physician' };
      const withoutNotice = await fileAppeal({ caseId, ...enrollee({ filer: physician }) });
      expect(withoutNotice.status).toBe(HttpStatus.BAD_REQUEST);
      expect(withoutNotice.text).toContain('enrolleeNotified');

      const expedited = await fileAppeal({
        caseId,
        ...enrollee({ filer: physician, expedite: { requested: true, physicianSupport: true } }),
      });
      expect(expedited.status).toBe(HttpStatus.CREATED);
      expect(expedited.body).toMatchObject({
        priority: 'expedited',
        reconsiderationDueBy: '2026-10-04T10:00:00.000Z',
      });
    });

    it('answers 409 for a second open appeal, 422 for a case with nothing to reconsider, and 404 for none', async () => {
      const { caseId, appealId } = await filedAppeal();
      const again = await fileAppeal({ caseId, ...enrollee() });
      expect(again.status).toBe(HttpStatus.CONFLICT);
      expect(again.text).toContain(appealId);

      now = RECEIVED;
      const pended = caseIdOf((await submitBody(readBundle('pa-e0470-one-missing'))).body);
      const approved = caseIdOf((await submitBody(readBundle('pa-k0823-one-missing'))).body);
      const approval = {
        kind: 'clinician-approval',
        attestation: attestation(DENIER, '2026-09-23T15:00:00+00:00'),
      };
      const bytes = canonicalJson({
        determination: approval,
        recommendationSeq: null,
        runId: approved,
      });
      now = DECIDED;
      await http()
        .post(`/review/cases/${approved}/determination`)
        .send({
          determination: approval,
          recommendationSeq: null,
          reviewerKeyId: DENIER.reviewerKeyId,
          signature: sign(null, Buffer.from(bytes, 'utf8'), DENIER.privateKey).toString(
            'base64url',
          ),
        });

      now = FILED;
      for (const target of [pended, approved]) {
        const refused = await fileAppeal({ caseId: target, ...enrollee() });
        expect({ target, status: refused.status }).toEqual({
          target,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
        });
      }
      expect((await fileAppeal({ caseId: randomUUID(), ...enrollee() })).status).toBe(
        HttpStatus.NOT_FOUND,
      );
      expect((await fileAppeal({ caseId, statement: 'no filer' })).status).toBe(
        HttpStatus.BAD_REQUEST,
      );
    });
  });

  describe('the queue', () => {
    /**
     * Pairs of appeals with identical clocks, on cases whose findings are all
     * met in one and all not met in the other. In world 1 the first of each
     * pair is the met one; in world 2 the not-met one. If the queue read
     * findings, the two worlds would order differently. Clocks are in 2025,
     * ahead of every other appeal here.
     */
    async function world(prefix: string, firstMet: boolean): Promise<string[]> {
      const clocks = [
        ['2025-01-02T09:00:00Z', 'standard'],
        ['2025-01-03T09:00:00Z', 'expedited'],
        ['2025-01-01T09:00:00Z', 'standard'],
        ['2025-01-01T09:00:00Z', 'standard'],
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
      const ids: string[] = [];
      for (const [index, [received, priority]] of clocks.entries()) {
        for (const member of [0, 1]) {
          const n = String(index * 2 + member).padStart(12, '0');
          const caseId = `${prefix}-0000-4000-8000-${n}`;
          const row: NewCase = {
            caseId,
            status: 'pended',
            priority: 'standard',
            receivedAt: new Date('2024-12-01T09:00:00Z'),
            decisionDueBy: new Date('2024-12-08T09:00:00Z'),
            memberId: `https://example.org/fhir/sid/member-id|SYN-AQ-${prefix}`,
            insurerId: 'https://example.org/fhir/sid/payer-id|QHP-SYN-001',
            providerId: 'https://example.org/fhir/sid/supplier-id|SUP-01',
            hcpcs: 'E0601',
            request: { resourceType: 'Bundle', type: 'collection' },
            disposition: findings((member === 0) === firstMet ? 'met' : 'not-met'),
            response: { resourceType: 'Bundle', id: 'synthetic' },
            recommendationSeq: null,
          };
          await cases.enqueue(row);
          await cases.decide(caseId, {
            determination: {
              kind: 'denial',
              specificReason: 'Synthetic fixture: denied.',
              attestation: attestation(DENIER, '2024-12-02T09:00:00+00:00'),
            },
            reviewerId: DENIER.reviewerId,
            reviewerKeyId: DENIER.reviewerKeyId,
            signature: `synthetic-signature-${caseId}`,
            decidedAt: new Date('2024-12-02T09:00:00Z'),
            response: { resourceType: 'Bundle', id: 'denied' },
          });
          const receivedAt = new Date(received);
          const appealId = `${prefix}-0000-4000-9000-${n}`;
          const filed = await appeals.file({
            appealId,
            caseId,
            priority,
            filer: {
              role: 'enrollee',
              name: 'Synthetic Enrollee',
              channel: 'written',
              expedite: { requested: priority === 'expedited', physicianSupport: false },
            },
            receivedAt,
            filingDeadline: new Date('2025-02-05T23:59:59.999Z'),
            timely: true,
            reconsiderationDueBy: new Date(
              receivedAt.getTime() + (priority === 'expedited' ? 72 : 720) * 3_600_000,
            ),
            request: { statement: 'Synthetic fixture: look again.' },
          });
          expect(filed.outcome).toBe('filed');
          ids.push(appealId);
        }
      }
      return ids;
    }

    it('orders two appeal sets with identical clocks and opposite findings identically', async () => {
      const run = randomUUID().slice(0, 4);
      const one = await world(`1${run}aaa`, true);
      const two = await world(`2${run}aaa`, false);

      const response = await http().get('/review/appeals?limit=1000');
      expect(response.status).toBe(HttpStatus.OK);
      const order = (response.body.appeals as { appealId: string }[]).map((item) => item.appealId);
      const positions = (ids: string[]) =>
        order.filter((id) => ids.includes(id)).map((id) => id.slice(-12));

      expect(positions(one)).toEqual(positions(two));
      // Reconsideration deadline, then receipt, then appeal id: the expedited
      // pair (due 2025-01-06), then the two pairs received 2025-01-01 (tied,
      // so by id), then the pair received 2025-01-02.
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
      expect(response.text).not.toContain('Synthetic fixture: met');
    });
  });

  describe('reconsideration', () => {
    it('reverses: $inquire returns the approval, and the denial record is unchanged', async () => {
      const member = `SYN-REV-${randomUUID().slice(0, 8)}`;
      const { caseId, bundle } = await deniedCase('pa-e0601-one-missing', member);
      now = FILED;
      const appealId = String((await fileAppeal({ caseId, ...enrollee() })).body.appealId);
      const before = await cases.get(caseId);

      now = RECONSIDERED;
      const body = signedAction(
        'reconsideration',
        { appealId, caseId },
        reconsiderationBy(RECONSIDERER, 'reversal'),
        RECONSIDERER,
      );
      const reversed = await reconsider(appealId, body);
      expect(reversed.status).toBe(HttpStatus.OK);
      capture(`${axis}-appeal-reversed.response.json`, reversed.body);
      const claimResponse = ClaimResponseSchema.parse(
        BundleSchema.parse(reversed.body).entry?.[0]?.resource,
      );
      expect(claimResponse).toMatchObject({
        outcome: 'complete',
        disposition: 'Approved on reconsideration.',
        preAuthRef: caseId,
      });

      const after = await cases.get(caseId);
      expect(after?.response).toEqual(reversed.body);
      expect(after?.determination).toEqual(before?.determination);
      expect(after?.reviewerId).toBe('synthetic-reviewer-001');
      expect(after?.signature).toBe(before?.signature);
      expect((await appeals.get(appealId))?.status).toBe('reversed');

      const inquiry = await inquire(bundle);
      expect(inquiry.status).toBe(HttpStatus.OK);
      captureInquiry(`${axis}-appeal-reversed`, inquiry.body);
      const returned = BundleSchema.parse(inquiry.body.parameter[0].resource);
      expect(ClaimResponseSchema.parse(returned.entry?.[0]?.resource)).toMatchObject({
        outcome: 'complete',
        preAuthRef: caseId,
      });

      // A byte-identical retry gets the stored body; anything else is 409.
      now = new Date('2026-10-06T09:00:00Z');
      const retry = await reconsider(appealId, body);
      expect(retry.status).toBe(HttpStatus.OK);
      expect(retry.text).toBe(reversed.text);
      const dismissal = signedAction(
        'dismissal',
        { appealId, caseId },
        dismissalBy(RECONSIDERER),
        RECONSIDERER,
      );
      expect((await dismiss(appealId, dismissal)).status).toBe(HttpStatus.CONFLICT);
    });

    it('affirms: the denial stays in force, and the appeal is forwarded with the case file digested', async () => {
      const { caseId, appealId } = await filedAppeal('pa-e0260-one-missing');
      const before = await cases.get(caseId);
      now = RECONSIDERED;
      const affirmed = await reconsider(
        appealId,
        signedAction(
          'reconsideration',
          { appealId, caseId },
          reconsiderationBy(RECONSIDERER, 'affirmation'),
          RECONSIDERER,
        ),
      );
      expect(affirmed.status).toBe(HttpStatus.OK);
      expect(affirmed.body).toEqual(before?.response);
      expect(
        ClaimResponseSchema.parse(BundleSchema.parse(affirmed.body).entry?.[0]?.resource)
          .preAuthRef,
      ).toBeUndefined();

      const row = await appeals.get(appealId);
      expect(row?.status).toBe('forwarded');
      expect(row?.forwardReason).toBe('affirmed');
      expect(row?.forwardedAt?.toISOString()).toBe(row?.decidedAt?.toISOString());
      expect(row?.forwardedAt?.toISOString()).toBe(RECONSIDERED.toISOString());

      const file = await http().get(`/review/appeals/${appealId}/case-file`);
      expect(file.status).toBe(HttpStatus.OK);
      expect(file.body.forwardedDigest).toBe(row?.caseFileDigest);
      expect(file.body.digest).toBe(row?.caseFileDigest);
      expect(file.body.caseFile.forward).toMatchObject({
        reason: 'affirmed',
        explanation: reconsiderationBy(RECONSIDERER, 'affirmation').explanation,
      });

      const view = await http().get(`/review/appeals/${appealId}`);
      expect(view.body).toMatchObject({
        status: 'forwarded',
        forward: { reason: 'affirmed', caseFileDigest: row?.caseFileDigest },
      });
    });

    it('refuses each unqualified or misdirected action with its status and leaves the appeal filed', async () => {
      const { caseId, appealId } = await filedAppeal();
      const other = await filedAppeal('pa-e0470-one-missing');
      const late = await deniedCase('pa-k0823-one-missing');
      now = new Date('2026-11-28T00:00:00Z');
      const lateId = String(
        (await fileAppeal({ caseId: late.caseId, ...enrollee() })).body.appealId,
      );
      const target = { appealId, caseId };
      const reversalAs = (by: Reviewer) =>
        signedAction('reconsideration', target, reconsiderationBy(by, 'reversal'), by);

      // P3-E's signature over the initial determination, presented as a reconsideration.
      const denial = signedDenial(caseId);
      const determinationSignature = {
        reconsideration: reconsiderationBy(RECONSIDERER, 'reversal'),
        reviewerKeyId: DENIER.reviewerKeyId,
        signature: denial.signature,
      };
      const attempts: [string, string, 'reconsider' | 'dismiss', unknown, number][] = [
        [
          "the initial reviewer's own valid signature",
          appealId,
          'reconsider',
          reversalAs(DENIER),
          403,
        ],
        [
          'the initial reviewer under a second key and credential',
          appealId,
          'reconsider',
          reversalAs(DENIER_SECOND_KEY),
          403,
        ],
        [
          'a dismissal by the initial reviewer',
          appealId,
          'dismiss',
          signedAction('dismissal', target, dismissalBy(DENIER), DENIER),
          403,
        ],
        ['a non-physician credential', appealId, 'reconsider', reversalAs(PHARMACIST), 403],
        [
          "P3-E's signature over the initial determination",
          appealId,
          'reconsider',
          determinationSignature,
          401,
        ],
        [
          'a signature over another appeal id',
          appealId,
          'reconsider',
          signedAction(
            'reconsideration',
            { appealId: other.appealId, caseId },
            reconsiderationBy(RECONSIDERER, 'reversal'),
            RECONSIDERER,
          ),
          401,
        ],
        [
          "a dismissal's signature presented as a reconsideration",
          appealId,
          'reconsider',
          {
            ...signedAction(
              'dismissal',
              target,
              reconsiderationBy(RECONSIDERER, 'reversal'),
              RECONSIDERER,
            ),
            reconsideration: reconsiderationBy(RECONSIDERER, 'reversal'),
            dismissal: undefined,
          },
          401,
        ],
        [
          'an untimely appeal reconsidered without goodCauseFound',
          lateId,
          'reconsider',
          signedAction(
            'reconsideration',
            { appealId: lateId, caseId: late.caseId },
            reconsiderationBy(RECONSIDERER, 'reversal'),
            RECONSIDERER,
          ),
          400,
        ],
        [
          'an untimely dismissal of a timely appeal',
          appealId,
          'dismiss',
          signedAction('dismissal', target, dismissalBy(RECONSIDERER, 'untimely'), RECONSIDERER),
          400,
        ],
        ['an unknown appeal', randomUUID(), 'reconsider', reversalAs(RECONSIDERER), 404],
      ];
      now = RECONSIDERED;
      for (const [label, id, route, body, status] of attempts) {
        const response =
          route === 'reconsider' ? await reconsider(id, body) : await dismiss(id, body);
        expect({ label, status: response.status }).toEqual({ label, status });
      }
      for (const id of [appealId, other.appealId, lateId]) {
        expect((await appeals.get(id))?.status).toBe('filed');
      }

      // The untimely appeal is reconsidered once good cause is found.
      now = new Date('2026-11-30T09:00:00Z');
      const withGoodCause = await reconsider(
        lateId,
        signedAction(
          'reconsideration',
          { appealId: lateId, caseId: late.caseId },
          reconsiderationBy(RECONSIDERER, 'reversal', true),
          RECONSIDERER,
        ),
      );
      expect(withGoodCause.status).toBe(HttpStatus.OK);
      expect((await appeals.get(lateId))?.reconsideration?.goodCauseFound).toBe(true);
    });

    it('dismisses by any registered key but the denier, and a new filing follows', async () => {
      const { caseId, appealId } = await filedAppeal();
      now = RECONSIDERED;
      const dismissed = await dismiss(
        appealId,
        signedAction('dismissal', { appealId, caseId }, dismissalBy(PHARMACIST), PHARMACIST),
      );
      expect(dismissed.status).toBe(HttpStatus.OK);
      expect(dismissed.body).toMatchObject({
        status: 'dismissed',
        dismissal: { record: { reason: 'withdrawn' }, reviewerId: 'synthetic-reviewer-003' },
      });
      const refiled = await fileAppeal({ caseId, ...enrollee() });
      expect(refiled.status).toBe(HttpStatus.CREATED);
    });
  });

  describe('the lapse', () => {
    it('answers 409 to a reconsideration past the deadline with no sweep run, and forwards the appeal', async () => {
      const { caseId, appealId } = await filedAppeal();
      now = new Date('2026-10-31T10:00:00Z');
      const view = await http().get(`/review/appeals/${appealId}`);
      expect(view.body).toMatchObject({ status: 'filed', lapsed: true });

      const late = await reconsider(
        appealId,
        signedAction(
          'reconsideration',
          { appealId, caseId },
          reconsiderationBy(RECONSIDERER, 'reversal'),
          RECONSIDERER,
        ),
      );
      expect(late.status).toBe(HttpStatus.CONFLICT);
      expect(late.text).toContain('§ 422.590(d)');
      const row = await appeals.get(appealId);
      expect(row).toMatchObject({
        status: 'forwarded',
        forwardReason: 'deadline-lapsed',
        reconsideration: null,
      });
      // The denial stays in force: nothing of the late reversal was recorded.
      const inForce = BundleSchema.parse((await cases.get(caseId))?.response);
      expect(ClaimResponseSchema.parse(inForce.entry?.[0]?.resource).preAuthRef).toBeUndefined();
    });

    it('forwards a lapsed appeal once over two sweeps, with one event', async () => {
      const { appealId } = await filedAppeal();
      const sweep = fixture.get(ReviewSweep);
      exporter.reset();
      now = new Date('2026-10-31T09:59:59Z');
      await sweep.sweep();
      now = new Date('2026-10-31T10:01:00Z');
      await sweep.sweep();
      now = new Date('2026-10-31T12:00:00Z');
      await sweep.sweep();

      const sweeps = exporter
        .getFinishedSpans()
        .filter((span) => span.name === 'review.overdue_sweep');
      expect(sweeps).toHaveLength(3);
      expect(unlistedAttributeKeys(sweeps)).toEqual([]);
      const events = sweeps
        .flatMap((span) => span.events)
        .filter((event) => event.attributes?.['prior_auth.appeal_id'] === appealId);
      expect(events).toHaveLength(1);
      expect(events[0]?.name).toBe('review.appeal.forwarded');
      expect(events[0]?.attributes).toMatchObject({
        'prior_auth.forward_reason': 'deadline-lapsed',
        'prior_auth.priority': 'standard',
        'prior_auth.minutes_past_due': 1,
      });

      const row = await appeals.get(appealId);
      expect(row?.forwardReason).toBe('deadline-lapsed');
      expect(row?.forwardedAt?.toISOString()).toBe('2026-10-31T10:01:00.000Z');
      const file = await http().get(`/review/appeals/${appealId}/case-file`);
      expect(file.body.digest).toBe(row?.caseFileDigest);
      expect(file.body.caseFile.forward.explanation).toContain('§ 422.590(d)');
    });
  });

  describe('the sentinel and the FHIR surface', () => {
    it('shows the rationale in the appeal view and the case file, and in no FHIR response', async () => {
      referWithSentinel();
      const member = `SYN-ASN-${randomUUID().slice(0, 8)}`;
      const { caseId, bundle } = await deniedCase('pa-k0823-ambiguous', member);
      now = FILED;
      const appealId = String((await fileAppeal({ caseId, ...enrollee() })).body.appealId);

      const view = await http().get(`/review/appeals/${appealId}`);
      expect(view.status).toBe(HttpStatus.OK);
      expect(view.text).toContain(SENTINEL);
      expect(view.body.signing).toEqual({
        algorithm: 'Ed25519',
        encoding: 'base64url',
        payload: 'canonicalJson({ action, appealId, body, runId })',
        actions: ['reconsideration', 'dismissal'],
        appealId,
        runId: caseId,
      });
      const file = await http().get(`/review/appeals/${appealId}/case-file`);
      expect(file.text).toContain(SENTINEL);
      const queue = await http().get('/review/appeals?limit=1000');
      expect(queue.text).not.toContain(SENTINEL);

      now = RECONSIDERED;
      const reversed = await reconsider(
        appealId,
        signedAction(
          'reconsideration',
          { appealId, caseId },
          reconsiderationBy(RECONSIDERER, 'reversal'),
          RECONSIDERER,
        ),
      );
      expect(reversed.status).toBe(HttpStatus.OK);
      expect(reversed.text).not.toContain(SENTINEL);
      expect(reversed.text).not.toContain('the appeal evidence was read');
      const inquiry = await inquire(bundle);
      expect(inquiry.body.parameter).toHaveLength(1);
      expect(inquiry.text).not.toContain(SENTINEL);
    });

    it('leaves the CapabilityStatement with $submit and $inquire and nothing for appeals', async () => {
      const metadata = await http().get('/fhir/metadata');
      expect(metadata.status).toBe(HttpStatus.OK);
      const statement = CapabilityStatementSchema.parse(metadata.body);
      const operations = (statement.rest ?? []).flatMap((rest) =>
        (rest.resource ?? []).flatMap((resource) =>
          (resource.operation ?? []).map((operation) => `${resource.type}/$${operation.name}`),
        ),
      );
      expect(operations).toEqual(['Claim/$submit', 'Claim/$inquire']);
      expect(metadata.text.toLowerCase()).not.toMatch(/appeal|reconsider/);
    });

    it('opens one span per appeal route, each held to the attribute allowlist', async () => {
      exporter.reset();
      const { caseId, appealId } = await filedAppeal();
      await http().get('/review/appeals?limit=10');
      await http().get(`/review/appeals/${appealId}`);
      await http().get(`/review/appeals/${appealId}/case-file`);
      now = RECONSIDERED;
      await dismiss(
        appealId,
        signedAction('dismissal', { appealId, caseId }, dismissalBy(RECONSIDERER), RECONSIDERER),
      );
      const spans = exporter
        .getFinishedSpans()
        .filter((span) => span.name.startsWith('review.appeal.'));
      expect([...new Set(spans.map((span) => span.name))].sort()).toEqual([
        'review.appeal.case_file',
        'review.appeal.dismissal',
        'review.appeal.file',
        'review.appeal.queue',
        'review.appeal.view',
      ]);
      expect(unlistedAttributeKeys(spans)).toEqual([]);
    });
  });
});

describe('appeals with no reviewer registry (e2e), memory unconfigured', () => {
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

  it('answers 503 to a reconsideration, and still serves the queue', async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = fixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    try {
      const appealId = randomUUID();
      const response = await request(app.getHttpServer())
        .post(`/review/appeals/${appealId}/reconsideration`)
        .send({});
      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.text).toContain('REVIEWER_REGISTRY');
      expect((await request(app.getHttpServer()).get('/review/appeals')).status).toBe(
        HttpStatus.OK,
      );
    } finally {
      await app.close();
    }
  });
});
