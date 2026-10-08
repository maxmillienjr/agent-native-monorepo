import { randomUUID } from 'node:crypto';
import {
  Role,
  TaskState,
  type Message,
  type Part,
  type Task,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import { TaskNotCancelableError } from '@a2a-js/sdk/errors';
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import type { EpisodicRepository } from '@repo/memory-core';
import type { RunRequest } from '@repo/agent-contracts';
import { createLogger, getCorrelationId } from '@repo/telemetry';
import { buildRunResponse } from '../agent/nodes/egress.node.js';
import { OPEN_PRINCIPAL } from '../auth/credentials.js';
import type { RunsService } from '../runs/runs.service.js';
import { HistoryError, rebuildHistory } from './history.js';
import { contextSessionId } from './session-id.js';

const logger = createLogger('a2a-executor');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serializes work per key, in arrival order, within this process.
 *
 * Two messages in one context at once would both read _n_ turns and both
 * write turn _n_, and `ON CONFLICT DO NOTHING` would drop the second. One
 * process is an assumption, and P5-A says so: two replicas could still race.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    this.tails.set(key, tail);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const textPart = (text: string): Part => ({
  content: { $case: 'text', value: text },
  mediaType: 'text/plain',
  filename: '',
  metadata: {},
});

const agentMessage = (taskId: string, contextId: string, text: string): Message => ({
  messageId: randomUUID(),
  contextId,
  taskId,
  role: Role.ROLE_AGENT,
  parts: [textPart(text)],
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
});

/** The text a message carries: every text part, in order. */
function messageText(message: Message): string {
  return message.parts
    .flatMap((part) => (part.content?.$case === 'text' ? [part.content.value] : []))
    .join('\n')
    .trim();
}

/**
 * A2A task to run, and graph updates to A2A events (P5-A).
 *
 * A task id is the run id, and so the checkpointer's `thread_id`. A context is
 * a session, derived per principal (`session-id.ts`). Every message starts a
 * new task, rebuilds the context's history from episodic memory and runs the
 * graph once through `RunsService.run`, the loop `/runs` and `/runs/stream`
 * use. Every task ends terminal, so a message naming a finished task is the
 * SDK's `UnsupportedOperationError`.
 *
 * Events, in order: the task `SUBMITTED`; one `WORKING` status per node, as
 * that node's update arrives, with `metadata.node`; the `answer` and `run`
 * artifacts; `COMPLETED`, with `metadata.outcome`. A failure is `FAILED`,
 * with a message that names the node and never the error, which is logged
 * with the correlation and run ids instead: a 5xx payload is never forwarded
 * (`.context/conventions.md`, Error Handling). The executor never throws,
 * because the SDK's own handler for a throw puts the error's text in the
 * status message.
 */
export class RunExecutor implements AgentExecutor {
  private readonly sessions = new KeyedQueue();

  constructor(
    private readonly runs: RunsService,
    private readonly episodes: EpisodicRepository | null,
  ) {}

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    const correlationId = getCorrelationId() ?? randomUUID();
    const status = (state: TaskState, metadata: Record<string, unknown>, text?: string) =>
      bus.publish(AgentEvent.statusUpdate(statusEvent(taskId, contextId, state, metadata, text)));

    const task: Task = {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now() },
      artifacts: [],
      history: [userMessage],
      metadata: {},
    };
    bus.publish(AgentEvent.task(task));

    // The SDK mints task ids with randomUUID, and the run contract requires a
    // UUID. If that ever changes, the task fails rather than the run getting a
    // second id that the task id does not name.
    if (!UUID.test(taskId)) {
      status(
        TaskState.TASK_STATE_FAILED,
        {},
        'The task id is not a UUID, so it cannot be a run id.',
      );
      return;
    }

    const text = messageText(userMessage);
    if (text === '') {
      status(
        TaskState.TASK_STATE_REJECTED,
        {},
        'This agent reads text parts, and the message has none.',
      );
      return;
    }

    const principal = context.context.user?.userName || OPEN_PRINCIPAL;
    const sessionId = contextSessionId(principal, contextId);

    await this.sessions.run(sessionId, async () => {
      let history: RunRequest['messages'];
      try {
        history = await rebuildHistory(this.episodes, sessionId);
      } catch (error) {
        const known = error instanceof HistoryError;
        logger.error({
          msg: 'a2a.history.failed',
          correlationId,
          runId: taskId,
          error: errorText(error),
        });
        status(
          TaskState.TASK_STATE_FAILED,
          {},
          known ? error.message : 'The conversation history could not be read.',
        );
        return;
      }

      const body: RunRequest = {
        sessionId,
        messages: [...history, { role: 'user', content: text }],
      };
      let running: string | undefined;

      try {
        const run = await this.runs.run({ body, correlationId, runId: taskId }, (event) => {
          if (event.kind === 'started') {
            running = event.node;
            return;
          }
          status(TaskState.TASK_STATE_WORKING, { node: event.node });
        });

        const response = buildRunResponse(run.state);
        const answer =
          [...response.messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
        bus.publish(
          AgentEvent.artifactUpdate(artifactEvent(taskId, contextId, 'answer', textPart(answer))),
        );
        bus.publish(
          AgentEvent.artifactUpdate(
            artifactEvent(taskId, contextId, 'run', {
              content: {
                $case: 'data',
                value: {
                  runId: response.runId,
                  outcome: response.outcome,
                  tokenCounts: response.tokenCounts,
                  // The messages the run was given: the rebuilt history plus
                  // this one. What a second message in a context checks.
                  messageCount: body.messages.length,
                  retrievedCount: response.retrievedContext.length,
                },
              },
              mediaType: 'application/json',
              filename: '',
              metadata: {},
            }),
          ),
        );
        // `partial` is still a completed run; the outcome says which.
        status(TaskState.TASK_STATE_COMPLETED, { outcome: response.outcome });
      } catch (error) {
        logger.error({
          msg: 'a2a.task.failed',
          correlationId,
          runId: taskId,
          node: running,
          error: errorText(error),
        });
        status(
          TaskState.TASK_STATE_FAILED,
          running === undefined ? {} : { node: running },
          running === undefined
            ? 'The run failed before any node ran.'
            : `The run failed in node ${running}.`,
        );
      }
    });
  }

  /**
   * No running task can be cancelled. A run stopped between `reflect`'s
   * Postgres and Neo4j writes would leave a partial write that only a replay
   * makes safe, and nothing replays a cancelled run (P5-A, Non-goals). Thrown
   * rather than published, so the caller gets `-32002` at once instead of
   * waiting for the run to finish and then getting it.
   */
  async cancelTask(taskId: string): Promise<void> {
    throw new TaskNotCancelableError(`Task ${taskId} is running and cannot be cancelled.`);
  }
}

const now = () => new Date().toISOString();

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function statusEvent(
  taskId: string,
  contextId: string,
  state: TaskState,
  metadata: Record<string, unknown>,
  text?: string,
): TaskStatusUpdateEvent {
  return {
    taskId,
    contextId,
    status: {
      state,
      message: text === undefined ? undefined : agentMessage(taskId, contextId, text),
      timestamp: now(),
    },
    metadata,
  };
}

function artifactEvent(taskId: string, contextId: string, name: string, part: Part) {
  return {
    taskId,
    contextId,
    artifact: {
      artifactId: name,
      name,
      description: '',
      parts: [part],
      metadata: {},
      extensions: [],
    },
    append: false,
    lastChunk: true,
    metadata: {},
  };
}
