/**
 * Injection tokens for the ledger axis (P3-C). Explicit strings, for the
 * reason `memory/memory.tokens.ts` gives: the dev path runs through tsx,
 * which emits no decorator metadata.
 */
export const LEDGER_CONFIG = 'LEDGER_CONFIG';
export const LEDGER_POOL = 'LEDGER_POOL';
/** The service's `RunLedger`, or `null` on the unconfigured ledger axis. */
export const RUN_LEDGER = 'RUN_LEDGER';
