import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * A hash of the whole source tree as it is on disk — uncommitted and
 * untracked files included, git-ignored ones not — leaving out the results
 * and the accepted baselines (`excluded`), which testing and reviewing
 * write to, and the files SHOTEST_IGNORE names as ones no test depends on.
 * A test that passed on this very tree need not run again (see cache.ts),
 * and a result from another tree is outdated. Undefined outside a git work
 * tree.
 *
 * git does the hashing, into a scratch index: a copy of the real one, so
 * that files whose stat data is unchanged need not be read again.
 */
export function sourceTreeHash(excluded: string[]): string | undefined {
  const index = path.join(tmpdir(), `shotest-index-${process.pid}`);
  const git = (args: string[]) => execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_INDEX_FILE: index },
  }).trim();
  try {
    try {
      copyFileSync(git(['rev-parse', '--path-format=absolute', '--git-path', 'index']), index);
    } catch { } // no commits yet: start from an empty index
    // Not an exclude pathspec on the add: naming an ignored directory (as
    // test-results/ is, as a rule) there makes it fail.
    git(['add', '-A', '--', ':/']);
    const ignored = process.env.SHOTEST_IGNORE?.split(path.delimiter).filter(Boolean) ?? [];
    git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...excluded, ...ignored]);
    return git(['write-tree']);
  } catch {
    return undefined;
  } finally {
    rmSync(index, { force: true });
  }
}
