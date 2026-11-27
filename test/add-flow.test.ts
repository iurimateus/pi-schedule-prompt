import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import type { ScheduleSettings } from "../src/settings.js";
import type { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { ENTER_SESSION_ID, runAddFlow } from "../src/ui/add-flow.js";

interface HarnessOptions {
  cwd?: string;
  coordinatorDir?: string;
  pickType?: string;
  selectionQueue?: (string | undefined)[];

  pickWait?: (options: string[]) => string | undefined;
  pickDelivery?: (options: string[]) => string | undefined;
}

// Drives runAddFlow through a scripted UI: `input` and `editor` return queued
// replies, `select` takes the first option unless a test picks a type/wait
// target, `confirm` accepts. Keeps the test at the runAddFlow/UI seam - no TUI,
// no disk.
function makeHarness(inputs: (string | undefined)[], opts: HarnessOptions = {}) {
  const queue = [...inputs];
  const events: string[] = [];
  const input = vi.fn();
  input.mockImplementation(async () => {
    const reply = queue.shift();
    events.push("dialog closed");
    return reply;
  });
  const editor = vi.fn();
  editor.mockImplementation(async () => queue.shift());
  const select = vi.fn(async (title: string, options: string[]) => {
    const choice = opts.selectionQueue
      ? opts.selectionQueue.shift()
      : (title === "Wait for" && opts.pickWait?.(options)) ||
        (title === "Deliver to" && opts.pickDelivery?.(options)) ||
        (title === "Job Type" && opts.pickType) ||
        options.find((option) => option !== "Back" && option !== ENTER_SESSION_ID);
    events.push("dialog closed");
    return choice;
  });
  const confirm = vi.fn(async () => {
    events.push("dialog closed");
    return true;
  });
  const ui = { input, editor, select, confirm, notify: vi.fn() };

  const addJob = vi.fn();
  const storage = { hasJobWithName: () => false, addJob } as unknown as CronStorage;
  const onFlowStep = vi.fn(() => events.push("step"));
  const scheduler = { addJob: vi.fn(), onFlowStep } as unknown as CronScheduler;
  const settings: ScheduleSettings = { defaultJobScope: "session" };

  const ctx = { ui, cwd: opts.cwd ?? "/work" } as unknown as ExtensionCommandContext;
  return {
    ctx,
    ui,
    storage,
    scheduler,
    settings,
    addJob,
    onFlowStep,
    events,
    coordinatorDir: opts.coordinatorDir,
  };
}

describe("runAddFlow schedule step", () => {
  it("re-prompts on an invalid schedule and shows the validation error", async () => {
    const invalid = "not a cron";
    const expectedError = "must have 6 fields";

    const h = makeHarness(["my job", invalid, "0 0 9 * * *", "the prompt"]);
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, undefined);

    // First schedule prompt is unadorned; the re-prompt carries the error.
    expect(h.ui.input.mock.calls[1][0]).toBe("Schedule");
    expect(h.ui.input.mock.calls[2][0]).toContain(expectedError);
    expect(h.addJob).toHaveBeenCalledTimes(1);
  });

  it("saves a valid schedule without changing the prompt title", async () => {
    const h = makeHarness(["my job", "0 0 9 * * *", "the prompt"]);
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, undefined);

    expect(h.ui.input.mock.calls[1][0]).toBe("Schedule");
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject<Partial<CronJob>>({
      name: "my job",
      schedule: "0 0 9 * * *",
      prompt: "the prompt",
      type: "cron",
    });
    expect(h.scheduler.addJob).toHaveBeenCalledTimes(1);
  });

  it("reports every step so the idle clock restarts between dialogs", async () => {
    const h = makeHarness(["my job", "0 0 9 * * *", "the prompt"], {
      pickType: "Cron (recurring)",
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, undefined);

    // name, type, schedule, prompt, scope, confirm
    expect(h.onFlowStep).toHaveBeenCalledTimes(6);
  });

  it("resets the idle clock only after the dialog closes", async () => {
    const h = makeHarness(["my job", "0 0 9 * * *", "the prompt"], {
      pickType: "Cron (recurring)",
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, undefined);

    // A step opens its dialog first and resets the clock once the answer lands.
    expect(h.events[0]).toBe("dialog closed");
    expect(h.events[1]).toBe("step");
  });

  it("resets the idle clock after a cancelled step and then stops", async () => {
    const h = makeHarness(["my job", undefined], { selectionQueue: ["Cron (recurring)", "Back"] }); // schedule cancellation returns to type; Back exits
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, undefined);

    // name, type, cancelled schedule, Back to name, cancelled name.
    expect(h.events).toEqual([
      "dialog closed", "step",
      "dialog closed", "step",
      "dialog closed", "step",
      "dialog closed", "step",
      "dialog closed", "step",
    ]);
    expect(h.addJob).not.toHaveBeenCalled();
  });

  it("resets the idle clock when a dialog closes with an error", async () => {
    const h = makeHarness(["my job"]);
    h.ui.input.mockRejectedValueOnce(new Error("dialog closed abnormally"));

    await expect(runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, undefined)).rejects.toThrow(
      "dialog closed abnormally",
    );
    expect(h.onFlowStep).toHaveBeenCalledTimes(1);
    expect(h.addJob).not.toHaveBeenCalled();
  });
});

describe("runAddFlow prompt step", () => {
  it("collects the prompt in the multiline editor and keeps embedded newlines", async () => {
    const prompt = "Summarize the logs.\nThen list every failure.";
    const h = makeHarness(["my job", "0 0 9 * * *", prompt]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, undefined);

    expect(h.ui.editor).toHaveBeenCalledTimes(1);
    expect(h.ui.editor.mock.calls[0][0]).toBe("Prompt");
    expect(h.ui.input).toHaveBeenCalledTimes(2);
    expect(h.addJob.mock.calls[0][0]).toMatchObject<Partial<CronJob>>({ prompt });
    expect(h.ui.confirm.mock.calls[0][1]).toContain(prompt);
  });
});

const WAIT = "Wait (session idle)";

function makeCoordinatorDir(): string {
  return mkdtempSync(join(tmpdir(), "add-flow-wait-"));
}

/** Write a session file. Pass a string to simulate a malformed header. */
function writeSessionFile(
  dir: string,
  id: string,
  header: Record<string, unknown> | string,
): string {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, typeof header === "string" ? header : `${JSON.stringify(header)}\n`);
  return path;
}

function rootHeader(id: string): Record<string, unknown> {
  return { type: "session", id, timestamp: new Date().toISOString(), cwd: "/work" };
}

interface RecordSpec {
  sessionId: string;
  sessionFile?: string;
  cwd?: string;
  pid?: number;
  status?: "working" | "settled" | "exited";
  updatedAt?: number;
}

function writeRecord(dir: string, spec: RecordSpec): void {
  writeFileSync(
    join(dir, `${encodeURIComponent(spec.sessionId)}.json`),
    JSON.stringify({
      sessionId: spec.sessionId,
      sessionFile: spec.sessionFile,
      cwd: spec.cwd ?? "/work",
      pid: spec.pid ?? process.pid,
      status: spec.status ?? "settled",
      startedAt: 0,
      updatedAt: spec.updatedAt ?? 0,
    }),
  );
}

function waitOptions(ui: { select: { mock: { calls: unknown[][] } } }): string[] {
  const call = ui.select.mock.calls.find((c) => c[0] === "Wait for");
  const options = (call?.[1] as string[] | undefined) ?? [];
  // Back and the freeform id entry are covered by their own tests.
  return options.filter((option) => option !== "Back" && option !== ENTER_SESSION_ID);
}

/** Temp directory; `git` makes it a repository by giving it a `.git` marker. */
function makeDir(git: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "add-flow-cwd-"));
  if (git) mkdirSync(join(dir, ".git"));
  return dir;
}

/** Temp directory that is a linked worktree of the repository at `repo`. */
function makeWorktree(repo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "add-flow-worktree-"));
  const gitDir = join(repo, ".git", "worktrees", basename(dir));
  // Git creates the per-worktree git dir; the `.git` file points at it.
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
  return dir;
}

/** Temp directory that is a main Jujutsu workspace: `.jj/repo` is a directory. */
function makeJjRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "add-flow-jj-"));
  mkdirSync(join(dir, ".jj", "repo"), { recursive: true });
  return dir;
}

/** Temp directory that is a secondary Jujutsu workspace of the repository at `repo`. */
function makeJjWorkspace(repo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "add-flow-workspace-"));
  const jjDir = join(dir, ".jj");
  mkdirSync(jjDir);
  writeFileSync(join(jjDir, "repo"), relative(jjDir, join(repo, ".jj", "repo")));
  return dir;
}

/** Register a live root session working in `cwd`. */
function liveRoot(
  dir: string,
  id: string,
  cwd: string,
  updatedAt: number,
  extra: Partial<RecordSpec> = {},
): void {
  writeRecord(dir, {
    sessionId: id,
    cwd,
    sessionFile: writeSessionFile(dir, id, rootHeader(id)),
    updatedAt,
    ...extra,
  });
}

describe("runAddFlow wait picker", () => {
  it("offers live root sessions of this repository across its worktrees", async () => {
    const repo = makeDir(true);
    const worktree = makeWorktree(repo);
    const otherRepo = makeDir(true);
    const loose = makeDir(false);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "here", repo, 100);
    liveRoot(dir, "worktree", worktree, 300);
    liveRoot(dir, "other-repo", otherRepo, 400);
    liveRoot(dir, "loose", loose, 500);
    writeRecord(dir, {
      sessionId: "child",
      cwd: repo,
      sessionFile: writeSessionFile(dir, "child", {
        ...rootHeader("child"),
        parentSession: "/tmp/parent.jsonl",
      }),
      updatedAt: 600,
    });
    liveRoot(dir, "dead", repo, 700, { pid: 999999999 });
    liveRoot(dir, "exited", repo, 800, { status: "exited" });

    const h = makeHarness(["my wait", "the prompt"], {
      coordinatorDir: dir,
      cwd: repo,
      pickType: WAIT,
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    // A worktree of the same repository stays selectable. A checkout of another
    // repository, a directory outside any repository, a child session, a dead
    // process and an exited record do not reach the list.
    expect(waitOptions(h.ui)).toEqual(["worktree [settled]", "here [settled]"]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
  });

  it("offers live root sessions of this repository across its Jujutsu workspaces", async () => {
    const repo = makeJjRepo();
    const workspace = makeJjWorkspace(repo);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "here", repo, 100);
    liveRoot(dir, "workspace", workspace, 200);

    const h = makeHarness(["my wait", "the prompt"], {
      coordinatorDir: dir,
      cwd: repo,
      pickType: WAIT,
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    // A secondary Jujutsu workspace of the same repository stays selectable.
    expect(waitOptions(h.ui)).toEqual(["workspace [settled]", "here [settled]"]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
  });

  it("omits records whose session header is malformed or belongs to another id", async () => {
    const repo = makeDir(true);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "good", repo, 10);
    writeRecord(dir, {
      sessionId: "malformed",
      cwd: repo,
      sessionFile: writeSessionFile(dir, "malformed", "not json"),
      updatedAt: 20,
    });
    writeRecord(dir, {
      sessionId: "missing",
      cwd: repo,
      sessionFile: join(dir, "absent.jsonl"),
      updatedAt: 30,
    });
    writeRecord(dir, { sessionId: "no-file", cwd: repo, updatedAt: 40 });
    writeRecord(dir, {
      sessionId: "mismatched",
      cwd: repo,
      sessionFile: writeSessionFile(dir, "mismatched", rootHeader("different-id")),
      updatedAt: 50,
    });
    writeRecord(dir, {
      sessionId: "invalid-parent",
      cwd: repo,
      sessionFile: writeSessionFile(dir, "invalid-parent", {
        ...rootHeader("invalid-parent"),
        parentSession: 7,
      }),
      updatedAt: 60,
    });

    const h = makeHarness(["w", "p"], { coordinatorDir: dir, cwd: repo, pickType: WAIT });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(waitOptions(h.ui)).toEqual(["good [settled]"]);
  });

  it("orders candidates by updatedAt descending", async () => {
    const repo = makeDir(true);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "old", repo, 100);
    liveRoot(dir, "mid", repo, 200);
    liveRoot(dir, "newest", repo, 300);

    const h = makeHarness(["w", "p"], { coordinatorDir: dir, cwd: repo, pickType: WAIT });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(waitOptions(h.ui)).toEqual(["newest [settled]", "mid [settled]", "old [settled]"]);
  });

  it("marks the current session and persists the chosen target", async () => {
    const repo = makeDir(true);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "target", repo, 200);
    liveRoot(dir, "current-session", repo, 100);

    const h = makeHarness(["my wait", "the prompt"], {
      coordinatorDir: dir,
      cwd: repo,
      pickType: WAIT,
      pickWait: (options) => options.find((o) => o.startsWith("target ")),
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(waitOptions(h.ui)).toContain("current-session [settled] · current");
    expect(h.addJob).toHaveBeenCalledWith(
      expect.objectContaining<Partial<CronJob>>({
        type: "wait",
        schedule: "wait",
        session: "target",
        ownerSession: "current-session",
        prompt: "the prompt",
      }),
    );
    expect(h.ui.confirm.mock.calls[0][1]).toContain("target");
  });
});

describe("runAddFlow wait target freeform entry", () => {
  /** Picker reply that opens the session-id prompt. */
  const typeId = (options: string[]) => options.find((o) => o === ENTER_SESSION_ID);

  it("accepts an active session of another repository typed by id", async () => {
    const repo = makeDir(true);
    const otherRepo = makeDir(true);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "other", otherRepo, 100);

    const h = makeHarness(["my wait", "other", "the prompt"], {
      coordinatorDir: dir,
      cwd: repo,
      pickType: WAIT,
      pickWait: typeId,
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    // The list hides the foreign repository; a typed id still reaches it.
    expect(waitOptions(h.ui)).toEqual([]);
    expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No live sessions"), "info");
    expect(h.addJob.mock.calls[0][0]).toMatchObject<Partial<CronJob>>({
      type: "wait",
      session: "other",
    });
  });

  it("re-prompts after an inactive id and saves the next valid one", async () => {
    const repo = makeDir(true);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "gone", repo, 100, { status: "exited" });
    liveRoot(dir, "live", repo, 200);

    const h = makeHarness(["w", "gone", "live", "p"], {
      coordinatorDir: dir,
      cwd: repo,
      pickType: WAIT,
      pickWait: typeId,
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(h.ui.notify).toHaveBeenCalledWith("Session gone is not active", "error");
    expect(h.ui.select.mock.calls.filter((c) => c[0] === "Wait for")).toHaveLength(2);
    expect(h.addJob.mock.calls[0][0]).toMatchObject<Partial<CronJob>>({ session: "live" });
  });

  it("re-prompts after an id the coordinator does not track", async () => {
    const repo = makeDir(true);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "live", repo, 100);

    const h = makeHarness(["w", "ghost", "live", "p"], {
      coordinatorDir: dir,
      cwd: repo,
      pickType: WAIT,
      pickWait: typeId,
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(h.ui.notify).toHaveBeenCalledWith(
      "No session with id ghost is tracked by the coordinator",
      "error",
    );
    expect(h.addJob.mock.calls[0][0]).toMatchObject<Partial<CronJob>>({ session: "live" });
  });

  it("trims the typed id before it validates it", async () => {
    const repo = makeDir(true);
    const dir = makeCoordinatorDir();
    liveRoot(dir, "live", repo, 100);

    const h = makeHarness(["w", "  live  ", "p"], {
      coordinatorDir: dir,
      cwd: repo,
      pickType: WAIT,
      pickWait: typeId,
    });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(h.addJob.mock.calls[0][0]).toMatchObject<Partial<CronJob>>({ session: "live" });
  });
});

describe("runAddFlow wait delivery", () => {
  function makeWaitDir(): string {
    const dir = makeCoordinatorDir();
    liveRoot(dir, "target", "/work", 100);
    return dir;
  }

  it("defaults the delivery to the waited-on session", async () => {
    const dir = makeWaitDir();
    const h = makeHarness(["my wait", "the prompt"], { coordinatorDir: dir, pickType: WAIT });

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    const delivery = h.ui.select.mock.calls.find((c) => c[0] === "Deliver to");
    expect(delivery).toBeDefined();
    expect((delivery?.[1] as string[])[0]).toBe("Target session — its chat takes the prompt");
    expect(h.addJob.mock.calls[0][0]).toMatchObject<Partial<CronJob>>({ deliverTo: "target" });
  });

  it("persists the owner delivery when chosen and shows it on the confirm", async () => {
    const dir = makeWaitDir();
    const h = makeHarness(["my wait", "the prompt"], {
      coordinatorDir: dir,
      pickType: WAIT,
      pickDelivery: (options) => options.find((o) => o.startsWith("This session")),
    });

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(h.addJob.mock.calls[0][0]).toMatchObject<Partial<CronJob>>({
      type: "wait",
      session: "target",
      ownerSession: "current-session",
      deliverTo: "owner",
    });
    expect(h.ui.confirm.mock.calls[0][1]).toContain("Delivers to: this session");
  });
});
