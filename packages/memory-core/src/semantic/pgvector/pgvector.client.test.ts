import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createReadOnlyPool } from '../../audit/read-only-pool.js';
import { listenForIdleErrors } from './pgvector.client.js';

// No connection is opened: a pool connects lazily, and these tests only emit
// the event an idle client raises when its server goes away.
const URL = 'postgresql://unused@127.0.0.1:1/unused';

describe('idle-client errors on a pg pool', () => {
  it('ends the process without a listener, which is the defect being guarded', () => {
    const bare = new pg.Pool({ connectionString: URL });
    expect(() => bare.emit('error', new Error('terminating connection'))).toThrow(
      'terminating connection',
    );
  });

  it('is absorbed once listenForIdleErrors has attached one', () => {
    const pool = listenForIdleErrors(new pg.Pool({ connectionString: URL }));
    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
  });

  it('reaches the caller when one is given', () => {
    const onError = vi.fn();
    const pool = listenForIdleErrors(new pg.Pool({ connectionString: URL }), onError);
    const error = new Error('terminating connection');
    pool.emit('error', error);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('is absorbed on the read-only pool audit replay uses', () => {
    const pool = createReadOnlyPool(URL);
    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
  });
});
