/**
 * `@repo/agent-cassette` — decision-level record and replay for evaluation
 * trials.
 *
 * The package is the format, the hash, the recorder and the player. It is not
 * wired to anything: turning a `Deck` into the model half of a dependency set
 * is `apps/agent-service/src/eval/cassette-deps.ts`, and reading
 * `EVAL_CASSETTE_MODE` is the harness's. That separation is what keeps the one
 * runtime dependency `zod` and keeps the package liftable out of this
 * repository whole.
 */
export {
  SEAMS,
  VECTOR_SEAM,
  CassetteHeaderSchema,
  CassetteSchema,
  DecisionSchema,
  DecisionResponseSchema,
  type Cassette,
  type CassetteHeader,
  type Decision,
  type DecisionCall,
  type DecisionResponse,
  type Deck,
  type RecordedAxes,
  type ReplayConfig,
  type Seam,
  type TokenCounts,
} from './types.js';

export { canonicalJson, decisionKey, requestHash } from './hash.js';
export { decodeFloat32Base64, encodeFloat32Base64, isNumberVector } from './vector.js';
export {
  GOOGLE_API_KEY_PATTERN,
  REDACTED,
  containsSecret,
  redactDeep,
  redactString,
} from './redact.js';
export { CassetteRecorder, CassetteRecordRefusedError, type RecorderOptions } from './recorder.js';
export {
  CassetteIncompatibleError,
  CassetteMissError,
  CassettePlayer,
  ReplayedError,
  diffLines,
} from './player.js';
