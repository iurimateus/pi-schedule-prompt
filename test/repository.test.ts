import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryKey } from "../src/repository.js";

/** Temp directory; `git` gives it a `.git` marker, making it a repository. */
function makeDir(git: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "repository-key-"));
  if (git) mkdirSync(join(dir, ".git"));
  return dir;
}

/** Temp directory that is a linked worktree of the repository at `repo`. */
function makeWorktree(repo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "repository-worktree-"));
  const gitDir = join(repo, ".git", "worktrees", basename(dir));
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
  return dir;
}

/** Temp directory that is a main Jujutsu workspace: `.jj/repo` is a directory. */
function makeJjRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "repository-jj-"));
  mkdirSync(join(dir, ".jj", "repo"), { recursive: true });
  return dir;
}

/**
 * Temp directory that is a secondary Jujutsu workspace of the repository at
 * `repo`. Its `.jj/repo` file names the shared repo directory, either relative
 * to the workspace's `.jj` directory or as an absolute path.
 */
function makeJjWorkspace(repo: string, absolute = false): string {
  const dir = mkdtempSync(join(tmpdir(), "repository-workspace-"));
  const jjDir = join(dir, ".jj");
  mkdirSync(jjDir);
  const repoDir = join(repo, ".jj", "repo");
  writeFileSync(join(jjDir, "repo"), absolute ? repoDir : relative(jjDir, repoDir));
  return dir;
}

describe("repositoryKey", () => {
  it("keys a repository by its git directory", () => {
    const repo = makeDir(true);
    expect(repositoryKey(repo)).toBe(repositoryKey(join(repo, ".git")));
  });

  it("finds the repository from a nested working directory", () => {
    const repo = makeDir(true);
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(repositoryKey(nested)).toBe(repositoryKey(repo));
  });

  it("gives a linked worktree the key of its main checkout", () => {
    const repo = makeDir(true);
    expect(repositoryKey(makeWorktree(repo))).toBe(repositoryKey(repo));
  });

  it("keys a Jujutsu repository by its repo directory", () => {
    const repo = makeJjRepo();
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(repositoryKey(repo)).toBe(repositoryKey(join(repo, ".jj", "repo")));
    expect(repositoryKey(nested)).toBe(repositoryKey(repo));
  });

  it("gives a Jujutsu workspace the key of its main workspace", () => {
    const repo = makeJjRepo();
    expect(repositoryKey(makeJjWorkspace(repo))).toBe(repositoryKey(repo));
  });

  it("gives a Jujutsu workspace an absolute repo path the same key", () => {
    const repo = makeJjRepo();
    expect(repositoryKey(makeJjWorkspace(repo, true))).toBe(repositoryKey(repo));
  });

  it("gives a standalone Jujutsu workspace the same key as a colocated main", () => {
    const repo = makeDir(true);
    mkdirSync(join(repo, ".jj", "repo"), { recursive: true });
    expect(repositoryKey(makeJjWorkspace(repo))).toBe(repositoryKey(repo));
  });

  it("gives separate Jujutsu repositories different keys", () => {
    expect(repositoryKey(makeJjRepo())).not.toBe(repositoryKey(makeJjRepo()));
  });

  it("gives separate repositories different keys", () => {
    expect(repositoryKey(makeDir(true))).not.toBe(repositoryKey(makeDir(true)));
  });

  it("gives directories outside any repository their own key", () => {
    expect(repositoryKey(makeDir(false))).not.toBe(repositoryKey(makeDir(false)));
  });
});
