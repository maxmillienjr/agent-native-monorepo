import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { pausingService } from './pausing-fixture.js';

const body = {
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  messages: [{ role: 'user', content: 'Tell the member about the case.' }],
};

describe('a run paused for approval, as RunsService reports it', () => {
  const key = process.env['GOOGLE_API_KEY'];

  beforeEach(() => {
    delete process.env['GOOGLE_API_KEY'];
  });

  afterEach(() => {
    if (key !== undefined) process.env['GOOGLE_API_KEY'] = key;
  });

  it('returns awaiting-approval from execute, and leaves the call unexecuted', async () => {
    const checkpointer = new MemorySaver();
    const { service, executed } = pausingService(checkpointer);

    const response = await service.execute({ body, correlationId: 'corr-pause' });

    expect(response.outcome).toBe('awaiting-approval');
    expect(executed()).toBe(0);
    const saved = await checkpointer.getTuple({ configurable: { thread_id: response.runId } });
    expect(saved).toBeDefined();
  });

  it('keeps __interrupt__ out of the traced node sequence', async () => {
    const { service } = pausingService(new MemorySaver());

    const traced = await service.executeTraced({ body, correlationId: 'corr-pause-traced' });

    expect(traced.response.outcome).toBe('awaiting-approval');
    expect(traced.nodeSequence).toEqual(['ingress', 'retrieve', 'plan', 'act']);
  });

  it('reports the refusal as partial when there is no checkpointer to pause on', async () => {
    const { service, executed } = pausingService(null);

    const response = await service.execute({ body, correlationId: 'corr-refuse' });

    expect(response.outcome).toBe('partial');
    expect(executed()).toBe(0);
  });
});
