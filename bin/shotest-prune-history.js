#!/usr/bin/env node
// shotest-prune-history: drop old accepted baselines from git history.
//
// The accepted baselines (test-accepted/, or $SHOTEST_ACCEPTED_DIR) are
// committed, so every accepted change adds images that stay in the repository
// forever, long after the baseline has moved on. Git cannot free them while
// old commits still reference them, and the only way to change what a commit
// references is to rewrite it. That is what this does: every commit reachable
// from a local branch or tag loses the accepted directory, except the last
// --keep commits of each branch (and of a detached HEAD), by default just the
// tip. Commit hashes change from the first affected commit onwards, as after a
// rebase; author, committer, dates, messages and merges are preserved,
// signatures are not.
// Reflogs are then expired and `git gc` prunes what nothing references.
//
// A remote still holds the old history until the rewritten branches are
// force-pushed, so that is both the safety net and the reason the space is
// not fully reclaimed locally until then: remote-tracking refs are left
// alone, and a second run after the push (which then finds nothing to
// rewrite) does the final cleanup.
//
// Plain Node without dependencies or a build step, so it runs from a checkout
// as well as from an installed package.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const usage = `usage: shotest-prune-history [--keep <n>] [--dry-run]

Removes the accepted baseline directory (test-accepted/, or $SHOTEST_ACCEPTED_DIR)
from every commit on every local branch and tag, except the most recent ones of
each branch, and then garbage-collects the repository.

  --keep <n>  how many commits of each branch keep the directory (default: 1,
              the tip)
  --dry-run   report what would be rewritten without changing anything
`;

let dryRun = false;
let keepCount = 1;
const args = process.argv.slice(2);
while (args.length > 0) {
  const arg = args.shift();
  if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--keep' || arg.startsWith('--keep=')) {
    const value = arg === '--keep' ? args.shift() : arg.slice('--keep='.length);
    keepCount = Number(value);
    if (!Number.isInteger(keepCount) || keepCount < 1) {
      process.stderr.write(`shotest-prune-history: --keep needs a positive number, not ${value}\n\n${usage}`);
      process.exit(2);
    }
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(usage);
    process.exit(0);
  } else {
    process.stderr.write(`shotest-prune-history: unknown option ${arg}\n\n${usage}`);
    process.exit(2);
  }
}

function fail(message) {
  process.stderr.write(`shotest-prune-history: ${message}\n`);
  process.exit(1);
}

// Run git; returns stdout as a string, or as a Buffer with {binary: true}.
function git(args, options = {}) {
  const result = spawnSync('git', args, {
    input: options.input,
    env: options.env,
    maxBuffer: 1 << 30,
    encoding: options.binary ? 'buffer' : 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.allowFailure) {
      return null;
    }
    fail(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function shortSha(sha) {
  return sha.slice(0, 10);
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function repoSize() {
  let bytes = 0;
  for (const line of git(['count-objects', '-v']).split('\n')) {
    const match = /^(size|size-pack): (\d+)$/.exec(line);
    if (match) {
      bytes += Number(match[2]) * 1024;
    }
  }
  return bytes;
}

// --- Sanity checks --------------------------------------------------------

const gitDir = git(['rev-parse', '--git-dir'], { allowFailure: true })?.trim();
if (!gitDir) {
  fail('not inside a git repository');
}
if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
  fail('this is a shallow clone; run "git fetch --unshallow" first');
}
for (const state of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) {
  if (existsSync(path.join(gitDir, state))) {
    fail(`a git operation is in progress (${state}); finish or abort it first`);
  }
}

// --- The directory to remove, as a repository-relative path ---------------

const configured = process.env.SHOTEST_ACCEPTED_DIR || 'test-accepted';
let relativeDir;
if (path.isAbsolute(configured)) {
  const top = git(['rev-parse', '--show-toplevel'], { allowFailure: true })?.trim();
  if (!top) {
    fail(`SHOTEST_ACCEPTED_DIR is absolute (${configured}) but there is no working tree to resolve it against`);
  }
  relativeDir = path.relative(top, configured);
} else {
  relativeDir = path.join(git(['rev-parse', '--show-prefix']).trim(), configured);
}
const parts = relativeDir.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
if (parts.length === 0 || parts.includes('..')) {
  fail(`the accepted directory (${configured}) does not lie inside the repository`);
}
const dirPath = parts.join('/');

// --- Refs and commits -----------------------------------------------------

// Every local branch and tag, peeled to the commit it points at. Tags that
// point at something other than a commit are left alone.
const refs = [];
const refLines = git([
  'for-each-ref',
  '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)',
  'refs/heads',
  'refs/tags',
]);
for (const line of refLines.split('\n')) {
  if (!line) {
    continue;
  }
  const [name, sha, type, peeledSha, peeledType] = line.split('\0');
  const commit = type === 'commit' ? sha : peeledType === 'commit' ? peeledSha : null;
  if (commit) {
    refs.push({ name, sha, type, commit });
  }
}
const headBranch = git(['symbolic-ref', '-q', 'HEAD'], { allowFailure: true })?.trim();
if (!headBranch) {
  const head = git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })?.trim();
  if (head) {
    refs.push({ name: 'HEAD', sha: head, type: 'commit', commit: head });
  }
}
if (refs.length === 0) {
  fail('no branches or tags found');
}

// The commits that keep their baselines: the last --keep commits of each
// branch and of a detached HEAD.
const keep = new Set();
for (const ref of refs) {
  if (ref.name === 'HEAD' || ref.name.startsWith('refs/heads/')) {
    for (const sha of git(['rev-list', `--max-count=${keepCount}`, ref.commit]).split('\n')) {
      if (sha) {
        keep.add(sha);
      }
    }
  }
}

// Parents before children, so a rewritten parent is known by the time its
// children are visited.
const commitLines = git(['rev-list', '--reverse', '--topo-order', '--parents', ...new Set(refs.map((ref) => ref.commit))])
  .split('\n')
  .filter(Boolean);

// --- Tree surgery ---------------------------------------------------------

// Returns `tree` with the entry at `parts` removed: `tree` itself when it
// holds no such entry, null when nothing would be left (the caller then
// drops the directory entirely, as git never records empty directories).
// Cached: the same subtree occurs in many commits.
const strippedTrees = new Map();
function stripTree(tree, parts) {
  const key = `${tree} ${parts.length}`;
  if (strippedTrees.has(key)) {
    return strippedTrees.get(key);
  }
  const entries = git(['ls-tree', '-z', '--full-tree', tree]).split('\0').filter(Boolean);
  let result = tree;
  const index = entries.findIndex((entry) => entry.slice(entry.indexOf('\t') + 1) === parts[0]);
  if (index >= 0) {
    const [meta] = entries[index].split('\t');
    const [, type, sha] = meta.split(' ');
    let sub = null;
    if (parts.length > 1) {
      sub = type === 'tree' ? stripTree(sha, parts.slice(1)) : sha;
    }
    if (sub === null) {
      entries.splice(index, 1);
    } else {
      entries[index] = `${meta.replace(sha, sub)}\t${parts[0]}`;
    }
    if (sub !== sha) {
      result = entries.length === 0 ? null : git(['mktree', '-z'], { input: entries.map((entry) => entry + '\0').join('') }).trim();
    }
  }
  strippedTrees.set(key, result);
  return result;
}

const emptyTree = git(['mktree'], { input: '' }).trim();

// --- Commit rewriting -----------------------------------------------------

function parseIdent(line) {
  const match = /^(.*) <([^>]*)> (\d+ [-+]\d{4})$/.exec(line);
  if (!match) {
    fail(`cannot parse identity line: ${line}`);
  }
  return { name: match[1], email: match[2], date: match[3] };
}

function readCommit(sha) {
  const raw = git(['cat-file', 'commit', sha], { binary: true });
  const separator = raw.indexOf('\n\n');
  const header = raw.subarray(0, separator).toString('utf8');
  const info = { message: raw.subarray(separator + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) {
      continue; // continuation of a multi-line header such as gpgsig
    }
    const space = line.indexOf(' ');
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'author') {
      info.author = parseIdent(value);
    } else if (key === 'committer') {
      info.committer = parseIdent(value);
    } else if (key === 'encoding') {
      info.encoding = value;
    }
  }
  return info;
}

function writeCommit(sha, tree, parents) {
  const info = readCommit(sha);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: info.author.name,
    GIT_AUTHOR_EMAIL: info.author.email,
    GIT_AUTHOR_DATE: info.author.date,
    GIT_COMMITTER_NAME: info.committer.name,
    GIT_COMMITTER_EMAIL: info.committer.email,
    GIT_COMMITTER_DATE: info.committer.date,
  };
  const args = [];
  if (info.encoding) {
    args.push('-c', `i18n.commitEncoding=${info.encoding}`);
  }
  args.push('commit-tree', tree);
  for (const parent of parents) {
    args.push('-p', parent);
  }
  args.push('-F', '-');
  return git(args, { input: info.message, env }).trim();
}

// Old commit -> new commit. A commit maps to itself when nothing about it or
// its ancestry changed, which keeps hashes (and signatures) of the untouched
// prefix of history intact. In a dry run a rewritten commit maps to null.
const mapping = new Map();
const changed = (sha) => mapping.get(sha) !== sha;

let strippedCount = 0;
let rewrittenCount = 0;
const total = commitLines.length;
const progressAt = Math.max(1, Math.floor(total / 20));
const showProgress = !dryRun && process.stderr.isTTY;

for (const [index, line] of commitLines.entries()) {
  const [sha, ...parents] = line.split(' ');
  const tree = git(['rev-parse', `${sha}^{tree}`]).trim();
  let newTree = tree;
  if (!keep.has(sha)) {
    newTree = stripTree(tree, parts) ?? emptyTree;
    if (newTree !== tree) {
      strippedCount++;
    }
  }
  if (newTree === tree && !parents.some(changed)) {
    mapping.set(sha, sha);
    continue;
  }
  rewrittenCount++;
  mapping.set(sha, dryRun ? null : writeCommit(sha, newTree, parents.map((parent) => mapping.get(parent))));
  if (showProgress && (index + 1) % progressAt === 0) {
    process.stderr.write(`\rRewriting commits: ${index + 1}/${total}`);
  }
}
if (showProgress && rewrittenCount > 0) {
  process.stderr.write('\r\x1b[K');
}

const verb = dryRun ? 'would be' : 'were';
console.log(`${strippedCount} of ${total} commit(s) ${dryRun ? 'hold' : 'held'} ${dirPath}/ outside the last ${keepCount} commit(s) of a branch; ${rewrittenCount} commit(s) ${verb} rewritten.`);

if (dryRun) {
  for (const ref of refs) {
    if (changed(ref.commit)) {
      console.log(`  ${ref.name} would move from ${shortSha(ref.commit)}`);
    }
  }
  process.exit(0);
}

// --- Update refs ----------------------------------------------------------

// Rebuilds an annotated tag on the rewritten commit. Its signature, if any,
// is dropped: it signed content that no longer exists.
function rewriteTag(ref) {
  let raw = git(['cat-file', 'tag', ref.sha], { binary: true });
  const header = raw.subarray(0, raw.indexOf('\n\n')).toString('utf8');
  if (!/^type commit$/m.test(header)) {
    console.warn(`  ${ref.name} is a tag of a tag and is left as it is`);
    return null;
  }
  for (const marker of ['\n-----BEGIN PGP SIGNATURE-----', '\n-----BEGIN SSH SIGNATURE-----']) {
    const at = raw.indexOf(marker);
    if (at >= 0) {
      raw = raw.subarray(0, at + 1);
    }
  }
  const objectLine = `object ${ref.commit}\n`;
  if (!raw.subarray(0, objectLine.length).equals(Buffer.from(objectLine))) {
    fail(`unexpected tag object layout in ${ref.name}`);
  }
  const rebuilt = Buffer.concat([Buffer.from(`object ${mapping.get(ref.commit)}\n`), raw.subarray(objectLine.length)]);
  return git(['mktag'], { input: rebuilt, binary: true }).toString().trim();
}

if (rewrittenCount > 0) {
  console.log('Updated refs (the old commits stay on your remote until you force-push):');
  for (const ref of refs) {
    if (!changed(ref.commit)) {
      continue;
    }
    const target = ref.type === 'tag' ? rewriteTag(ref) : mapping.get(ref.commit);
    if (!target) {
      continue;
    }
    const args = ref.name === 'HEAD' ? ['update-ref', '--no-deref', 'HEAD', target, ref.sha] : ['update-ref', ref.name, target, ref.sha];
    git(args);
    console.log(`  ${ref.name.replace(/^refs\/(heads|tags)\//, '')}: ${shortSha(ref.sha)} -> ${shortSha(target)}`);
  }
}

// --- Garbage collection ---------------------------------------------------

const sizeBefore = repoSize();
git(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
git(['gc', '--prune=now', '--quiet']);
console.log(`Repository objects: ${formatMiB(sizeBefore)} -> ${formatMiB(repoSize())}`);

// Remote-tracking refs pointing at rewritten commits keep the old objects
// alive; say so, rather than moving refs that record what the remote has
// (which --force-with-lease relies on).
const stale = git(['for-each-ref', '--format=%(refname:short) %(objectname) %(symref)', 'refs/remotes'])
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split(' '))
  .filter(([, sha, symref]) => !symref && mapping.has(sha) && changed(sha))
  .map(([name]) => name);
if (stale.length > 0) {
  console.log(`\nThe remote-tracking refs ${stale.join(', ')} still hold the old history, and with it the pruned images.`);
  console.log('Push the rewritten branches and tags, then run shotest-prune-history once more to reclaim the space:');
  console.log('  git push --force-with-lease --all && git push --force --tags');
  console.log('Other clones must re-clone, or reset their branches onto the pushed ones.');
}
