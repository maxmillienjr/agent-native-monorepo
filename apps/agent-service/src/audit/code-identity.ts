import { execFileSync } from 'node:child_process';
import { GitShaSchema } from '@repo/memory-core';
import { createLogger } from '@repo/telemetry';

const logger = createLogger('code-identity');

/** The commit HEAD names, and whether the tree it was read from was clean. */
export function gitHead(): { sha: string; dirty: boolean } {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  return { sha, dirty: status !== '' };
}

/**
 * Which code is running, as a run record states it (P3-B).
 *
 * `sha` is null when nothing says: a build with no `GIT_SHA` and no `.git`.
 * The record is still kept, and `audit:replay` refuses it by name. `dirty` is
 * null when the sha came from the build argument, which says nothing about
 * the tree it was built from.
 */
export interface CodeIdentity {
  readonly sha: string | null;
  readonly dirty: boolean | null;
  readonly source: 'GIT_SHA' | 'git' | 'none';
}

/**
 * `GIT_SHA` first, because the image carries no `.git` (the Dockerfile copies
 * `dist`, `node_modules` and `packages`) and the build argument is the only
 * thing that names its commit. Under `tsx` or a local `dist` with no variable
 * set, the working tree is asked instead. A `GIT_SHA` that is not a full sha
 * is a misconfigured build: it is ignored, loudly, rather than recorded as if
 * it named a commit.
 */
export function readCodeIdentity(
  env: NodeJS.ProcessEnv = process.env,
  head: () => { sha: string; dirty: boolean } = gitHead,
): CodeIdentity {
  const declared = env['GIT_SHA']?.trim();
  if (declared !== undefined && declared !== '') {
    const parsed = GitShaSchema.safeParse(declared);
    if (parsed.success) return { sha: parsed.data, dirty: null, source: 'GIT_SHA' };
    logger.warn({ msg: 'code-identity.invalid-git-sha', detail: 'GIT_SHA is not a 40-hex sha' });
  }

  try {
    const { sha, dirty } = head();
    const parsed = GitShaSchema.safeParse(sha);
    if (parsed.success) return { sha: parsed.data, dirty, source: 'git' };
  } catch {
    // No git, or no repository: the image's case when GIT_SHA was not passed.
  }

  return { sha: null, dirty: null, source: 'none' };
}

let cached: CodeIdentity | undefined;

/**
 * The running process's identity, read once: it cannot change under a running
 * process, and asking git costs two child processes per run otherwise.
 */
export function codeIdentity(): CodeIdentity {
  return (cached ??= readCodeIdentity());
}
