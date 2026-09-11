import { requestHash } from './hash.js';
import { redactDeep, redactString } from './redact.js';
import { encodeFloat32Base64, isNumberVector } from './vector.js';
import {
  CassetteHeaderSchema,
  CassetteSchema,
  VECTOR_SEAM,
  type Cassette,
  type CassetteHeader,
  type Decision,
  type DecisionCall,
  type DecisionResponse,
  type Deck,
  type RecordedAxes,
  type Seam,
  type TokenCounts,
} from './types.js';

/**
 * Recording refused, before anything is written.
 *
 * A cassette records what the live system did. Recording the canned stub set
 * would produce a file that is schema-valid, replays cleanly, and measures
 * nothing — the exact failure the eval harness exists to prevent, with an
 * artifact committed to make it durable.
 */
export class CassetteRecordRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`cassette recording refused: ${reason}`);
    this.name = 'CassetteRecordRefusedError';
  }
}

export interface RecorderOptions {
  /**
   * Parsed against `CassetteHeaderSchema`, whose `axes` are two literals. The
   * axes arrive as data because `detectAxes` lives in `@repo/eval-harness` and
   * this package does not depend on it; the caller is what reads the
   * environment.
   */
  readonly header: unknown;
  /**
   * Where the finished cassette goes, called once by `close`. The package does
   * no file I/O of its own: a sink keeps it free of a path convention that
   * belongs to the harness.
   */
  readonly sink?: (cassette: Cassette) => Promise<void> | void;
  /**
   * Token counts for a seam's response, when the caller can get at them. The
   * `Deck` signature deliberately has no room for a hint, so this is where a
   * client that knows how to read its own usage metadata says so. P1-F is what
   * consumes them; recording them now is free.
   */
  readonly tokenCountsFor?: (call: DecisionCall, response: unknown) => TokenCounts | undefined;
  /** Injectable clock, so a test can assert a latency without waiting for one. */
  readonly now?: () => number;
}

export class CassetteRecorder implements Deck {
  readonly mode = 'record';

  private readonly cassetteHeader: CassetteHeader;
  private readonly decisions: Decision[] = [];
  private readonly options: RecorderOptions;
  private readonly now: () => number;
  private closed = false;

  constructor(options: RecorderOptions) {
    this.cassetteHeader = parseHeader(options.header);
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get header(): CassetteHeader {
    return this.cassetteHeader;
  }

  async resolve<R>(call: DecisionCall, live: () => Promise<R>): Promise<R> {
    if (this.closed) {
      throw new CassetteRecordRefusedError(
        'the recorder is closed and cannot take another decision',
      );
    }

    const startedAt = this.now();

    try {
      const result = await live();
      this.append(call, encodeResponse(call.seam, result), this.now() - startedAt, {
        call,
        result,
      });
      return result;
    } catch (error) {
      // Recorded and then re-thrown: the run has to fail the same way it would
      // have failed live, or the cassette encodes a happy path that never
      // happened. `IO_RETRY` re-running the node is what makes the next entry
      // under this hash the successful attempt.
      this.append(call, encodeError(error), this.now() - startedAt);
      throw error;
    }
  }

  /** Everything recorded so far, validated. Mostly a test's way in. */
  toCassette(): Cassette {
    return CassetteSchema.parse({ header: this.cassetteHeader, decisions: this.decisions });
  }

  /**
   * Finalises the cassette and hands it to the sink. Idempotent by refusal
   * rather than by silence: closing twice would otherwise write twice and the
   * second write is the one nobody expected.
   */
  async close(): Promise<Cassette> {
    if (this.closed) throw new CassetteRecordRefusedError('already closed');
    this.closed = true;

    const cassette = this.toCassette();
    await this.options.sink?.(cassette);
    return cassette;
  }

  private append(
    call: DecisionCall,
    response: DecisionResponse,
    latencyMs: number,
    counted?: { call: DecisionCall; result: unknown },
  ): void {
    const decision: Decision = {
      seam: call.seam,
      requestHash: requestHash(call),
      // The request is kept for the miss diff and never for lookup, so
      // redacting it cannot move a hash.
      request: redactDeep(call.request),
      response,
      latencyMs: Math.max(0, latencyMs),
    };

    if (call.label !== undefined) decision.label = call.label;

    const tokenCounts =
      counted === undefined
        ? undefined
        : this.options.tokenCountsFor?.(counted.call, counted.result);
    if (tokenCounts !== undefined) decision.tokenCounts = tokenCounts;

    this.decisions.push(decision);
  }
}

function parseHeader(header: unknown): CassetteHeader {
  const parsed = CassetteHeaderSchema.safeParse(header);
  if (parsed.success) return parsed.data;

  const axisIssue = parsed.error.issues.find((issue) => issue.path[0] === 'axes');
  if (axisIssue !== undefined) {
    throw new CassetteRecordRefusedError(
      `${describeAxes(header)} is not a live run, and recording anything but a live model is a fake of a fake`,
    );
  }

  throw new CassetteRecordRefusedError(
    `header is invalid — ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')}`,
  );
}

/**
 * The axis refusal in the caller's own words, so the message names what was
 * actually detected rather than restating the schema.
 */
function describeAxes(header: unknown): string {
  const axes = (header as { axes?: Partial<RecordedAxes> } | null | undefined)?.axes;
  return `model=${axes?.model ?? '<missing>'} memory=${axes?.memory ?? '<missing>'}`;
}

function encodeResponse(seam: Seam, result: unknown): DecisionResponse {
  if (seam === VECTOR_SEAM && isNumberVector(result)) {
    return { kind: 'vector', float32Base64: encodeFloat32Base64(result) };
  }
  return { kind: 'value', value: redactDeep(result) };
}

/**
 * Only `name`, `message` and `status` survive, after redaction. A Google SDK
 * error can carry the request URL it failed on, and a URL can carry a key;
 * nothing else on the object is worth the risk of finding that out later.
 */
function encodeError(error: unknown): DecisionResponse {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return {
      kind: 'error',
      name: redactString(error.name),
      message: redactString(error.message),
      ...(typeof status === 'number' && Number.isInteger(status) ? { status } : {}),
    };
  }

  return { kind: 'error', name: 'Error', message: redactString(String(error)) };
}
