import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GOOGLE_API_KEY_PATTERN } from './redact.js';

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
 * The directory does not exist yet: recording the set needs a live key and a
 * quota that the free tier does not cover in a day, and it lands with the eval
 * wiring. An empty scan is reported rather than skipped silently, so the day
 * the first cassette is committed this test starts meaning something without
 * anyone having to remember it.
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

describe('the committed cassette set', () => {
  const files = filesUnder(CASSETTE_DIR);

  it('carries no Google API key', () => {
    const offenders = files.filter((file) =>
      new RegExp(GOOGLE_API_KEY_PATTERN.source).test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
  });

  it('is either absent or made entirely of .json cassettes', () => {
    // `loadSuite` parses every `.json` in the dataset directory as a task spec,
    // which is why the cassettes are in a subdirectory in the first place.
    // Anything in here that is not a cassette is a thing nobody meant to commit.
    expect(files.filter((file) => !file.endsWith('.json'))).toEqual([]);
  });
});
