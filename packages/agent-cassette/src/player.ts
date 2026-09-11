import { z } from 'zod';
import { canonicalJson, decisionKey, requestHash } from './hash.js';
import { decodeFloat32Base64 } from './vector.js';
import {
  CassetteSchema,
  type Cassette,
  type Decision,
  type DecisionCall,
  type Deck,
  type ReplayConfig,
  type Seam,
} from './types.js';

/**
 * Replay refused before the first decision is served.
 *
 * Every reason is collected rather than the first one thrown, because a
 * cassette recorded against an older configuration usually differs in more
 * than one field and finding that out one run at a time is the expensive way.
 */
export class CassetteIncompatibleError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(
      `cassette cannot be replayed: ${reasons.length} incompatibility(ies).\n` +
        reasons.map((reason) => `  - ${reason}`).join('\n'),
    );
    this.name = 'CassetteIncompatibleError';
  }
}

/**
 * A decision the cassette does not have.
 *
 * The message carries the diff because the overwhelmingly common cause is a
 * prompt edit, which moves the request hash and misses every entry at that
 * seam. That is the design working rather than a defect — a scheme that
 * normalised the prompt away would serve the old answer to the new prompt and
 * call it a pass — so the cost of it has to be a legible one: see what moved,
 * re-record.
 */
export class CassetteMissError extends Error {
  constructor(
    readonly seam: Seam,
    readonly label: string | undefined,
    readonly missedRequestHash: string,
    readonly diff: string,
  ) {
    super(
      `cassette miss at seam \`${seam}\`${label === undefined ? '' : ` (label \`${label}\`)`}: ` +
        `no unconsumed decision for request hash ${missedRequestHash}.\n` +
        `recorded (-) against actual (+):\n${diff}`,
    );
    this.name = 'CassetteMissError';
  }
}

/**
 * A recorded failure, thrown again on replay.
 *
 * A run that failed live has to replay as failing, or a cassette set can only
 * encode happy paths — and `IO_RETRY` re-runs a throwing node with the same
 * input, so attempt 1's error and attempt 2's success are two entries under one
 * hash and replay reproduces the retry.
 */
export class ReplayedError extends Error {
  constructor(
    name: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = name;
  }
}

/**
 * Enough of the header to say precisely what is wrong with it.
 *
 * `CassetteSchema` would reject a `formatVersion` of 2 or an `axes.model` of
 * `stub` on its own, but as a Zod issue on `header.formatVersion` — accurate
 * and unreadable. Peeking first is what turns that into one sentence.
 */
const HeaderPeekSchema = z
  .object({
    header: z
      .object({
        formatVersion: z.unknown(),
        axes: z.object({ model: z.unknown() }).partial().optional(),
      })
      .partial()
      .optional(),
  })
  .partial();

export class CassettePlayer implements Deck {
  readonly mode = 'replay';

  private readonly cassette: Cassette;
  private readonly queues = new Map<string, Decision[]>();
  private readonly bySeam = new Map<string, Decision[]>();
  private readonly consumed = new Set<Decision>();

  constructor(cassette: unknown, config: ReplayConfig) {
    this.cassette = parseForReplay(cassette, config);

    for (const decision of this.cassette.decisions) {
      const key = decisionKey(decision.seam, decision.label, decision.requestHash);
      pushInto(this.queues, key, decision);
      pushInto(this.bySeam, seamKey(decision.seam, decision.label), decision);
    }
  }

  get header(): Cassette['header'] {
    return this.cassette.header;
  }

  /** How many recorded decisions are still unconsumed. The wiring reports it. */
  remaining(): number {
    return this.cassette.decisions.length - this.consumed.size;
  }

  /**
   * `live` is accepted to satisfy `Deck` and is never called. In replay the
   * wiring constructs no model client at all, so there is nothing behind it to
   * fall through to; ignoring it here is the second half of that guarantee.
   */
  async resolve<R>(call: DecisionCall, _live: () => Promise<R>): Promise<R> {
    const hash = requestHash(call);
    const queue = this.queues.get(decisionKey(call.seam, call.label, hash));
    const decision = queue?.shift();

    if (decision === undefined) {
      throw new CassetteMissError(call.seam, call.label, hash, this.missDiff(call));
    }

    this.consumed.add(decision);
    return replayResponse<R>(decision);
  }

  /**
   * The nearest recorded request at the same seam: the next one that has not
   * been served yet, or failing that the last one recorded. Either is a better
   * thing to diff against than nothing, and which of the two it is does not
   * change what the reader has to do about it.
   */
  private missDiff(call: DecisionCall): string {
    const recorded = this.bySeam.get(seamKey(call.seam, call.label)) ?? [];
    const nearest = recorded.find((entry) => !this.consumed.has(entry)) ?? recorded.at(-1);

    if (nearest === undefined) {
      return `  (no decision was recorded at this seam)\n${prefixLines(pretty(call.request), '+ ')}`;
    }

    return diffLines(pretty(nearest.request), pretty(call.request));
  }
}

function parseForReplay(cassette: unknown, config: ReplayConfig): Cassette {
  const peek = HeaderPeekSchema.safeParse(cassette);
  const header = peek.success ? peek.data.header : undefined;

  if (header?.formatVersion !== undefined && header.formatVersion !== 1) {
    throw new CassetteIncompatibleError([
      `formatVersion is ${canonicalJson(header.formatVersion)}, this player reads 1`,
    ]);
  }

  if (header?.axes?.model !== undefined && header.axes.model !== 'live') {
    throw new CassetteIncompatibleError([
      `header records model axis ${canonicalJson(header.axes.model)}, ` +
        'and a cassette recorded off the live model axis is a fake of a fake',
    ]);
  }

  const parsed = CassetteSchema.safeParse(cassette);
  if (!parsed.success) {
    throw new CassetteIncompatibleError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }

  const reasons = configMismatches(parsed.data.header, config);
  if (reasons.length > 0) throw new CassetteIncompatibleError(reasons);

  return parsed.data;
}

function configMismatches(header: Cassette['header'], config: ReplayConfig): string[] {
  const reasons: string[] = [];

  if (header.chatModel !== config.chatModel) {
    reasons.push(
      `chatModel is \`${header.chatModel}\`, running configuration is \`${config.chatModel}\``,
    );
  }
  if (header.embeddingModel !== config.embeddingModel) {
    reasons.push(
      `embeddingModel is \`${header.embeddingModel}\`, running configuration is \`${config.embeddingModel}\``,
    );
  }
  if (header.embeddingDimensions !== config.embeddingDimensions) {
    reasons.push(
      `embeddingDimensions is ${header.embeddingDimensions}, ` +
        `running configuration is ${config.embeddingDimensions}`,
    );
  }

  return reasons;
}

/**
 * The cast is where the recorded shape becomes the caller's type again. A
 * cassette is parsed against `CassetteSchema` and nothing narrower — the
 * package deliberately knows nothing about what a plan or an extraction looks
 * like — so this is the one place the seam's own type is taken on trust.
 */
function replayResponse<R>(decision: Decision): R {
  const response = decision.response;

  if (response.kind === 'error') {
    throw new ReplayedError(response.name, response.message, response.status);
  }
  if (response.kind === 'vector') {
    return decodeFloat32Base64(response.float32Base64) as R;
  }
  return response.value as R;
}

function seamKey(seam: Seam, label: string | undefined): string {
  return `${seam} ${label ?? ''}`;
}

function pushInto(map: Map<string, Decision[]>, key: string, decision: Decision): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [decision]);
  else existing.push(decision);
}

function pretty(value: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/** Beyond this the diff stops being something a human reads and the cost of the DP matters. */
const DIFF_LINE_CAP = 400;

/**
 * A line diff over the two canonical renderings, longest-common-subsequence
 * for the small case and positional for the large one. Both are honest; the
 * second is just noisier, and a cassette miss on a 400-line request is a
 * re-record either way.
 */
export function diffLines(recorded: string, actual: string): string {
  const left = recorded.split('\n');
  const right = actual.split('\n');

  if (left.length > DIFF_LINE_CAP || right.length > DIFF_LINE_CAP) {
    const rows: string[] = [];
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      if (left[i] === right[i]) continue;
      if (left[i] !== undefined) rows.push(`- ${left[i]}`);
      if (right[i] !== undefined) rows.push(`+ ${right[i]}`);
    }
    return rows.join('\n');
  }

  // lcs[i][j] = length of the longest common subsequence of left[i..] and right[j..].
  const lcs: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i]![j]! =
        left[i] === right[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      rows.push(`  ${left[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push(`- ${left[i]}`);
      i += 1;
    } else {
      rows.push(`+ ${right[j]}`);
      j += 1;
    }
  }
  for (; i < left.length; i += 1) rows.push(`- ${left[i]}`);
  for (; j < right.length; j += 1) rows.push(`+ ${right[j]}`);

  return rows.join('\n');
}
