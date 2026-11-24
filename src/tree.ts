import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * A hash of the whole source tree as it is on disk — uncommitted and
 * untracked files included, git-ignored ones not — leaving out the results
 * and the accepted baselines (`excluded`), which testing and reviewing
 * write to, and the files SHOTEST_IGNORE names as ones no test depends on.
 * A test that passed on this very tree need not run again (see cache.ts),
 * and a result from another tree is outdated. Undefined outside a git work
 * tree, or where git refuses the repository (which it warns about).
 *
 * git does the hashing, into a scratch index and object directory, leaving
 * the repository untouched: the index a copy of the real one, so that files
 * whose stat data is unchanged need not be read again.
 */
export function sourceTreeHash(excluded: string[]): string | undefined {
  const scratch = mkdtempSync(path.join(tmpdir(), 'shotest-tree-'));
  const index = path.join(scratch, 'index');
  const git = (args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  }).trim();
  try {
    const gitPath = (name: string) => git(['rev-parse', '--path-format=absolute', '--git-path', name]);
    const env = {
      ...process.env,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: gitPath('objects'),
    };
    try {
      copyFileSync(gitPath('index'), index);
    } catch { } // no commits yet: start from an empty index
    // Not an exclude pathspec on the add: naming an ignored directory (as
    // test-results/ is, as a rule) there makes it fail. Minimal stat checks:
    // in a container, files' owners (and inodes or devices) can differ from
    // what the index has, which would have git read every file again.
    git(['-c', 'core.checkStat=minimal', 'add', '-A', '--', ':/'], env);
    const ignored = process.env.SHOTEST_IGNORE?.split(path.delimiter).filter(Boolean) ?? [];
    git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...excluded, ...ignored], env);
    return git(['write-tree'], env);
  } catch (error) {
    const message = String((error as { stderr?: string }).stderr ?? error).trim();
    if (!message.includes('not a git repository')) {
      console.warn(`ShoTest: cannot hash the source tree, so the result cache goes unused:\n${message}`);
    }
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
