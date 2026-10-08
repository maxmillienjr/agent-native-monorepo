import { channel } from 'node:diagnostics_channel';

/**
 * The documents a records request can ask for. Generic kinds, not clinical
 * content, so the board stays inside ADR 0003: no code, no finding.
 */
export const DOCUMENT_KINDS = [
  'clinical-notes',
  'imaging-report',
  'lab-results',
  'treatment-plan',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Invented prior-authorization case ids. Nothing else exists on the board. */
export const SYNTHETIC_CASE_IDS = ['PA-100001', 'PA-100002', 'PA-100003'] as const;

export interface RecordsRequestInput {
  readonly caseId: string;
  readonly documents: readonly DocumentKind[];
  readonly dueInDays: number;
}

export interface RecordsRequest extends RecordsRequestInput {
  readonly requestId: string;
  readonly status: 'open' | 'withdrawn';
}

/** The failure the saga tests drive: a request against a case the board does not hold. */
export class CaseNotFoundError extends Error {
  constructor(readonly caseId: string) {
    super(`no case ${caseId} on the board`);
    this.name = 'CaseNotFoundError';
  }
}

export class RecordsRequestNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super(`no records request ${requestId} on the board`);
    this.name = 'RecordsRequestNotFoundError';
  }
}

/** What `request-records` needs from a case board. */
export interface CaseBoard {
  /** Idempotent on the key: a second call with it returns the first request. */
  openRequest(input: RecordsRequestInput, idempotencyKey: string): Promise<{ requestId: string }>;
  /** Idempotent: withdrawing a withdrawn request does nothing. */
  withdrawRequest(requestId: string, idempotencyKey: string): Promise<void>;
  openRequests(caseId: string): readonly RecordsRequest[];
}

/**
 * Where every board operation is published, for a watcher that has to know
 * none happened — a replayed run, which must serve both tool seams from its
 * cassette (`watchForCaseBoardCalls`). The same move as the model-host watcher,
 * and for the same reason: a spy on the wiring proves less than a count of what
 * actually ran.
 */
export const CASE_BOARD_CHANNEL = 'agent-native:case-board';
const published = channel(CASE_BOARD_CHANNEL);

/**
 * An in-process prior-authorization case board, seeded with three invented
 * cases, behind the one compensable tool.
 *
 * It exists so the registry is designed against a tool with an effect rather
 * than against `web-search` alone, and it touches no database, so the memory
 * write rule does not apply to it.
 *
 * **It is not durable.** The saga log is in checkpointed state and this board
 * is in the process. After a restart between a step and its compensation the
 * board has forgotten a request the checkpoint still lists as applied, and the
 * withdrawal fails with `RecordsRequestNotFoundError`. A real tool needs an
 * outbox for that, and the outbox belongs to the case layer ADR 0001 leaves
 * room for, not to this board.
 */
export class SyntheticCaseBoard implements CaseBoard {
  private readonly requests = new Map<string, RecordsRequest>();
  private readonly byKey = new Map<string, string>();
  private sequence = 0;

  constructor(private readonly caseIds: readonly string[] = SYNTHETIC_CASE_IDS) {}

  async openRequest(
    input: RecordsRequestInput,
    idempotencyKey: string,
  ): Promise<{ requestId: string }> {
    published.publish({ operation: 'openRequest' });

    const existing = this.byKey.get(idempotencyKey);
    if (existing !== undefined) return { requestId: existing };
    if (!this.caseIds.includes(input.caseId)) throw new CaseNotFoundError(input.caseId);

    this.sequence += 1;
    const requestId = `RR-${String(this.sequence).padStart(6, '0')}`;
    this.requests.set(requestId, {
      requestId,
      caseId: input.caseId,
      documents: [...input.documents],
      dueInDays: input.dueInDays,
      status: 'open',
    });
    this.byKey.set(idempotencyKey, requestId);
    return { requestId };
  }

  async withdrawRequest(requestId: string, _idempotencyKey: string): Promise<void> {
    published.publish({ operation: 'withdrawRequest' });

    const request = this.requests.get(requestId);
    if (request === undefined) throw new RecordsRequestNotFoundError(requestId);
    if (request.status === 'withdrawn') return;
    this.requests.set(requestId, { ...request, status: 'withdrawn' });
  }

  openRequests(caseId: string): readonly RecordsRequest[] {
    return [...this.requests.values()].filter(
      (request) => request.caseId === caseId && request.status === 'open',
    );
  }
}
