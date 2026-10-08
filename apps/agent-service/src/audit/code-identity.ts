import { execFileSync } from 'node:child_process';

/** The commit HEAD names, and whether the tree it was read from was clean. */
export function gitHead(): { sha: string; dirty: boolean } {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  return { sha, dirty: status !== '' };
}
