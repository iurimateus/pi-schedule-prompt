import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { scheduleSelfWait } from "../src/self-wait.js";
import { CronStorage } from "../src/storage.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let originalManager: unknown;
let liveSchedulers: CronScheduler[] = [];

beforeEach(() => {
  originalManager = (globalThis as any)[MANAGER_KEY];
});

afterEach(() => {
  for (const scheduler of liveSchedulers) scheduler.stop();
  liveSchedulers = [];
  if (originalManager === undefined) delete (globalThis as any)[MANAGER_KEY];
  else (globalThis as any)[MANAGER_KEY] = originalManager;
});

function track(scheduler: CronScheduler): CronScheduler {
  liveSchedulers.push(scheduler);
  return scheduler;
}

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "self-wait-"));
}

/** Write one coordinator record file per entry into a temp state dir. */
function makeCoordinatorDir(
  records: Array<{ sessionId: string; status: string; pid?: number }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "self-wait-coordinator-"));
  for (const record of records) {
    writeFileSync(
      join(dir, `${encodeURIComponent(record.sessionId)}.json`),
      JSON.stringify({
        sessionId: record.sessionId,
        cwd: "/tmp",
        pid: record.pid ?? process.pid,
        status: record.status,
      }),
    );
  }
  return dir;
}

function setSubagentManager(manager: unknown): void {
  (globalThis as any)[MANAGER_KEY] = manager;
}

function makePi() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
}

function makeCtx(sessionId: string, cwd = "/tmp") {
  return {
    cwd,
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: { getSessionId: () => sessionId },
  } as any;
}

function makeFakeScheduler() {
  return { addJob: vi.fn() };
}

describe("scheduleSelfWait — delivery", () => {
  it("creates a random-id self-wait and delivers it once when the session is idle", () => {
    const cwd = tempCwd();
    const coordinatorDir = makeCoordinatorDir([{ sessionId: "s1", status: "settled" }]);
    setSubagentManager({ hasRunning: () => false });
    const storage = new CronStorage(cwd);
    const pi = makePi();
    const scheduler = track(
      new CronScheduler(storage, pi, makeCtx("s1", cwd), coordinatorDir),
    );

    const result = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "resume", dedupeKey: "resume-check" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.job.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(result.job).toMatchObject({
      type: "wait",
      schedule: "wait",
      prompt: "resume",
      enabled: true,
      session: "s1",
      ownerSession: "s1",
      deliverTo: "target",
      dedupeKey: "resume-check",
      runCount: 0,
    });
    expect(storage.getJob(result.job.id)).toBeDefined();

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendMessage.mock.calls[0][0].details.mode).toBe("wait_delivery");
    expect(pi.sendUserMessage).toHaveBeenCalledWith("resume", { deliverAs: "followUp" });
    const delivered = storage.getJob(result.job.id)!;
    expect(delivered.enabled).toBe(false);
    expect(delivered.lastStatus).toBe("success");
    expect(delivered.runCount).toBe(1);
    expect(delivered.lastRun).toBeDefined();
  });

  it("stays pending while the session is working", () => {
    const cwd = tempCwd();
    const coordinatorDir = makeCoordinatorDir([{ sessionId: "s1", status: "working" }]);
    setSubagentManager({ hasRunning: () => false });
    const storage = new CronStorage(cwd);
    const pi = makePi();
    const scheduler = track(
      new CronScheduler(storage, pi, makeCtx("s1", cwd), coordinatorDir),
    );

    const result = scheduleSelfWait({ storage, scheduler, sessionId: "s1" }, { prompt: "resume" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob(result.job.id)!.enabled).toBe(true);
  });

  it("stays pending while pi-subagents has a running agent", () => {
    const cwd = tempCwd();
    const coordinatorDir = makeCoordinatorDir([{ sessionId: "s1", status: "settled" }]);
    setSubagentManager({ hasRunning: () => true });
    const storage = new CronStorage(cwd);
    const pi = makePi();
    const scheduler = track(
      new CronScheduler(storage, pi, makeCtx("s1", cwd), coordinatorDir),
    );

    const result = scheduleSelfWait({ storage, scheduler, sessionId: "s1" }, { prompt: "resume" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob(result.job.id)!.enabled).toBe(true);
  });
});

describe("scheduleSelfWait — deduplication", () => {
  it("reuses an enabled job with the same session-scoped key", () => {
    const cwd = tempCwd();
    const storage = new CronStorage(cwd);
    const scheduler = makeFakeScheduler();

    const first = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "first", dedupeKey: "k" },
    );
    const second = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "second", dedupeKey: "k" },
    );

    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(false);
    if (!first.ok || !second.ok) return;
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.prompt).toBe("first");
    expect(storage.getAllJobs()).toHaveLength(1);
    expect(scheduler.addJob).toHaveBeenCalledTimes(1);
  });

  it("treats the key as session-scoped: another session gets its own job", () => {
    const cwd = tempCwd();
    const storage = new CronStorage(cwd);
    const scheduler = makeFakeScheduler();

    const a = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "p", dedupeKey: "k" },
    );
    const b = scheduleSelfWait(
      { storage, scheduler, sessionId: "s2" },
      { prompt: "p", dedupeKey: "k" },
    );

    expect(a.ok && a.created).toBe(true);
    expect(b.ok && b.created).toBe(true);
    expect(storage.getAllJobs()).toHaveLength(2);
    expect(scheduler.addJob).toHaveBeenCalledTimes(2);
  });

  it("creates one job for concurrent same-key requests in one process", () => {
    // Scope: both calls run on the one JS thread, and the lookup plus append in
    // CronStorage.addJobDeduped share a single synchronous load/save. The store
    // has no interprocess lock, so this guarantee stops at the process boundary.
    const cwd = tempCwd();
    const firstStorage = new CronStorage(cwd);
    const secondStorage = new CronStorage(cwd);
    const scheduler = makeFakeScheduler();

    const first = scheduleSelfWait(
      { storage: firstStorage, scheduler, sessionId: "s1" },
      { prompt: "p", dedupeKey: "k" },
    );
    const second = scheduleSelfWait(
      { storage: secondStorage, scheduler, sessionId: "s1" },
      { prompt: "p", dedupeKey: "k" },
    );

    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(false);
    if (!first.ok || !second.ok) return;
    expect(second.job.id).toBe(first.job.id);
    expect(new CronStorage(cwd).getAllJobs()).toHaveLength(1);
    expect(scheduler.addJob).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate without a key", () => {
    const cwd = tempCwd();
    const storage = new CronStorage(cwd);
    const scheduler = makeFakeScheduler();

    const first = scheduleSelfWait({ storage, scheduler, sessionId: "s1" }, { prompt: "p" });
    const second = scheduleSelfWait({ storage, scheduler, sessionId: "s1" }, { prompt: "p" });

    expect(first.ok && first.created).toBe(true);
    expect(second.ok && second.created).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.job.id).not.toBe(first.job.id);
    expect(storage.getAllJobs()).toHaveLength(2);
  });
});

describe("scheduleSelfWait — cancellation and lifecycle", () => {
  it("delivers nothing after the job is disabled before idle", () => {
    const cwd = tempCwd();
    const coordinatorDir = makeCoordinatorDir([{ sessionId: "s1", status: "settled" }]);
    setSubagentManager({ hasRunning: () => false });
    const storage = new CronStorage(cwd);
    const pi = makePi();
    const scheduler = track(
      new CronScheduler(storage, pi, makeCtx("s1", cwd), coordinatorDir),
    );

    const result = scheduleSelfWait({ storage, scheduler, sessionId: "s1" }, { prompt: "resume" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    storage.updateJob(result.job.id, { enabled: false });

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob(result.job.id)!.enabled).toBe(false);
  });

  it("delivers nothing after the job is removed before idle", () => {
    const cwd = tempCwd();
    const coordinatorDir = makeCoordinatorDir([{ sessionId: "s1", status: "settled" }]);
    setSubagentManager({ hasRunning: () => false });
    const storage = new CronStorage(cwd);
    const pi = makePi();
    const scheduler = track(
      new CronScheduler(storage, pi, makeCtx("s1", cwd), coordinatorDir),
    );

    const result = scheduleSelfWait({ storage, scheduler, sessionId: "s1" }, { prompt: "resume" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    storage.removeJob(result.job.id);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob(result.job.id)).toBeUndefined();
  });

  it("disables a delivered job, then the same key creates a fresh job", () => {
    const cwd = tempCwd();
    const coordinatorDir = makeCoordinatorDir([{ sessionId: "s1", status: "settled" }]);
    setSubagentManager({ hasRunning: () => false });
    const storage = new CronStorage(cwd);
    const pi = makePi();
    const scheduler = track(
      new CronScheduler(storage, pi, makeCtx("s1", cwd), coordinatorDir),
    );

    const first = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "resume", dedupeKey: "k" },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    (scheduler as any).evaluateWaitJobs();
    expect(storage.getJob(first.job.id)!.enabled).toBe(false);

    const second = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "resume", dedupeKey: "k" },
    );
    expect(second.ok && second.created).toBe(true);
    if (!second.ok) return;
    expect(second.job.id).not.toBe(first.job.id);
    expect(storage.getAllJobs()).toHaveLength(2);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(storage.getJob(first.job.id)!.runCount).toBe(1);
    expect(storage.getJob(second.job.id)!.runCount).toBe(1);
  });
});

describe("scheduleSelfWait — errors", () => {
  it("rejects an empty prompt", () => {
    const storage = new CronStorage(tempCwd());
    const result = scheduleSelfWait(
      { storage, scheduler: makeFakeScheduler(), sessionId: "s1" },
      { prompt: "" },
    );
    expect(result).toEqual({ ok: false, error: "A self-wait needs a non-empty prompt." });
    expect(storage.getAllJobs()).toHaveLength(0);
  });

  it("rejects an empty dedupe key", () => {
    const storage = new CronStorage(tempCwd());
    const result = scheduleSelfWait(
      { storage, scheduler: makeFakeScheduler(), sessionId: "s1" },
      { prompt: "p", dedupeKey: "  " },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("'dedupeKey' must be a non-empty string");
    expect(storage.getAllJobs()).toHaveLength(0);
  });

  it("rejects a missing session id", () => {
    const storage = new CronStorage(tempCwd());
    const result = scheduleSelfWait(
      { storage, scheduler: makeFakeScheduler(), sessionId: "" },
      { prompt: "p" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("session id");
  });

  it("rejects an unknown delivery target", () => {
    const storage = new CronStorage(tempCwd());
    const result = scheduleSelfWait(
      { storage, scheduler: makeFakeScheduler(), sessionId: "s1" },
      { prompt: "p", deliverTo: "elsewhere" as any },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("deliverTo");
  });

  it("rejects a duplicate name when no dedupe hit exists", () => {
    const cwd = tempCwd();
    const storage = new CronStorage(cwd);
    const scheduler = makeFakeScheduler();

    const first = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "p", name: "same-name" },
    );
    expect(first.ok).toBe(true);

    const second = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "p", name: "same-name" },
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('A job named "same-name" already exists');
    expect(storage.getAllJobs()).toHaveLength(1);
  });

  it("returns the existing job before applying the duplicate-name check", () => {
    const cwd = tempCwd();
    const storage = new CronStorage(cwd);
    const scheduler = makeFakeScheduler();

    const first = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "p", name: "same-name", dedupeKey: "k" },
    );
    expect(first.ok).toBe(true);

    const second = scheduleSelfWait(
      { storage, scheduler, sessionId: "s1" },
      { prompt: "p", name: "same-name", dedupeKey: "k" },
    );
    expect(second.ok && second.created).toBe(false);
  });
});
