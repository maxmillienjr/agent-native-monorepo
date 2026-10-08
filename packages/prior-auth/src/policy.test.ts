import { describe, expect, it } from 'vitest';
import { HcpcsLevelIICodeSchema, PolicyCatalogue, PolicySchema, loadPayer } from './policy.js';

describe('the policy catalogue', () => {
  const catalogue = PolicyCatalogue.load();

  it('holds one policy for each of the four HCPCS Level II codes', () => {
    expect(
      catalogue
        .all()
        .map((policy) => policy.hcpcs)
        .sort(),
    ).toEqual(['E0260', 'E0470', 'E0601', 'K0823']);
  });

  it('gives every policy a disclaimer that it is invented', () => {
    for (const policy of catalogue.all()) {
      expect(policy.disclaimer).toMatch(/^Synthetic\./);
      expect(policy.disclaimer).toContain('not any payer');
    }
  });

  it('refuses two policies for one code', () => {
    const [first] = catalogue.all();
    if (first === undefined) throw new Error('no policies');
    expect(() => new PolicyCatalogue([first, first])).toThrow(/two policies/);
  });

  it('lists the credential types that may deny under each policy, all synthetic', () => {
    for (const policy of catalogue.all()) {
      expect(policy.reviewerCredentials.length, policy.id).toBeGreaterThan(0);
      expect(policy.reviewerCredentials, policy.id).toContain('synthetic-physician');
    }
    const [first] = catalogue.all();
    if (first === undefined) throw new Error('no policies');
    expect(
      PolicySchema.safeParse({ ...first, reviewerCredentials: ['board-certified-physician'] })
        .success,
    ).toBe(false);
  });

  it('lets only physician credential types reconsider, and covers items and services alone (P3-F)', () => {
    for (const policy of catalogue.all()) {
      expect(policy.reconsiderationCredentials, policy.id).toContain('synthetic-physician');
      for (const type of policy.reconsiderationCredentials) expect(type).toMatch(/physician$/);
      expect(policy.requestType).toBe('item-or-service');
    }
    const [first] = catalogue.all();
    if (first === undefined) throw new Error('no policies');
    const reconsideredBy = (types: string[]) =>
      PolicySchema.safeParse({ ...first, reconsiderationCredentials: types }).success;
    expect(reconsideredBy(['synthetic-pharmacist'])).toBe(false);
    expect(reconsideredBy(['synthetic-nurse-practitioner'])).toBe(false);
    expect(reconsideredBy(['synthetic-sleep-medicine-physician'])).toBe(true);
    expect(PolicySchema.safeParse({ ...first, requestType: 'part-b-drug' }).success).toBe(false);
  });

  it('names Medicare Advantage as every plan line of business (P3-F)', () => {
    const payer = loadPayer();
    expect(payer.plans.map((plan) => plan.lineOfBusiness)).toEqual(
      payer.plans.map(() => 'medicare-advantage'),
    );
  });

  it('rejects a policy without a disclaimer', () => {
    const [first] = catalogue.all();
    const { disclaimer: _dropped, ...withoutDisclaimer } = first ?? {};
    expect(PolicySchema.safeParse(withoutDisclaimer).success).toBe(false);
  });
});

describe('HcpcsLevelIICodeSchema', () => {
  it('accepts Level II codes outside the D range', () => {
    for (const code of ['E0601', 'K0823', 'A4604', 'V2020']) {
      expect(HcpcsLevelIICodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it('rejects a five-digit Level I shape and the CDT D range', () => {
    // All zeros: the shape of a code without being one anyone could look up.
    for (const code of ['00000', 'D0000', 'e0601', 'E060']) {
      expect(HcpcsLevelIICodeSchema.safeParse(code).success, code).toBe(false);
    }
  });
});

describe('the fictional payer', () => {
  it('is addressed by an example.org identifier and carries the ICD-10-CM notice', () => {
    const payer = loadPayer();
    expect(payer.payer.identifier.system.startsWith('https://example.org/')).toBe(true);
    expect(payer.notice).toContain('Source: CDC/NCHS');
    expect(payer.notice).toContain('does not imply endorsement');
  });
});
