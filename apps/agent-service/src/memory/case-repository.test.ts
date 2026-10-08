import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { DrizzleCaseRepository, InMemoryCaseRepository } from '@repo/memory-core';
import { selectCaseRepository } from './case-repository.js';

describe('selectCaseRepository', () => {
  it('selects the volatile store with no pool, and warns that it is volatile', () => {
    const warn = vi.fn();
    expect(selectCaseRepository(null, warn)).toBeInstanceOf(InMemoryCaseRepository);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ msg: 'review.cases.volatile' });
  });

  it('selects Postgres with a pool, and says nothing', () => {
    const warn = vi.fn();
    const pool = {} as pg.Pool;
    expect(selectCaseRepository(pool, warn)).toBeInstanceOf(DrizzleCaseRepository);
    expect(warn).not.toHaveBeenCalled();
  });
});
