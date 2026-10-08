import { describe, it, expect } from 'vitest';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  CASE_BOARD_CHANNEL,
  CaseNotFoundError,
  RecordsRequestNotFoundError,
  SyntheticCaseBoard,
} from './case-board.js';
import { defaultRegistry } from './registry.js';
import { RequestRecordsInputSchema } from './request-records.tool.js';

const input = { caseId: 'PA-100002', documents: ['clinical-notes' as const], dueInDays: 7 };

describe('SyntheticCaseBoard', () => {
  it('returns one requestId for two openRequest calls with one idempotency key, and holds one request', async () => {
    const board = new SyntheticCaseBoard();

    const first = await board.openRequest(input, 'run-1:0');
    const second = await board.openRequest(input, 'run-1:0');

    expect(second).toEqual(first);
    expect(board.openRequests('PA-100002')).toHaveLength(1);
  });

  it('opens a second request under a second key', async () => {
    const board = new SyntheticCaseBoard();

    await board.openRequest(input, 'run-1:0');
    await board.openRequest(input, 'run-1:1');

    expect(board.openRequests('PA-100002')).toHaveLength(2);
  });

  it('refuses a case it does not hold', async () => {
    await expect(
      new SyntheticCaseBoard().openRequest({ ...input, caseId: 'PA-999999' }, 'run-1:0'),
    ).rejects.toThrow(CaseNotFoundError);
  });

  it('withdraws idempotently, and refuses a request it never opened', async () => {
    const board = new SyntheticCaseBoard();
    const { requestId } = await board.openRequest(input, 'run-1:0');

    await board.withdrawRequest(requestId, 'run-1:0');
    await board.withdrawRequest(requestId, 'run-1:0');

    expect(board.openRequests('PA-100002')).toEqual([]);
    await expect(board.withdrawRequest('RR-999999', 'run-1:0')).rejects.toThrow(
      RecordsRequestNotFoundError,
    );
  });

  it('publishes every operation, so a replay can show it made none', async () => {
    const seen: unknown[] = [];
    const listener = (message: unknown) => seen.push(message);
    subscribe(CASE_BOARD_CHANNEL, listener);
    try {
      const board = new SyntheticCaseBoard();
      const { requestId } = await board.openRequest(input, 'run-1:0');
      await board.withdrawRequest(requestId, 'run-1:0');
    } finally {
      unsubscribe(CASE_BOARD_CHANNEL, listener);
    }

    expect(seen).toEqual([{ operation: 'openRequest' }, { operation: 'withdrawRequest' }]);
  });
});

describe('the default registry', () => {
  const registry = defaultRegistry(new SyntheticCaseBoard());

  it('holds web-search as read-only and request-records as compensable', () => {
    expect(registry.describe().map((tool) => [tool.name, tool.tier])).toEqual([
      ['web-search', 'read-only'],
      ['request-records', 'compensable'],
    ]);
  });

  it('refuses a web-search query sent as a bare string, the shape one live call had', () => {
    const result = registry.get('web-search')!.input.safeParse('LangGraph latest release');
    expect(result.success).toBe(false);
  });

  it('refuses a records request outside the case-id shape or the document kinds', () => {
    expect(RequestRecordsInputSchema.safeParse({ ...input, caseId: '100002' }).success).toBe(false);
    expect(
      RequestRecordsInputSchema.safeParse({ ...input, documents: ['operative-report'] }).success,
    ).toBe(false);
    expect(RequestRecordsInputSchema.safeParse({ ...input, dueInDays: 30 }).success).toBe(false);
  });

  it('undoes a records request through its compensate, with the output execute returned', async () => {
    const board = new SyntheticCaseBoard();
    const tool = defaultRegistry(board).get('request-records')!;
    const ctx = { runId: 'run-1', idempotencyKey: 'run-1:0' };
    if (tool.tier !== 'compensable') throw new Error('request-records is compensable');

    const output = await tool.execute(input, ctx);
    expect(board.openRequests('PA-100002')).toHaveLength(1);

    await tool.compensate(input, output, ctx);
    expect(board.openRequests('PA-100002')).toEqual([]);
  });
});
