import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GOOGLE_API_KEY_PATTERN } from './redact.js';
import { decodeFloat32Base64, encodeFloat32Base64 } from './vector.js';
import { CassetteSchema } from './types.js';

/**
 * The committed cassette set, scanned for anything key-shaped.
 *
 * The path is resolved rather than imported on purpose. Cassettes live beside
 * the dataset they were recorded against, in `@repo/eval-harness`, and this
 * package must not depend on that one — the zero-repository-dependency rule is
 * an acceptance criterion, and reaching for `EVAL_DATASETS_DIR` to make one
 * test tidier is exactly how it would be lost. `../../` lands on `packages/`
 * from `src` and from `dist` alike.
 *
 * The set was recorded on 2026-09-10 at `021c6f2`, one trial of each of the two
 * tasks, on model `live` / memory `live`. The specs below assert against the
 * files rather than against a fixture, because a fixture cannot be the thing
 * that leaks.
 */
const CASSETTE_DIR = fileURLToPath(
  new URL('../../eval-harness/datasets/memory-recall/cassettes', import.meta.url),
);

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Under this, a cassette stops being a thing anyone wants in a git history. */
const SIZE_LIMIT_BYTES = 128 * 1024;

describe('the committed cassette set', () => {
  const files = filesUnder(CASSETTE_DIR);

  it('is not empty, or every spec below passes by having nothing to look at', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('carries no Google API key', () => {
    const offenders = files.filter((file) =>
      new RegExp(GOOGLE_API_KEY_PATTERN.source).test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('is made entirely of .json cassettes', () => {
    // `loadSuite` parses every `.json` in the dataset directory as a task spec,
    // which is why the cassettes are in a subdirectory in the first place.
    // Anything in here that is not a cassette is a thing nobody meant to commit.
    expect(files.filter((file) => !file.endsWith('.json'))).toEqual([]);
  });

  it('keeps every recorded trial under 128 KB', () => {
    // The reason vectors are base64 float32 rather than JSON float arrays. At
    // 16,345 bytes a vector as JSON, one trial's embeddings alone would be over
    // three times this limit.
    const oversized = files.filter((file) => statSync(file).size > SIZE_LIMIT_BYTES);

    expect(oversized).toEqual([]);
  });

  it('was recorded on the live model axis, which is the only axis worth recording', () => {
    for (const file of files) {
      const cassette = CassetteSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      expect(cassette.header.axes).toEqual({ model: 'live', memory: 'live' });
      expect(cassette.decisions.length).toBeGreaterThan(0);
    }
  });

  it('round-trips its recorded vectors through base64 float32 with equality', () => {
    const vectors = files
      .flatMap((file) => CassetteSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).decisions)
      .flatMap((decision) =>
        decision.response.kind === 'vector' ? [decision.response.float32Base64] : [],
      );

    expect(vectors.length).toBeGreaterThan(0);
    for (const encoded of vectors) {
      // Re-encoding what was decoded reproduces the recorded bytes: the values
      // in the file are already float32, so nothing rounds a second time.
      expect(encodeFloat32Base64(decodeFloat32Base64(encoded))).toBe(encoded);
    }
  });
});
