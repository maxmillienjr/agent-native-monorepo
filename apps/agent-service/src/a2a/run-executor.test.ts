import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { Role, TaskState, type Message } from '@a2a-js/sdk';
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { pausingService } from '../runs/pausing-fixture.js';
import { RunExecutor } from './run-executor.js';

/** The executor reads these four members of a request, and nothing else. */
function requestFor(text: string): RequestContext {
  const contextId = randomUUID();
  const userMessage: Message = {
    messageId: randomUUID(),
    contextId,
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: text },
        mediaType: 'text/plain',
        filename: '',
        metadata: {},
      },
    ],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
  return {
    taskId: randomUUID(),
    contextId,
    userMessage,
    context: { user: undefined },
  } as unknown as RequestContext;
}

describe('an A2A task whose run pauses for an approval', () => {
  let key: string | undefined;

  beforeAll(() => {
    key = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
  });

  afterAll(() => {
    if (key !== undefined) process.env['GOOGLE_API_KEY'] = key;
  });

  it('ends FAILED with the outcome, not COMPLETED, and executes nothing', async () => {
    const { service, executed } = pausingService(new MemorySaver());
    const events: AgentExecutionEvent[] = [];
    const bus = { publish: (event: AgentExecutionEvent) => events.push(event) };

    await new RunExecutor(service, null).execute(
      requestFor('Tell the member about the case.'),
      bus as unknown as ExecutionEventBus,
    );

    const statuses = events.flatMap((event) =>
      event.kind === 'statusUpdate' && event.data.status !== undefined ? [event.data.status] : [],
    );
    const last = statuses.at(-1);
    expect(last?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(statuses.map((status) => status.state)).not.toContain(TaskState.TASK_STATE_COMPLETED);
    expect(
      events.find((event) => event.kind === 'statusUpdate' && event.data.status === last),
    ).toMatchObject({ data: { metadata: { outcome: 'awaiting-approval' } } });
    expect(executed()).toBe(0);
  });
});
