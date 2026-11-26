/**
 * Decide whether two pi sessions work in the same repository.
 *
 * The wait-target picker lists sessions from every workspace of the creator's
 * repository - a Git worktree or a Jujutsu workspace of the same repo - but
 * hides sessions of unrelated repositories, whose prompts never make sense
 * here. Sessions share a repository when their `cwd` resolves to the same
 * repository directory - the Jujutsu repo directory or the Git directory - so
 * that directory is the identity, not the checkout path.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** `realpath` that tolerates a path that does not exist (yet). */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Jujutsu repo directory reachable from `dir`, or `undefined`. Every workspace
 * of one repository shares that directory: `.jj/repo` is a directory in the
 * main workspace, and a file naming it - relative to `.jj/` or absolute - in a
 * secondary workspace.
 */
function jjRepoAt(dir: string): string | undefined {
  const marker = join(dir, ".jj", "repo");
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(marker);
  } catch {
    return undefined;
  }
  if (stats.isDirectory()) return resolved(marker);

  let content: string;
  try {
    content = readFileSync(marker, "utf8");
  } catch {
    return undefined;
  }
  const path = content.trim();
  return path ? resolved(resolve(dirname(marker), path)) : undefined;
}

/**
 * Git directory reachable from `dir` without ascending further, or `undefined`.
 * A `.git` file - a linked worktree or a submodule - names its git dir on a
 * `gitdir:` line; a worktree target is mapped to the common git dir so all
 * worktrees of one repository share an identity.
 */
function gitDirAt(dir: string): string | undefined {
  const marker = join(dir, ".git");
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(marker);
  } catch {
    return undefined;
  }
  if (stats.isDirectory()) return resolved(marker);

  let content: string;
  try {
    content = readFileSync(marker, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:[ \t]*(.+)$/m.exec(content);
  if (!match) return undefined;
  const gitDir = resolved(resolve(dir, match[1].trim()));
  const worktree = /^(.*)[\\/]worktrees[\\/][^\\/]+$/.exec(gitDir);
  return worktree ? worktree[1] : gitDir;
}

/**
 * Repository identity reachable from `dir` without ascending further, or
 * `undefined`. Jujutsu takes precedence over Git: a secondary Jujutsu
 * workspace may carry no `.git` marker, or a Git worktree whose git dir
 * differs from the path its siblings share. `.jj/repo` names the same
 * directory for every workspace of one repository.
 */
function repositoryDirAt(dir: string): string | undefined {
  return jjRepoAt(dir) ?? gitDirAt(dir);
}

/**
 * Repository identity of `cwd`: its Jujutsu repo directory or git directory, or
 * `cwd` itself when it sits outside a repository. Two outside directories
 * therefore never match, which keeps the picker honest for ad-hoc sessions.
 */
export function repositoryKey(cwd: string): string {
  const start = resolved(cwd);
  let dir = start;
  for (;;) {
    const key = repositoryDirAt(dir);
    if (key !== undefined) return key;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
