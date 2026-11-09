import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CronScheduler } from "../src/scheduler.js";
import type { ScheduleSettings } from "../src/settings.js";
import type { CronStorage } from "../src/storage.js";
import { runAddFlow } from "../src/ui/add-flow.js";

// Scripted dialog replies. FIRST/LAST pick by position so tests do not hardcode
// every option string; ESC is a dismissed dialog (undefined / false).
const FIRST = Symbol("first");
const LAST = Symbol("last");
const ESC = Symbol("esc");

type Reply = string | boolean | typeof FIRST | typeof LAST | typeof ESC;

interface InputCall {
  dialog: "input";
  title: string;
}
interface SelectCall {
  dialog: "select";
  title: string;
  options: string[];
}
interface ConfirmCall {
  dialog: "confirm";
  title: string;
  message: string;
}
type DialogCall = InputCall | SelectCall | ConfirmCall;

// Each entry is [expected title prefix, reply]. A title mismatch or an
// exhausted script throws, so an unexpected step (e.g. a missed back step)
// fails the test with the dialog that was actually asked.
function makeHarness(script: [string, Reply][], opts: { cwd?: string } = {}) {
  const queue = [...script];
  const calls: DialogCall[] = [];

  const next = (dialog: DialogCall["dialog"], title: string): Reply => {
    const entry = queue.shift();
    if (!entry) throw new Error(`Unscripted ${dialog} dialog: "${title}"`);
    const [prefix, reply] = entry;
    if (!title.startsWith(prefix)) {
      throw new Error(`Expected "${prefix}" for ${dialog}, got "${title}"`);
    }
    return reply;
  };

  const ui = {
    input: vi.fn(async (title: string) => {
      calls.push({ dialog: "input", title });
      const reply = next("input", title);
      if (typeof reply === "string") return reply;
      if (reply === ESC) return undefined;
      throw new Error(`Bad reply for input "${title}": ${String(reply)}`);
    }),
    select: vi.fn(async (title: string, options: string[]) => {
      calls.push({ dialog: "select", title, options: [...options] });
      const reply = next("select", title);
      if (reply === FIRST) return options[0];
      if (reply === LAST) return options[options.length - 1];
      if (reply === ESC) return undefined;
      if (typeof reply === "string" && options.includes(reply)) return reply;
      throw new Error(`Bad reply for select "${title}": ${String(reply)}`);
    }),
    confirm: vi.fn(async (title: string, message: string) => {
      calls.push({ dialog: "confirm", title, message });
      const reply = next("confirm", title);
      if (typeof reply === "boolean") return reply;
      if (reply === ESC) return false;
      throw new Error(`Bad reply for confirm "${title}": ${String(reply)}`);
    }),
    notify: vi.fn(),
  };

  const addJob = vi.fn();
  const storage = { hasJobWithName: () => false, addJob } as unknown as CronStorage;
  const scheduler = { addJob: vi.fn() } as unknown as CronScheduler;
  const settings: ScheduleSettings = { defaultJobScope: "session" };
  const ctx = { ui, cwd: opts.cwd ?? "/work" } as unknown as ExtensionCommandContext;

  return { ctx, ui, storage, scheduler, settings, calls, addJob };
}

function titles(calls: DialogCall[]): string[] {
  return calls.map((call) => call.title);
}

function inputTitles(calls: DialogCall[]): string[] {
  return calls.filter((call): call is InputCall => call.dialog === "input").map((call) => call.title);
}

function selectCalls(calls: DialogCall[]): SelectCall[] {
  return calls.filter((call): call is SelectCall => call.dialog === "select");
}

const WAIT = "Wait (session idle)";
const CRON = "Cron (recurring)";
const SCHEDULE = "0 0 9 * * *";

function makeCoordinatorDir(): string {
  return mkdtempSync(join(tmpdir(), "add-flow-nav-"));
}

/** Register one live root session in the working directory a wait job targets. */
function writeWaitTarget(dir: string, id: string, updatedAt: number): void {
  const sessionFile = join(dir, `${id}.jsonl`);
  const header = { type: "session", id, timestamp: new Date().toISOString(), cwd: "/work" };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
  writeFileSync(
    join(dir, `${encodeURIComponent(id)}.json`),
    JSON.stringify({
      sessionId: id,
      sessionFile,
      cwd: "/work",
      pid: process.pid,
      status: "settled",
      startedAt: 0,
      updatedAt,
    }),
  );
}

describe("runAddFlow back navigation", () => {
  it("returns to the name step when Back is chosen on Job Type", async () => {
    const h = makeHarness([
      ["Job Name", "first name"],
      ["Job Type", LAST],
      ["Job Name", "second name"],
      ["Job Type", CRON],
      ["Schedule", SCHEDULE],
      ["Prompt", "the prompt"],
      ["Scope", FIRST],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "session-1");

    expect(titles(h.calls)).toEqual([
      "Job Name",
      "Job Type",
      "Job Name",
      "Job Type",
      "Schedule",
      "Prompt",
      "Scope",
      "Confirm",
    ]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject({
      name: "second name",
      schedule: SCHEDULE,
      prompt: "the prompt",
      type: "cron",
      session: "session-1",
      enabled: true,
      runCount: 0,
    });
    expect(h.scheduler.addJob).toHaveBeenCalledTimes(1);
  });

  it("exits without saving when the name step is dismissed", async () => {
    const h = makeHarness([["Job Name", ESC]]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "session-1");

    expect(h.calls).toHaveLength(1);
    expect(h.addJob).not.toHaveBeenCalled();
    expect(h.scheduler.addJob).not.toHaveBeenCalled();
    expect(h.ui.notify).not.toHaveBeenCalled();
  });

  it("steps back to the schedule when the prompt is dismissed", async () => {
    const h = makeHarness([
      ["Job Name", "my job"],
      ["Job Type", CRON],
      ["Schedule", SCHEDULE],
      ["Prompt", ESC],
      ["Schedule", SCHEDULE],
      ["Prompt", "the prompt"],
      ["Scope", FIRST],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "session-1");

    expect(inputTitles(h.calls)).toEqual(["Job Name", "Schedule", "Prompt", "Schedule", "Prompt"]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject({ name: "my job", prompt: "the prompt" });
  });

  it("returns to the scope step when the confirm is declined, saving once on Yes", async () => {
    const h = makeHarness([
      ["Job Name", "my job"],
      ["Job Type", CRON],
      ["Schedule", SCHEDULE],
      ["Prompt", "the prompt"],
      ["Scope", FIRST],
      ["Confirm", false],
      ["Scope", FIRST],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "session-1");

    expect(titles(h.calls)).toEqual([
      "Job Name",
      "Job Type",
      "Schedule",
      "Prompt",
      "Scope",
      "Confirm",
      "Scope",
      "Confirm",
    ]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject({
      name: "my job",
      schedule: SCHEDULE,
      prompt: "the prompt",
      session: "session-1",
    });
  });

  it("returns from confirm to the wait prompt when the confirm is dismissed", async () => {
    const dir = makeCoordinatorDir();
    writeWaitTarget(dir, "target", 100);
    const h = makeHarness([
      ["Job Name", "wait job"],
      ["Job Type", WAIT],
      ["Wait for", FIRST],
      ["Prompt", "first prompt"],
      ["Confirm", ESC],
      ["Prompt", "second prompt"],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "owner", dir);

    expect(inputTitles(h.calls)).toEqual(["Job Name", "Prompt", "Prompt"]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject({ type: "wait", prompt: "second prompt" });
  });

  it("returns to the prompt when Back is chosen on Scope", async () => {
    const h = makeHarness([
      ["Job Name", "my job"],
      ["Job Type", CRON],
      ["Schedule", SCHEDULE],
      ["Prompt", "the prompt"],
      ["Scope", LAST],
      ["Prompt", "the prompt"],
      ["Scope", FIRST],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "session-1");

    expect(inputTitles(h.calls)).toEqual(["Job Name", "Schedule", "Prompt", "Prompt"]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
  });

  it("offers Back as the last option of every select step", async () => {
    const h = makeHarness([
      ["Job Name", "my job"],
      ["Job Type", CRON],
      ["Schedule", SCHEDULE],
      ["Prompt", "the prompt"],
      ["Scope", FIRST],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "session-1");

    const selects = selectCalls(h.calls);
    expect(selects.map((call) => call.title)).toEqual(["Job Type", "Scope"]);
    for (const call of selects) {
      expect(call.options[call.options.length - 1]).toBe("Back");
    }
    expect(titles(h.calls).filter((title) => title === "Confirm")).toHaveLength(1);
  });

  it("returns to Job Type when Back is chosen on the Wait for picker", async () => {
    const dir = makeCoordinatorDir();
    writeWaitTarget(dir, "target", 100);
    const h = makeHarness([
      ["Job Name", "wait job"],
      ["Job Type", WAIT],
      ["Wait for", LAST],
      ["Job Type", WAIT],
      ["Wait for", FIRST],
      ["Prompt", "the prompt"],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "owner", dir);

    expect(titles(h.calls)).toEqual([
      "Job Name",
      "Job Type",
      "Wait for",
      "Job Type",
      "Wait for",
      "Prompt",
      "Confirm",
    ]);
    const waitPicker = selectCalls(h.calls).find((call) => call.title === "Wait for");
    expect(waitPicker).toBeDefined();
    if (!waitPicker) return;
    expect(waitPicker.options).toContain("target [settled]");
    expect(waitPicker.options[waitPicker.options.length - 1]).toBe("Back");
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject({
      type: "wait",
      schedule: "wait",
      session: "target",
      ownerSession: "owner",
      prompt: "the prompt",
    });
    expect(h.addJob.mock.calls[0][0].intervalMs).toBeUndefined();
  });

  it("returns to the Wait for picker when the wait prompt is dismissed", async () => {
    const dir = makeCoordinatorDir();
    writeWaitTarget(dir, "target", 100);
    const h = makeHarness([
      ["Job Name", "wait job"],
      ["Job Type", WAIT],
      ["Wait for", FIRST],
      ["Prompt", ESC],
      ["Wait for", FIRST],
      ["Prompt", "the prompt"],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "owner", dir);

    expect(titles(h.calls)).toEqual([
      "Job Name",
      "Job Type",
      "Wait for",
      "Prompt",
      "Wait for",
      "Prompt",
      "Confirm",
    ]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject({ type: "wait", session: "target" });
  });

  it("returns to Job Type when the Wait for picker is dismissed and saves nothing when abandoned", async () => {
    const dir = makeCoordinatorDir();
    writeWaitTarget(dir, "target", 100);
    const h = makeHarness([
      ["Job Name", "wait job"],
      ["Job Type", WAIT],
      ["Wait for", ESC],
      ["Job Type", ESC],
      ["Job Name", ESC],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "owner", dir);

    expect(titles(h.calls)).toEqual(["Job Name", "Job Type", "Wait for", "Job Type", "Job Name"]);
    expect(h.addJob).not.toHaveBeenCalled();
    expect(h.scheduler.addJob).not.toHaveBeenCalled();
    expect(h.ui.notify).not.toHaveBeenCalled();
  });

  it("re-prompts an invalid schedule with its error and returns to Job Type when dismissed", async () => {
    const h = makeHarness([
      ["Job Name", "my job"],
      ["Job Type", CRON],
      ["Schedule", "not a cron"],
      ["Schedule", ESC],
      ["Job Type", CRON],
      ["Schedule", SCHEDULE],
      ["Prompt", "the prompt"],
      ["Scope", FIRST],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "session-1");

    const scheduleTitles = inputTitles(h.calls).filter((title) => title.startsWith("Schedule"));
    expect(scheduleTitles).toHaveLength(3);
    expect(scheduleTitles[0]).toBe("Schedule");
    expect(scheduleTitles[1]).toContain("Invalid cron expression");
    expect(scheduleTitles[2]).toBe("Schedule");
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject({ schedule: SCHEDULE });
  });

  it("re-derives the step order from a type chosen after navigating back", async () => {
    const dir = makeCoordinatorDir();
    writeWaitTarget(dir, "target", 100);
    const h = makeHarness([
      ["Job Name", "switched job"],
      ["Job Type", CRON],
      ["Schedule", ESC],
      ["Job Type", WAIT],
      ["Wait for", FIRST],
      ["Prompt", "the prompt"],
      ["Confirm", true],
    ]);

    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, "owner", dir);

    expect(titles(h.calls)).toEqual([
      "Job Name",
      "Job Type",
      "Schedule",
      "Job Type",
      "Wait for",
      "Prompt",
      "Confirm",
    ]);
    expect(h.addJob).toHaveBeenCalledTimes(1);
    expect(h.addJob.mock.calls[0][0]).toMatchObject({ type: "wait", session: "target" });
  });
});
