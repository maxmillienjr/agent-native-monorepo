import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LedgerAnchor, LedgerEntry } from './entry.js';
import type { Ledger } from './ledger.js';

/**
 * RFC 3161 anchoring, through the `openssl` binary.
 *
 * No SDK and no ASN.1 dependency: OpenSSL builds the request, and reads and
 * verifies the response, including the CMS signature and the signer's
 * critical `timeStamping` extended key usage. The authority sees only the
 * head's hash — RFC 3161 §2.1 requires it "not to examine the imprint being
 * time-stamped in any way" — so anchoring discloses nothing.
 *
 * A token is the commitment that leaves the logger (Crosby and Wallach §2.2):
 * a rewrite of any entry at or before an anchored seq changes that seq's hash,
 * and the token no longer verifies against it. Entries after the last anchor
 * are the window a database administrator can rewrite undetected, which the
 * PRD states as the limit.
 */

const run = promisify(execFile);

/** The OpenSSL binary; `LEDGER_OPENSSL` overrides it, for a host where it is not on the path. */
function opensslBinary(): string {
  return process.env['LEDGER_OPENSSL'] ?? 'openssl';
}

async function openssl(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await run(opensslBinary(), [...args], { encoding: 'utf8' });
  return { stdout, stderr };
}

async function withScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-tsa-'));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

/**
 * A DER `TimeStampReq` over a SHA-256 hash, asking for the signer's
 * certificate in the token (`-cert`), so a verifier needs only the CA.
 */
export async function timestampQuery(hashHex: string): Promise<Buffer> {
  if (!HEX_32_BYTES.test(hashHex)) throw new RangeError('a SHA-256 hash, lower-case hex');
  return withScratch(async (dir) => {
    const out = join(dir, 'request.tsq');
    await openssl(['ts', '-query', '-digest', hashHex, '-sha256', '-cert', '-out', out]);
    return readFile(out);
  });
}

/** POSTs a request to a time-stamping authority, as RFC 3161 §3.4 describes the HTTP transport. */
export async function requestTimestamp(
  tsaUrl: string,
  query: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const response = await fetchImpl(tsaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: new Uint8Array(query),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `the time-stamping authority answered ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/** What a response says about itself, before anyone trusts it. */
export interface TimestampInfo {
  readonly granted: boolean;
  readonly status: string;
  readonly genTime: Date | null;
}

export async function inspectTimestamp(token: Buffer): Promise<TimestampInfo> {
  return withScratch(async (dir) => {
    const file = join(dir, 'response.tsr');
    await writeFile(file, token);
    const { stdout } = await openssl(['ts', '-reply', '-in', file, '-text']);
    const status = /^Status: (.+)$/m.exec(stdout)?.[1]?.trim() ?? 'unknown';
    const stamp = /^Time stamp: (.+)$/m.exec(stdout)?.[1]?.trim();
    return {
      granted: /^Granted/i.test(status),
      status,
      genTime: stamp === undefined ? null : parseOpenSslTime(stamp),
    };
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Oct  8 20:15:42 2026 GMT`, optionally with fractional seconds, as OpenSSL prints a GeneralizedTime. */
export function parseOpenSslTime(text: string): Date | null {
  const match = /^(\w{3})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? (\d{4}) GMT$/.exec(text);
  if (match === null) return null;
  const [, month, day, hours, minutes, seconds, fraction, year] = match;
  const monthIndex = MONTHS.indexOf(month ?? '');
  if (monthIndex < 0) return null;
  const millis = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  return new Date(
    Date.UTC(
      Number(year),
      monthIndex,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
      millis,
    ),
  );
}

export interface TimestampVerification {
  readonly ok: boolean;
  /** OpenSSL's own words: `Verification: OK`, or why not — `message imprint mismatch`, an untrusted signer. */
  readonly detail: string;
}

/**
 * Whether `token` is a valid response from an authority `caFile` vouches for,
 * over exactly `hashHex`. A token over different data fails with OpenSSL's
 * `message imprint mismatch`.
 */
export async function verifyTimestamp(
  token: Buffer,
  hashHex: string,
  caFile: string,
): Promise<TimestampVerification> {
  if (!HEX_32_BYTES.test(hashHex)) return { ok: false, detail: 'not a SHA-256 hash' };
  return withScratch(async (dir) => {
    const file = join(dir, 'response.tsr');
    await writeFile(file, token);
    try {
      const { stdout } = await openssl([
        'ts',
        '-verify',
        '-digest',
        hashHex,
        '-in',
        file,
        '-CAfile',
        caFile,
      ]);
      return { ok: /Verification: OK/.test(stdout), detail: stdout.trim() };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; message?: string };
      const detail =
        `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`.trim() || failed.message || 'failed';
      return { ok: false, detail: summarise(detail) };
    }
  });
}

/**
 * Why OpenSSL refused, in its own words: the reason field of the last error
 * line it printed (`message imprint mismatch`, `certificate verify error`),
 * skipping the configuration-include noise some distributions add.
 */
function summarise(detail: string): string {
  const reasons = detail
    .split('\n')
    .filter((line) => !line.includes('process_include'))
    .map((line) => /:error:[0-9A-F]+:[^:]*:[^:]*:([^:]+):/.exec(line)?.[1]?.trim())
    .filter((reason): reason is string => reason !== undefined && reason !== '');
  return reasons.at(-1) ?? (detail.split('\n').find((line) => line.trim() !== '') ?? detail).trim();
}

export interface AnchorOptions {
  readonly tsaUrl: string;
  /** When given, the token is verified before it is stored. */
  readonly caFile?: string;
  readonly fetch?: typeof fetch;
}

export type AnchorResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'already-anchored'; readonly anchor: LedgerAnchor }
  | { readonly kind: 'anchored'; readonly anchor: LedgerAnchor; readonly entry: LedgerEntry };

/**
 * `ledger:anchor`: time-stamps the head's `entry_hash` and stores the token.
 * A head that is already anchored is left alone; an empty ledger has nothing
 * to anchor. A response that is not `granted`, or that fails verification
 * when a CA is given, is refused rather than stored.
 */
export async function anchorHead(ledger: Ledger, options: AnchorOptions): Promise<AnchorResult> {
  const rows = await ledger.readRows();
  const head = rows.entries.at(-1);
  if (head === undefined) return { kind: 'empty' };
  const existing = rows.anchors.find((anchor) => anchor.seq === head.seq);
  if (existing !== undefined) return { kind: 'already-anchored', anchor: existing };

  const query = await timestampQuery(head.entryHash);
  const token = await requestTimestamp(options.tsaUrl, query, options.fetch);
  const info = await inspectTimestamp(token);
  if (!info.granted)
    throw new Error(`the time-stamping authority did not grant the request: ${info.status}`);
  if (options.caFile !== undefined) {
    const verified = await verifyTimestamp(token, head.entryHash, options.caFile);
    if (!verified.ok) throw new Error(`the token does not verify: ${verified.detail}`);
  }

  const anchor: LedgerAnchor = {
    seq: head.seq,
    tsaUrl: options.tsaUrl,
    token: token.toString('base64'),
    anchoredAt: (info.genTime ?? new Date()).toISOString(),
  };
  await ledger.store.insertAnchor(anchor);
  return { kind: 'anchored', anchor, entry: head };
}

/** The first anchor that fails: its seq is the failure's. */
export interface AnchorFailure {
  readonly seq: number;
  readonly reason: string;
}

/**
 * Check 5: every anchor names an entry, and its token verifies against the CA
 * and imprints that entry's hash.
 */
export async function verifyAnchors(
  entries: readonly Pick<LedgerEntry, 'seq' | 'entryHash'>[],
  anchors: readonly LedgerAnchor[],
  caFile: string,
): Promise<AnchorFailure | null> {
  const hashes = new Map(entries.map((entry) => [entry.seq, entry.entryHash]));
  for (const anchor of [...anchors].sort((a, b) => a.seq - b.seq)) {
    const hash = hashes.get(anchor.seq);
    if (hash === undefined) {
      return {
        seq: anchor.seq,
        reason: `an anchor names seq ${anchor.seq}, which the chain does not hold`,
      };
    }
    const verified = await verifyTimestamp(Buffer.from(anchor.token, 'base64'), hash, caFile);
    if (!verified.ok) {
      return {
        seq: anchor.seq,
        reason: `the token from ${anchor.tsaUrl} does not verify against seq ${anchor.seq}'s entry_hash: ${verified.detail}`,
      };
    }
  }
  return null;
}
