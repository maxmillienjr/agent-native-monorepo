import { z } from 'zod';
import {
  LedgerAnchorSchema,
  LedgerEntrySchema,
  LedgerPayloadRowSchema,
  type LedgerRows,
} from './entry.js';

/**
 * The ledger as JSON Lines, one entry per line with its payload and anchor
 * when it has them: what an operator hands an auditor, and what
 * `ledger:verify --chain-only --export <file>` reads with no database.
 *
 * An export may omit every payload and still verify checks 1, 2 and 5 —
 * the chain and its anchors disclose nothing, because the commitments are
 * salted.
 */

const LineSchema = z
  .object({
    entry: LedgerEntrySchema,
    payload: LedgerPayloadRowSchema.omit({ entryId: true }).nullable(),
    anchor: LedgerAnchorSchema.omit({ seq: true }).nullable(),
  })
  .strict();

export function toJsonl(rows: LedgerRows, options: { readonly payloads?: boolean } = {}): string {
  const payloads = new Map(rows.payloads.map((row) => [row.entryId, row]));
  const anchors = new Map(rows.anchors.map((anchor) => [anchor.seq, anchor]));
  return [...rows.entries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => {
      const payload = options.payloads === false ? undefined : payloads.get(entry.entryId);
      const anchor = anchors.get(entry.seq);
      return JSON.stringify({
        entry,
        payload: payload === undefined ? null : { salt: payload.salt, payload: payload.payload },
        anchor:
          anchor === undefined
            ? null
            : { tsaUrl: anchor.tsaUrl, token: anchor.token, anchoredAt: anchor.anchoredAt },
      });
    })
    .map((line) => `${line}\n`)
    .join('');
}

export function fromJsonl(text: string): LedgerRows {
  const entries: LedgerRows['entries'][number][] = [];
  const payloads: LedgerRows['payloads'][number][] = [];
  const anchors: LedgerRows['anchors'][number][] = [];

  text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .forEach((line, index) => {
      const parsed = LineSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(
          `line ${index + 1} is not a ledger export line: ${parsed.error.issues[0]?.message}`,
        );
      }
      const { entry, payload, anchor } = parsed.data;
      entries.push(entry);
      if (payload !== null) payloads.push({ entryId: entry.entryId, ...payload });
      if (anchor !== null) anchors.push({ seq: entry.seq, ...anchor });
    });

  return { entries, payloads, anchors };
}
