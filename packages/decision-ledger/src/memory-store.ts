import {
  LedgerPayloadSchema,
  type LedgerAnchor,
  type LedgerEntry,
  type LedgerPayloadRow,
  type LedgerRows,
} from './entry.js';
import type { LedgerStore, LedgerTransaction } from './ledger.js';
import { ChainState } from './rules.js';

/**
 * A `LedgerStore` held in memory: the unit tests' store, serialised by a
 * promise chain where Postgres uses an advisory lock. It folds the whole chain
 * for every judgement, which is what the Postgres store's narrower query must
 * agree with. Nothing in the service constructs it.
 */
export class InMemoryLedgerStore implements LedgerStore {
  readonly entries: LedgerEntry[] = [];
  readonly payloads = new Map<string, LedgerPayloadRow>();
  readonly anchors: LedgerAnchor[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => work(this.tx()));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async readRows(): Promise<LedgerRows> {
    return {
      entries: [...this.entries],
      payloads: [...this.payloads.values()],
      anchors: [...this.anchors],
    };
  }

  async insertAnchor(anchor: LedgerAnchor): Promise<void> {
    if (this.anchors.some((existing) => existing.seq === anchor.seq)) {
      throw new Error(`seq ${anchor.seq} is already anchored`);
    }
    this.anchors.push(anchor);
  }

  private tx(): LedgerTransaction {
    return {
      head: async () => this.entries.at(-1) ?? null,
      byEntryId: async (entryId) => {
        const entry = this.entries.find((candidate) => candidate.entryId === entryId);
        return entry === undefined ? null : { entry, payload: this.payloads.get(entryId) ?? null };
      },
      stateFor: async () => {
        const state = new ChainState();
        for (const entry of this.entries) {
          const row = this.payloads.get(entry.entryId);
          if (row === undefined) state.applyWithheld(entry.seq, entry.kind);
          else state.apply(entry.seq, LedgerPayloadSchema.parse(JSON.parse(row.payload)));
        }
        return state;
      },
      insert: async (entry, payload) => {
        this.entries.push(entry);
        this.payloads.set(entry.entryId, payload);
      },
    };
  }
}
