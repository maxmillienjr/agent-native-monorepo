/**
 * Injection tokens for the memory adapters.
 *
 * Explicit tokens rather than class references because these are interfaces
 * with no runtime value to infer, and because `yarn dev` runs through tsx:
 * esbuild does not implement `emitDecoratorMetadata`, so Nest has no
 * `design:paramtypes` for an implicit constructor parameter and injects
 * `undefined` — on the dev path only, where `tsc` is not involved. See
 * `.context/conventions.md`.
 */
export const MEMORY_CONFIG = 'MEMORY_CONFIG';
export const PG_POOL = 'PG_POOL';
export const NEO4J_DRIVER = 'NEO4J_DRIVER';
export const EPISODIC_REPOSITORY = 'EPISODIC_REPOSITORY';
export const NEO4J_WRITER = 'NEO4J_WRITER';
export const PGVECTOR_WRITER = 'PGVECTOR_WRITER';
export const RETRIEVAL_FACADE = 'RETRIEVAL_FACADE';
export const CHECKPOINTER = 'CHECKPOINTER';
/** The run record (P3-B). Not a memory tier; provided here because it shares the pool. */
export const RUN_RECORDS = 'RUN_RECORDS';
export const CASE_REPOSITORY = 'CASE_REPOSITORY';
