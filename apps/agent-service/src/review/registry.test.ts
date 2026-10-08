import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@repo/agent-cassette';
import { ReviewerRegistry, loadReviewerRegistry } from './registry.js';
import { ed25519PublicKey, signedBytes, verifySignature } from './signature.js';

/** A keypair generated in the test. No private key exists outside a test. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('no x');
  return { raw: x, privateKey };
}

const entry = (raw: string, overrides: Record<string, unknown> = {}) => ({
  reviewerKeyId: 'synthetic-key-001',
  reviewerId: 'synthetic-reviewer-001',
  credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
  publicKey: raw,
  ...overrides,
});

function registryFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-registry-'));
  const path = join(dir, 'registry.json');
  writeFileSync(path, content);
  return path;
}

describe('signedBytes', () => {
  it("is P3-C's attestation payload, canonical, with the case id as runId", () => {
    const determination = { kind: 'clinician-approval', attestation: { reviewerId: 'r' } };
    expect(signedBytes({ determination, recommendationSeq: null, caseId: 'c-1' }).toString()).toBe(
      canonicalJson({ determination, recommendationSeq: null, runId: 'c-1' }),
    );
  });
});

describe('verifySignature', () => {
  const { raw, privateKey } = keypair();
  const key = ed25519PublicKey(raw);
  const bytes = signedBytes({ determination: { kind: 'x' }, recommendationSeq: null, caseId: 'a' });
  const signature = sign(null, bytes, privateKey).toString('base64url');

  it('accepts the signature over the bytes it signed', () => {
    expect(verifySignature(key, bytes, signature)).toBe(true);
  });

  it('refuses the same signature over another case, another key, or garbage', () => {
    const other = signedBytes({
      determination: { kind: 'x' },
      recommendationSeq: null,
      caseId: 'b',
    });
    expect(verifySignature(key, other, signature)).toBe(false);
    expect(verifySignature(ed25519PublicKey(keypair().raw), bytes, signature)).toBe(false);
    expect(verifySignature(key, bytes, 'not-a-signature')).toBe(false);
    expect(verifySignature(key, bytes, `${signature}==`)).toBe(false);
  });
});

describe('loadReviewerRegistry', () => {
  it('is null when REVIEWER_REGISTRY is unset or blank', () => {
    expect(loadReviewerRegistry({})).toBeNull();
    expect(loadReviewerRegistry({ REVIEWER_REGISTRY: ' ' })).toBeNull();
  });

  it('loads a registry of synthetic keys', () => {
    const path = registryFile(JSON.stringify([entry(keypair().raw)]));
    expect(loadReviewerRegistry({ REVIEWER_REGISTRY: path })?.size).toBe(1);
  });

  it('throws naming REVIEWER_REGISTRY for a file that is not JSON, or not a registry', () => {
    const notJson = registryFile('{ not json');
    expect(() => loadReviewerRegistry({ REVIEWER_REGISTRY: notJson })).toThrow(
      /^REVIEWER_REGISTRY names .*could not be read as JSON/,
    );
    const badKey = registryFile(JSON.stringify([entry('too-short')]));
    expect(() => loadReviewerRegistry({ REVIEWER_REGISTRY: badKey })).toThrow(
      /^REVIEWER_REGISTRY names .*not a reviewer registry: 0\.publicKey/,
    );
    const missing = join(tmpdir(), 'synthetic-registry-that-does-not-exist.json');
    expect(() => loadReviewerRegistry({ REVIEWER_REGISTRY: missing })).toThrow(/REVIEWER_REGISTRY/);
  });

  it('refuses a key id registered twice', () => {
    const raw = keypair().raw;
    const path = registryFile(JSON.stringify([entry(raw), entry(raw)]));
    expect(() => loadReviewerRegistry({ REVIEWER_REGISTRY: path })).toThrow(/registered twice/);
  });
});

describe('ReviewerRegistry.active', () => {
  it('finds a registered key, and not one revoked at or before the time asked about', () => {
    const registry = new ReviewerRegistry([
      entry(keypair().raw),
      entry(keypair().raw, {
        reviewerKeyId: 'synthetic-key-revoked',
        revokedAt: '2026-01-01T00:00:00Z',
      }),
    ]);
    const at = new Date('2026-03-01T00:00:00Z');
    expect(registry.active('synthetic-key-001', at)?.entry.reviewerId).toBe(
      'synthetic-reviewer-001',
    );
    expect(registry.active('synthetic-key-revoked', at)).toBeUndefined();
    expect(
      registry.active('synthetic-key-revoked', new Date('2025-12-31T00:00:00Z')),
    ).toBeDefined();
    expect(registry.active('synthetic-key-absent', at)).toBeUndefined();
  });
});
