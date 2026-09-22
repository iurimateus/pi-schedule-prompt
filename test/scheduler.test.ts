import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import type { CronJob } from "../src/types.js";

// Mock the subagent runner: scheduler tests don't actually want to spin up an
// in-memory AgentSession, just verify the scheduler's wiring around it.
vi.mock("../src/subagent.js", () => ({
  runSubagentOnce: vi.fn(),
}));

import { runSubagentOnce } from "../src/subagent.js";

const mockRunSubagentOnce = vi.mocked(runSubagentOnce);

// In-memory CronStorage stand-in.
function makeStorage(seedJobs: CronJob[] = []) {
  const jobs = new Map<string, CronJob>(seedJobs.map((j) => [j.id, j]));
  return {
    hasJobWithName: (name: string) =>
      Array.from(jobs.values()).some((j) => j.name === name),
    addJob: (job: CronJob) => jobs.set(job.id, job),
    removeJob: (id: string) => jobs.delete(id),
    updateJob: (id: string, partial: Partial<CronJob>) => {
      const job = jobs.get(id);
      if (!job) return false;
      Object.assign(job, partial);
      return true;
    },
    getJob: (id: string) => jobs.get(id),
    getAllJobs: () => Array.from(jobs.values()),
    getStorePath: () => ":memory:",
  } as any;
}

// Minimal ExtensionAPI: scheduler only touches sendMessage + events.emit.
function makePi() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
}

function makeCtx(sessionId = "test-session") {
  return {
    cwd: "/tmp",
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: { getSessionId: () => sessionId },
  } as any;
}

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "demo",
    schedule: "+10s",
    prompt: "do the thing",
    enabled: true,
    type: "once",
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("CronScheduler — subagent path marker delivery", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("posts a subagent_start marker with brief status text (no delivery options)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "result text" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);

    // First call is the start marker, fired synchronously before the IIFE runs.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [startMsg, startOpts] = pi.sendMessage.mock.calls[0];
    expect(startMsg.details.mode).toBe("subagent_start");
    expect(startMsg.details.model).toBe("haiku");
    // Non-empty content prevents session poisoning (empty content gets filtered
    // by pi-ai, leaving conversation ending on assistant — Anthropic 400s).
    expect(startMsg.content.length).toBeGreaterThan(0);
    expect(startMsg.content[0].text.length).toBeGreaterThan(0);
    expect(startOpts).toBeUndefined();
  });

  it("posts a subagent_done marker with non-empty content when notify is unset (prevents session poisoning)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.details.mode).toBe("subagent_done");
    expect(doneMsg.details.output).toBe("OK");
    // notify=false: no delivery options so parent isn't woken, but content
    // is non-empty to prevent session poisoning (empty content gets filtered
    // by pi-ai, leaving conversation ending on assistant — Anthropic 400s).
    expect(doneMsg.content.length).toBeGreaterThan(0);
    expect(doneMsg.content[0].text).toBe("OK");
    expect(doneOpts).toBeUndefined();
  });

  it("posts a wake-up subagent_done marker when notify is true (followUp + triggerTurn, snippet in content)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content).toEqual([{ type: "text", text: "OK" }]);
    expect(doneOpts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("posts a subagent_error marker with notify-gated wake-up", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "model exploded" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg, errOpts] = pi.sendMessage.mock.calls[1];
    expect(errMsg.details.mode).toBe("subagent_error");
    expect(errMsg.details.error).toBe("model exploded");
    expect(errMsg.content).toEqual([{ type: "text", text: "model exploded" }]);
    expect(errOpts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("truncates output longer than 500 chars with an ellipsis", async () => {
    const longText = "x".repeat(600);
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: longText });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.details.output).toHaveLength(501); // 500 + ellipsis char
    expect(doneMsg.details.output.endsWith("…")).toBe(true);
  });

  it("truncates long error messages the same way as success snippets", async () => {
    const longErr = "boom ".repeat(200); // 1000 chars
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: longErr });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    // Both `details.error` (renderer) and `content` (LLM, since notify=true)
    // see the truncated form so neither floods the chat with stack traces /
    // verbose API errors.
    expect(errMsg.details.error).toHaveLength(501);
    expect(errMsg.details.error.endsWith("…")).toBe(true);
    expect(errMsg.content[0].text).toEqual(errMsg.details.error);
  });

  it("updates lastStatus and increments runCount on success", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", runCount: 3 });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob("job-1").lastStatus).toBe("success"));

    const updated = storage.getJob("job-1");
    expect(updated.runCount).toBe(4);
    expect(updated.lastRun).toBeDefined();
  });

  it("updates lastStatus to error and does not advance runCount on failure", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "boom" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", runCount: 7 });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob("job-1").lastStatus).toBe("error"));

    expect(storage.getJob("job-1").runCount).toBe(7);
  });
});

  it("uses placeholder text when subagent produces no output with notify=true (#10)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent produces no output with notify=false (#10 + #12)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    // Even with notify=false, content must be non-empty to prevent session poisoning.
    expect(doneMsg.content.length).toBeGreaterThan(0);
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
    expect(doneMsg.details.output).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent errors with empty error message (#10)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
  });

  it("uses placeholder text when subagent errors with empty error message and notify=false (#10 + #12)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content.length).toBeGreaterThan(0);
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
    expect(errMsg.details.error).toBe("(subagent failed with empty error)");
  });

  it("uses placeholder text when subagent produces whitespace-only output (edge case)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "   " });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent returns whitespace-only error (edge case)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "   " });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
  });

describe("CronScheduler — start() recovery", () => {
  it("clears stale lastStatus=running on start (interrupted-by-shutdown recovery)", () => {
    // Simulates the previous session crashing/aborting mid-execution: storage
    // ended up with `lastStatus: "running"` because the IIFE bailed out on the
    // abort signal before reaching its terminal-status update. Without the
    // sweep, the widget would render `⟳` for a job that isn't actually running
    // until the cron next fires.
    //
    // Jobs use type=cron with a valid expression so scheduleJob() doesn't
    // overwrite lastStatus during start() (the once-with-past-timestamp path
    // sets lastStatus="error" itself).
    const pi = makePi();
    const cronSchedule = "0 0 * * * *"; // hourly
    const stuckJob = exampleJob({
      id: "stuck", type: "cron", schedule: cronSchedule, lastStatus: "running",
    });
    const cleanJob = exampleJob({
      id: "clean", type: "cron", schedule: cronSchedule, lastStatus: "success",
    });
    const errorJob = exampleJob({
      id: "errored", type: "cron", schedule: cronSchedule, lastStatus: "error",
    });
    const storage = makeStorage([stuckJob, cleanJob, errorJob]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    try {
      scheduler.start();

      expect(storage.getJob("stuck").lastStatus).toBeUndefined();
      // Other lastStatus values are left alone — we only sweep the one that
      // signals an interrupted run.
      expect(storage.getJob("clean").lastStatus).toBe("success");
      expect(storage.getJob("errored").lastStatus).toBe("error");
    } finally {
      scheduler.stop(); // tear down the live croner timers we just started
    }
  });
});

describe("CronScheduler — shutdown abort", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("aborts in-flight subagents when stop() is called", async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolveRun!: (r: { ok: true; text: string }) => void;
    mockRunSubagentOnce.mockImplementation(async (_ctx, _prompt, _model, signal) => {
      receivedSignal = signal;
      return new Promise((resolve) => {
        resolveRun = resolve;
        signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" } as any));
      });
    });

    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    // Wait until the IIFE has actually invoked the runner and we have its signal.
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    expect(receivedSignal!.aborted).toBe(false);

    scheduler.stop();
    expect(receivedSignal!.aborted).toBe(true);

    // Cleanup the dangling promise so vitest doesn't complain.
    resolveRun({ ok: true, text: "" });
  });

  it("does not post completion markers for runs aborted by stop()", async () => {
    let resolveRun!: (r: { ok: true; text: string }) => void;
    let signalReceived = false;
    mockRunSubagentOnce.mockImplementation(async (_ctx, _prompt, _model, signal) => {
      signalReceived = true;
      return new Promise((resolve) => {
        resolveRun = resolve;
        signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" } as any));
      });
    });

    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(signalReceived).toBe(true));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1); // start only

    scheduler.stop();

    // Wait for the IIFE to clean itself up after abort.
    await vi.waitFor(() => expect((scheduler as any).activeSubagents.size).toBe(0));
    // No done/error marker should be posted because the signal was aborted.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    resolveRun({ ok: true, text: "" });
  });

  it("clears activeSubagents after a natural completion", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect((scheduler as any).activeSubagents.size).toBe(0));
  });

  it("survives a thrown sendMessage and still advances storage to a terminal status", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    let firstCall = true;
    pi.sendMessage = vi.fn(() => {
      if (firstCall) {
        firstCall = false;
        return; // start marker succeeds
      }
      throw new Error("pi is stale (simulated teardown)");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const job = exampleJob({ model: "haiku" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());

    // Storage was advanced before the marker post, so the job is NOT stuck in "running"
    // even though sendMessage threw. This is the regression guard for the "stuck running"
    // failure mode.
    expect(storage.getJob("job-1").lastStatus).toBe("success");
    expect(storage.getJob("job-1").runCount).toBe(1);

    // The marker failure was logged via the inner try/catch (not the outer backstop).
    const loggedMessage = consoleSpy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain(`Failed to post subagent_done marker for job ${job.id}`);
    consoleSpy.mockRestore();
  });
});

describe("CronScheduler — inline path is unaffected by mock", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("does not call runSubagentOnce when job has no model", async () => {
    const pi = makePi();
    const job = exampleJob(); // no model
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    await (scheduler as any).executeJob(job);

    expect(mockRunSubagentOnce).not.toHaveBeenCalled();
    // Inline path: marker + sendUserMessage
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      "do the thing",
      { deliverAs: "followUp" },
    );
  });

  it("inline marker uses empty content and no delivery options (regression guard for double-injection)", async () => {
    const pi = makePi();
    const job = exampleJob(); // no model
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    await (scheduler as any).executeJob(job);

    // The marker must NOT carry the prompt in `content` — that would inject
    // the prompt into the LLM context a second time alongside `sendUserMessage`,
    // producing the "PROMPT\n\nPROMPT" / duplicate-turn symptom. No options
    // means: idle → silent append + emit (marker shows before the user
    // message); streaming → `agent.steer` with empty content (no LLM
    // context change, no extra turn triggered).
    const [markerMsg, markerOpts] = pi.sendMessage.mock.calls[0];
    expect(markerMsg.content).toEqual([]);
    expect(markerMsg.details).toEqual({
      jobId: job.id,
      jobName: job.name,
      prompt: job.prompt,
    });
    expect(markerOpts).toBeUndefined();
  });
});

describe("CronScheduler — session binding filter", () => {
  it("isLoadedFor: unbound job is loaded for any session", () => {
    expect(CronScheduler.isLoadedFor(exampleJob(), "any")).toBe(true);
    expect(CronScheduler.isLoadedFor(exampleJob(), undefined)).toBe(true);
  });

  it("isLoadedFor: bound job loads only for the matching session", () => {
    const j = exampleJob({ session: "A" });
    expect(CronScheduler.isLoadedFor(j, "A")).toBe(true);
    expect(CronScheduler.isLoadedFor(j, "B")).toBe(false);
    expect(CronScheduler.isLoadedFor(j, undefined)).toBe(false);
  });

  it("start() does not schedule foreign-session jobs", () => {
    const pi = makePi();
    const cronSchedule = "0 0 * * * *"; // hourly
    // Mark the foreign job lastStatus=running to also assert the stale-running
    // sweep skips it (we don't touch other sessions' state).
    const mine = exampleJob({
      id: "mine", type: "cron", schedule: cronSchedule, session: "session-A",
    });
    const foreign = exampleJob({
      id: "foreign", type: "cron", schedule: cronSchedule,
      session: "session-B", lastStatus: "running",
    });
    const unbound = exampleJob({
      id: "unbound", type: "cron", schedule: cronSchedule,
    });
    const storage = makeStorage([mine, foreign, unbound]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    try {
      scheduler.start();
      const jobsMap = (scheduler as any).jobs as Map<string, unknown>;
      expect(jobsMap.has("mine")).toBe(true);
      expect(jobsMap.has("unbound")).toBe(true);
      expect(jobsMap.has("foreign")).toBe(false);
      // Foreign session's stale-running flag is untouched — it's not ours.
      expect(storage.getJob("foreign").lastStatus).toBe("running");
    } finally {
      scheduler.stop();
    }
  });

  it("executeJob bails when storage now reports the job is bound to another session", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", session: "session-A" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-B"));

    await (scheduler as any).executeJob(job);

    // No marker, no user message — the defensive re-read caught the mismatch
    // before the scheduler dispatched.
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails when the job has been removed mid-tick", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j" });
    const storage = makeStorage([]); // job not in storage anymore
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    await (scheduler as any).executeJob(job);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails when the job was disabled mid-tick (e.g. hand-edited file)", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", enabled: false });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    await (scheduler as any).executeJob(job);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails before delegating to subagent when session no longer matches", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", model: "haiku", session: "session-A" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-B"));

    await (scheduler as any).executeJob(job);

    // Guard fires before the model branch — subagent never runs, no markers.
    expect(mockRunSubagentOnce).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("CronScheduler.validateSchedule", () => {
  it("interval: accepts valid duration, returns intervalMs", () => {
    const r = CronScheduler.validateSchedule("interval", "5m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schedule).toBe("5m");
      expect(r.intervalMs).toBe(5 * 60 * 1000);
    }
  });

  it("interval: rejects garbage with a useful hint", () => {
    const r = CronScheduler.validateSchedule("interval", "five minutes");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'5m', '1h', '30s'");
  });

  it("once: accepts relative time and resolves to ISO", () => {
    const r = CronScheduler.validateSchedule("once", "+5m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = new Date(r.schedule).getTime();
      expect(t - Date.now()).toBeGreaterThan(4 * 60 * 1000);
      expect(t - Date.now()).toBeLessThan(6 * 60 * 1000);
    }
  });

  it("once: rejects past timestamps", () => {
    const r = CronScheduler.validateSchedule("once", "2000-01-01T00:00:00Z");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("in the past");
  });

  it("once: rejects timestamps under 5s away with a relative-time suggestion", () => {
    const soon = new Date(Date.now() + 2000).toISOString();
    const r = CronScheduler.validateSchedule("once", soon);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("too soon");
      expect(r.error).toMatch(/use relative time like '\+\d+s'/);
    }
  });

  it("once: rejects unparseable timestamps", () => {
    const r = CronScheduler.validateSchedule("once", "not-a-date");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Invalid timestamp");
  });

  it("cron: accepts valid 6-field expression", () => {
    const r = CronScheduler.validateSchedule("cron", "0 0 9 * * *");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.schedule).toBe("0 0 9 * * *");
  });

  it("cron: rejects 5-field expression with field-count error", () => {
    const r = CronScheduler.validateSchedule("cron", "0 9 * * *");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("6 fields");
  });
});

describe("CronScheduler.describeSchedule", () => {
  it("cron: humanizes known patterns", () => {
    expect(CronScheduler.describeSchedule("cron", "0 0 0 * * *")).toBe("daily");
    expect(CronScheduler.describeSchedule("cron", "0 */5 * * * *")).toBe("every 5 min");
  });

  it("cron: returns raw expression untouched for unknown patterns (no guessing)", () => {
    const raw = "15 30 8 1,15 * 1-5";
    expect(CronScheduler.describeSchedule("cron", raw)).toBe(raw);
  });

  it("interval: prefixes with 'every'", () => {
    expect(CronScheduler.describeSchedule("interval", "5m")).toBe("every 5m");
  });

  it("once: renders ISO as 'Mon DD HH:MM'", () => {
    const iso = "2026-02-13T15:30:00.000Z";
    const out = CronScheduler.describeSchedule("once", iso);
    // Format depends on local TZ for the day/hour fields, so just assert shape.
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });
});

describe("CronScheduler — extensions/skills", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("passes extensions=true to runSubagentOnce when job has extensions=true", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", extensions: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: true, skills: undefined });
  });

  it("passes extensions=false to runSubagentOnce when job has no extensions", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" }); // no extensions
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: undefined, skills: undefined });
  });

  it("passes extensions=false to runSubagentOnce when job has extensions=false", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", extensions: false });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: false, skills: undefined });
  });
});

describe("CronScheduler — wait jobs", () => {
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  let originalManager: unknown;

  beforeEach(() => {
    originalManager = (globalThis as any)[MANAGER_KEY];
  });

  afterEach(() => {
    if (originalManager === undefined) delete (globalThis as any)[MANAGER_KEY];
    else (globalThis as any)[MANAGER_KEY] = originalManager;
  });

  /** Write one coordinator record file per entry into a temp state dir. */
  function makeCoordinatorDir(
    records: Array<{ sessionId: string; status: string; pid: number }>,
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "sched-wait-"));
    for (const r of records) {
      writeFileSync(
        join(dir, `${encodeURIComponent(r.sessionId)}.json`),
        JSON.stringify({ sessionId: r.sessionId, cwd: "/tmp", pid: r.pid, status: r.status }),
      );
    }
    return dir;
  }

  function setSubagentManager(manager: unknown): void {
    (globalThis as any)[MANAGER_KEY] = manager;
  }

  function waitJob(overrides: Partial<CronJob> = {}): CronJob {
    return exampleJob({
      id: "wait-1",
      type: "wait",
      schedule: "wait",
      session: "target-session",
      ownerSession: "owner-session",
      ...overrides,
    });
  }

  it("target delivers once when its coordinator record is settled and pi-subagents is idle", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "settled", pid: process.pid },
    ]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [marker, markerOpts] = pi.sendMessage.mock.calls[0];
    expect(marker.details.mode).toBe("wait_delivery");
    // Empty content + no options mirrors the inline path: no double injection.
    expect(marker.content).toEqual([]);
    expect(markerOpts).toBeUndefined();
    expect(pi.sendUserMessage).toHaveBeenCalledWith("do the thing", { deliverAs: "followUp" });

    const delivered = storage.getJob("wait-1");
    expect(delivered.enabled).toBe(false);
    expect(delivered.lastStatus).toBe("success");
    expect(delivered.runCount).toBe(1);
    expect(delivered.lastRun).toBeDefined();
  });

  it("delivers once: a second poll does not re-deliver", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "settled", pid: process.pid },
    ]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();
    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("target does not deliver while its coordinator record is working", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "working", pid: process.pid },
    ]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("target does not deliver while pi-subagents has a running agent", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "settled", pid: process.pid },
    ]);
    setSubagentManager({ hasRunning: () => true });
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("target does not deliver when the settled record's pid is dead", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "settled", pid: 0 },
    ]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("target does not deliver when its coordinator record is missing", () => {
    const dir = makeCoordinatorDir([]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not treat a missing pi-subagents manager as busy (delivers when settled)", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "settled", pid: process.pid },
    ]);
    // No globalThis manager registered - pi-subagents is not loaded here.
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("owner delivers fallback when the target record is exited", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "exited", pid: process.pid },
    ]);
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("owner-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    const [marker] = pi.sendMessage.mock.calls[0];
    expect(marker.details.mode).toBe("wait_fallback");
    expect(pi.sendUserMessage).toHaveBeenCalledWith("do the thing", { deliverAs: "followUp" });
    expect(storage.getJob("wait-1").enabled).toBe(false);
    expect(storage.getJob("wait-1").lastStatus).toBe("success");
  });

  it("owner keeps waiting when the target coordinator record is missing", () => {
    const dir = makeCoordinatorDir([]);
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("owner-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(storage.getJob("wait-1").enabled).toBe(true);
  });

  it("owner does not fall back while the target is alive and settled", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "settled", pid: process.pid },
    ]);
    const pi = makePi();
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("owner-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("self-wait (target === owner) delivers through the target path when settled", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "test-session", status: "settled", pid: process.pid },
    ]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    const storage = makeStorage([
      waitJob({ session: "test-session", ownerSession: "test-session" }),
    ]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("test-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendMessage.mock.calls[0][0].details.mode).toBe("wait_delivery");
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("disabled wait jobs are skipped", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "settled", pid: process.pid },
    ]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    const storage = makeStorage([waitJob({ enabled: false })]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("isLoadedFor: a wait job loads for both its target and its owner", () => {
    const job = waitJob();
    expect(CronScheduler.isLoadedFor(job, "target-session")).toBe(true);
    expect(CronScheduler.isLoadedFor(job, "owner-session")).toBe(true);
    expect(CronScheduler.isLoadedFor(job, "other-session")).toBe(false);
  });

  it("start() arms the wait poller and stop() clears it", () => {
    const dir = makeCoordinatorDir([]);
    const pi = makePi();
    const storage = makeStorage([]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    try {
      scheduler.start();
      expect((scheduler as any).waitPoll).toBeDefined();
    } finally {
      scheduler.stop();
    }
    expect((scheduler as any).waitPoll).toBeUndefined();
  });

  it("start() arms polling even with no local wait job, so foreign jobs are not delivered", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "other-target", status: "settled", pid: process.pid },
    ]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    const storage = makeStorage([
      waitJob({ session: "other-target", ownerSession: "other-owner" }),
    ]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("unrelated-session"), dir);

    try {
      scheduler.start();
      expect((scheduler as any).waitPoll).toBeDefined();
      (scheduler as any).evaluateWaitJobs();
      // Armed for discovery, but a job for another session is never delivered here.
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });

  it("discovers a wait job added by another process after this session started (#regression)", () => {
    vi.useFakeTimers();
    try {
      const dir = makeCoordinatorDir([
        { sessionId: "target-session", status: "settled", pid: process.pid },
      ]);
      setSubagentManager({ hasRunning: () => false });
      const pi = makePi();
      // Target starts with no wait job locally: shared storage is empty.
      const storage = makeStorage([]);
      const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);
      scheduler.start();
      expect(pi.sendUserMessage).not.toHaveBeenCalled();

      // The owner process (elsewhere) creates the job after start. Same shared
      // storage object models the shared on-disk store.
      storage.addJob(waitJob());

      // The target's poller must discover it on the next tick and deliver.
      vi.advanceTimersByTime(1000);

      expect(pi.sendMessage.mock.calls[0][0].details.mode).toBe("wait_delivery");
      expect(pi.sendUserMessage).toHaveBeenCalledWith("do the thing", { deliverAs: "followUp" });
      expect(storage.getJob("wait-1").enabled).toBe(false);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed delivery marks the job error and stays disabled (no re-fire)", () => {
    const dir = makeCoordinatorDir([
      { sessionId: "target-session", status: "settled", pid: process.pid },
    ]);
    setSubagentManager({ hasRunning: () => false });
    const pi = makePi();
    pi.sendUserMessage = vi.fn(() => {
      throw new Error("pi is stale (simulated teardown)");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = makeStorage([waitJob()]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("target-session"), dir);

    (scheduler as any).evaluateWaitJobs();
    (scheduler as any).evaluateWaitJobs();

    const failed = storage.getJob("wait-1");
    expect(failed.enabled).toBe(false);
    expect(failed.lastStatus).toBe("error");
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});
