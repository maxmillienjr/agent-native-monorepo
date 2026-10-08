import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  BundleSchema,
  CapabilityStatementSchema,
  ClaimResponseSchema,
  OperationOutcomeSchema,
} from '@repo/prior-auth';
import { InMemoryCaseRepository, type CaseRepository } from '@repo/memory-core';
import { AppModule } from '../src/app.module.js';
import { FHIR_JSON, configureApp } from '../src/configure-app.js';
import { PRIOR_AUTH_CLOCK } from '../src/fhir/prior-auth.service.js';
import { CASE_REPOSITORY } from '../src/memory/memory.tokens.js';
import { RunsService } from '../src/runs/runs.service.js';

/**
 * The FHIR surface over HTTP, model `stub` / memory `stub` (P3-D).
 *
 * Every response this spec receives is written to `FHIR_CAPTURE_DIR` when it
 * is set, which is how `fhir-validate.yml` validates captured responses
 * against base R4 and US Core with the HL7 validator.
 */
const DATASET = resolve(
  process.cwd(),
  '..',
  '..',
  'packages',
  'eval-harness',
  'datasets',
  'prior-auth',
);
const BUNDLES = join(DATASET, 'bundles');
const bundleFiles = readdirSync(BUNDLES)
  .filter((file) => file.endsWith('.bundle.json'))
  .sort();
const readBundle = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(BUNDLES, file), 'utf8')) as Record<string, unknown>;

const captureDir = process.env['FHIR_CAPTURE_DIR'];
function capture(name: string, body: unknown): void {
  if (captureDir === undefined || captureDir === '') return;
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(join(captureDir, name), `${JSON.stringify(body, null, 2)}\n`);
}

const FIXED_NOW = new Date('2026-09-22T10:00:00Z');

/** Removes what differs between two submissions of one bundle: the case id and the clock. */
function normalize(body: unknown): unknown {
  const text = JSON.stringify(body);
  const caseIds = [
    ...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []),
  ];
  return JSON.parse(caseIds.reduce((acc, id) => acc.split(id).join('<case>'), text)) as unknown;
}

describe('FHIR prior-authorization surface (e2e)', () => {
  let app: NestExpressApplication;
  let moduleFixture: TestingModule;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // The stub axis on both halves, whatever the developer's shell holds.
    for (const name of ['GOOGLE_API_KEY', 'DATABASE_URL', 'NEO4J_URI']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }

    moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRIOR_AUTH_CLOCK)
      .useValue({ now: () => FIXED_NOW })
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  });

  const submit = (body: unknown, contentType = FHIR_JSON) =>
    request(app.getHttpServer())
      .post('/fhir/Claim/$submit')
      .set('Content-Type', contentType)
      .send(typeof body === 'string' ? body : JSON.stringify(body));

  it('answers a committed bundle sent as application/fhir+json with a response Bundle', async () => {
    const response = await submit(readBundle('pa-e0601-all-met-structured.bundle.json'));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.headers['content-type']).toContain(FHIR_JSON);
    const bundle = BundleSchema.parse(response.body);
    expect(bundle.entry?.[0]?.resource?.resourceType).toBe('ClaimResponse');
  });

  it('answers the same bundle sent as application/json with the same response', async () => {
    const body = readBundle('pa-e0601-all-met-structured.bundle.json');
    const fhir = await submit(body, FHIR_JSON);
    const json = await submit(body, 'application/json');

    expect(json.status).toBe(HttpStatus.OK);
    expect(normalize(json.body)).toEqual(normalize(fhir.body));
  });

  it('pends every committed bundle on the stub model, and approves none', async () => {
    const cases = moduleFixture.get<CaseRepository>(CASE_REPOSITORY);
    expect(bundleFiles).toHaveLength(24);
    for (const file of bundleFiles) {
      const response = await submit(readBundle(file));
      expect(response.status).toBe(HttpStatus.OK);
      capture(file.replace('.bundle.json', '.response.json'), response.body);

      const claimResponse = ClaimResponseSchema.parse(response.body.entry[0].resource);
      expect(claimResponse.outcome).toBe('queued');
      expect(claimResponse.preAuthRef).toBeUndefined();

      // Each one leaves one case row, pended, holding the response it was given (P3-E).
      const caseId = String(claimResponse.identifier?.[0]?.value);
      const row = await cases.get(caseId);
      expect(row?.status).toBe('pended');
      expect(row?.response).toEqual(response.body);
    }
  }, 30_000);

  it('answers a body that is not a Bundle with 400 and an OperationOutcome', async () => {
    const response = await submit({ resourceType: 'Patient', id: 'not-a-bundle' });
    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(OperationOutcomeSchema.safeParse(response.body).success).toBe(true);
    capture('invalid-not-a-bundle.outcome.json', response.body);
  });

  it('answers a Bundle whose first entry is not a Claim with 400 and an OperationOutcome', async () => {
    const body = readBundle('pa-e0601-all-met-structured.bundle.json') as { entry: unknown[] };
    body.entry.reverse();
    const response = await submit(body);
    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(OperationOutcomeSchema.safeParse(response.body).success).toBe(true);
  });

  it('answers a body the JSON parser rejects with 400 and an OperationOutcome', async () => {
    const response = await submit('{"resourceType": "Bundle",');
    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(OperationOutcomeSchema.safeParse(response.body).success).toBe(true);
  });

  it('answers a Claim with no item with 422 and an OperationOutcome', async () => {
    const body = readBundle('pa-e0601-all-met-structured.bundle.json') as {
      entry: { resource: Record<string, unknown> }[];
    };
    delete body.entry[0]?.resource['item'];
    const response = await submit(body);
    expect(response.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(OperationOutcomeSchema.safeParse(response.body).success).toBe(true);
  });

  it('lists exactly the operations implemented in its CapabilityStatement', async () => {
    const response = await request(app.getHttpServer()).get('/fhir/metadata');
    expect(response.status).toBe(HttpStatus.OK);
    expect(response.headers['content-type']).toContain(FHIR_JSON);
    capture('metadata.capability.json', response.body);

    const statement = CapabilityStatementSchema.parse(response.body);
    const operations = (statement.rest ?? []).flatMap((rest) => [
      ...(rest.operation ?? []).map((operation) => operation.name),
      ...(rest.resource ?? []).flatMap((resource) =>
        (resource.operation ?? []).map((operation) => `${resource.type}/$${operation.name}`),
      ),
    ]);
    expect(operations).toEqual(['Claim/$submit', 'Claim/$inquire']);
    expect(statement.description).toContain('shaped after Da Vinci PAS 2.2.1');
    // PAS requires subscriptions for the final response; none is built, and
    // the statement says so by declaring no Subscription resource (P3-E).
    expect(statement.rest?.flatMap((rest) => rest.resource ?? []).map((r) => r.type)).toEqual([
      'Claim',
    ]);
    expect(JSON.stringify(statement)).not.toContain('Subscription');
  });

  describe('with a case store that cannot write', () => {
    let failing: NestExpressApplication;

    beforeAll(async () => {
      const broken = new InMemoryCaseRepository();
      broken.enqueue = async () => {
        throw new Error('the case store is down');
      };
      const fixture = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CASE_REPOSITORY)
        .useValue(broken)
        .compile();
      failing = fixture.createNestApplication<NestExpressApplication>();
      configureApp(failing);
      await failing.init();
    });

    afterAll(async () => {
      await failing.close();
    });

    it('answers 503 with an OperationOutcome and no ClaimResponse (P3-E)', async () => {
      const response = await request(failing.getHttpServer())
        .post('/fhir/Claim/$submit')
        .set('Content-Type', FHIR_JSON)
        .send(JSON.stringify(readBundle('pa-e0601-all-met-structured.bundle.json')));

      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(OperationOutcomeSchema.safeParse(response.body).success).toBe(true);
      expect(response.text).not.toContain('ClaimResponse');
      capture('enqueue-failed.outcome.json', response.body);
    });
  });

  describe('with an assess that writes a sentinel into every rationale', () => {
    const SENTINEL = 'SENTINEL-RATIONALE-3c9e';

    beforeAll(() => {
      // Met with a citation that resolves, for every criterion, so the request
      // is approved: the approval's note is the one built from criterion titles.
      moduleFixture.get(RunsService).setModelDecorator((live) => ({
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
    });

    it('approves and serializes no model text', async () => {
      const response = await submit(readBundle('pa-e0601-all-met-structured.bundle.json'));
      expect(response.status).toBe(HttpStatus.OK);
      capture('sentinel-approval.response.json', response.body);

      const claimResponse = ClaimResponseSchema.parse(response.body.entry[0].resource);
      expect(claimResponse.outcome).toBe('complete');
      expect(response.text).not.toContain(SENTINEL);
    });
  });
});
