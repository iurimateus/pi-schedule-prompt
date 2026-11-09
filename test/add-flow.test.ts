import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import type { ScheduleSettings } from "../src/settings.js";
import type { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { runAddFlow } from "../src/ui/add-flow.js";

interface HarnessOptions {
  cwd?: string;
  coordinatorDir?: string;
  pickType?: string;
  pickWait?: (options: string[]) => string | undefined;
}

// Drives runAddFlow through a scripted UI: `input` returns queued replies,
// `select` takes the first option unless a test picks a type/wait target,
// `confirm` accepts. Keeps the test at the runAddFlow/UI seam - no TUI, no disk.
function makeHarness(inputs: (string | undefined)[], opts: HarnessOptions = {}) {
  const queue = [...inputs];
  const input = vi.fn();
  input.mockImplementation(async () => queue.shift());
  const select = vi.fn(async (title: string, options: string[]) => {
    if (title === "Wait for" && opts.pickWait) return opts.pickWait(options);
    if (title === "Job Type" && opts.pickType) return opts.pickType;
    return options[0];
  });
  const ui = { input, select, confirm: vi.fn(async () => true), notify: vi.fn() };

  const addJob = vi.fn();
  const storage = { hasJobWithName: () => false, addJob } as unknown as CronStorage;
  const scheduler = { addJob: vi.fn() } as unknown as CronScheduler;
  const settings: ScheduleSettings = { defaultJobScope: "session" };

  const ctx = { ui, cwd: opts.cwd ?? "/work" } as unknown as ExtensionCommandContext;
  return { ctx, ui, storage, scheduler, settings, addJob, coordinatorDir: opts.coordinatorDir };
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
  // The trailing Back option is covered by the navigation tests.
  return options.filter((option) => option !== "Back");
}

describe("runAddFlow wait picker", () => {
  it("offers only live, non-exited root sessions in the current cwd", async () => {
    const dir = makeCoordinatorDir();
    writeRecord(dir, { sessionId: "root", sessionFile: writeSessionFile(dir, "root", rootHeader("root")), updatedAt: 100 });
    writeRecord(dir, {
      sessionId: "child",
      sessionFile: writeSessionFile(dir, "child", { ...rootHeader("child"), parentSession: "/tmp/parent.jsonl" }),
      updatedAt: 200,
    });
    writeRecord(dir, { sessionId: "elsewhere", sessionFile: writeSessionFile(dir, "elsewhere", rootHeader("elsewhere")), cwd: "/other", updatedAt: 300 });
    writeRecord(dir, { sessionId: "dead", sessionFile: writeSessionFile(dir, "dead", rootHeader("dead")), pid: 999999999, updatedAt: 400 });
    writeRecord(dir, { sessionId: "exited", sessionFile: writeSessionFile(dir, "exited", rootHeader("exited")), status: "exited", updatedAt: 500 });

    const h = makeHarness(["my wait", "the prompt"], { coordinatorDir: dir, pickType: WAIT });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(waitOptions(h.ui)).toEqual(["root [settled]"]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
  });

  it("omits records whose session header is malformed or belongs to another id", async () => {
    const dir = makeCoordinatorDir();
    writeRecord(dir, { sessionId: "good", sessionFile: writeSessionFile(dir, "good", rootHeader("good")), updatedAt: 10 });
    writeRecord(dir, { sessionId: "malformed", sessionFile: writeSessionFile(dir, "malformed", "not json"), updatedAt: 20 });
    writeRecord(dir, { sessionId: "missing", sessionFile: join(dir, "absent.jsonl"), updatedAt: 30 });
    writeRecord(dir, { sessionId: "no-file", updatedAt: 40 });
    writeRecord(dir, {
      sessionId: "mismatched",
      sessionFile: writeSessionFile(dir, "mismatched", rootHeader("different-id")),
      updatedAt: 50,
    });
    writeRecord(dir, {
      sessionId: "invalid-parent",
      sessionFile: writeSessionFile(dir, "invalid-parent", { ...rootHeader("invalid-parent"), parentSession: 7 }),
      updatedAt: 60,
    });

    const h = makeHarness(["w", "p"], { coordinatorDir: dir, pickType: WAIT });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(waitOptions(h.ui)).toEqual(["good [settled]"]);
  });

  it("orders candidates by updatedAt descending", async () => {
    const dir = makeCoordinatorDir();
    writeRecord(dir, { sessionId: "old", sessionFile: writeSessionFile(dir, "old", rootHeader("old")), updatedAt: 100 });
    writeRecord(dir, { sessionId: "mid", sessionFile: writeSessionFile(dir, "mid", rootHeader("mid")), updatedAt: 200 });
    writeRecord(dir, { sessionId: "newest", sessionFile: writeSessionFile(dir, "newest", rootHeader("newest")), updatedAt: 300 });

    const h = makeHarness(["w", "p"], { coordinatorDir: dir, pickType: WAIT });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(waitOptions(h.ui)).toEqual(["newest [settled]", "mid [settled]", "old [settled]"]);
  });

  it("marks the current session and persists the chosen target", async () => {
    const dir = makeCoordinatorDir();
    writeRecord(dir, { sessionId: "target", sessionFile: writeSessionFile(dir, "target", rootHeader("target")), updatedAt: 200 });
    writeRecord(dir, { sessionId: "current-session", sessionFile: writeSessionFile(dir, "current-session", rootHeader("current-session")), updatedAt: 100 });

    const h = makeHarness(["my wait", "the prompt"], {
      coordinatorDir: dir,
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

  it("notifies and saves nothing when no live sessions are available", async () => {
    const dir = makeCoordinatorDir();
    const h = makeHarness(["my wait"], { coordinatorDir: dir, pickType: WAIT });
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "current-session", dir);

    expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No live sessions"), "info");
    expect(waitOptions(h.ui)).toEqual([]);
    expect(h.addJob).not.toHaveBeenCalled();
  });
});
