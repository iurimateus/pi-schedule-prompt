import { beforeEach, describe, expect, it, vi } from "vitest";

// Optional `/schedule-prompt` argument (`hide` | `show` | `toggle`) and the
// Settings submenu entry that flips the same `jobsVisible` setting. Drives the
// real src/index.ts wiring against mocked collaborators, mirroring
// activation.test.ts.

const { loadSettingsMock, saveSettingsMock, jobs, widgets } = vi.hoisted(() => ({
  loadSettingsMock: vi.fn((): Record<string, unknown> => ({})),
  saveSettingsMock: vi.fn(() => true),
  jobs: [] as Array<{ id: string; name: string }>,
  widgets: [] as Array<{ show: any; hide: any; destroy: any }>,
}));

vi.mock("../src/scheduler.js", () => {
  return {
    CronScheduler: class {
      static isLoadedFor = () => true;
      start = vi.fn();
      stop = vi.fn();
      getNextRun = vi.fn(() => null);
    },
  };
});

vi.mock("../src/storage.js", () => {
  return {
    CronStorage: class {
      getAllJobs = () => jobs;
      removeJob = vi.fn();
    },
  };
});

vi.mock("../src/settings.js", () => {
  return {
    loadSettings: loadSettingsMock,
    saveSettings: saveSettingsMock,
  };
});

vi.mock("../src/tool.js", () => {
  return {
    createCronTool: vi.fn(() => ({ name: "schedule_prompt" })),
  };
});

vi.mock("../src/ui/cron-widget.js", () => {
  return {
    CronWidget: class {
      show = vi.fn();
      hide = vi.fn();
      destroy = vi.fn();
      constructor() {
        widgets.push(this);
      }
    },
  };
});

vi.mock("../src/ui/jobs-flow.js", () => ({ runJobsFlow: vi.fn() }));
vi.mock("../src/ui/add-flow.js", () => ({ runAddFlow: vi.fn() }));

import extension from "../src/index.js";

function makeHarness() {
  const active = ["bash", "read", "schedule_prompt"];
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const commands = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, def: any) => {
      commands.set(name, def);
    }),
    on: vi.fn((event: string, cb: any) => {
      handlers.set(event, cb);
    }),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((names: string[]) => {
      active.splice(0, active.length, ...names);
    }),
  };
  return { pi, handlers, commands, activeTools: () => [...active] };
}

function makeCtx(): any {
  return {
    cwd: "/tmp/pi-schedule-prompt-command-args-test",
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      select: vi.fn(async () => undefined),
      custom: vi.fn(),
      notify: vi.fn(),
    },
  };
}

const MENU: [string, string[]] = ["Scheduled Prompts", ["Jobs", "Settings"]];

/** Boot the extension, start a session (so `settings`/`widget` exist), and
 *  expose the command surface the way pi invokes it. */
async function startSession(settings: Record<string, unknown> = {}) {
  loadSettingsMock.mockReturnValue(settings);
  const h = makeHarness();
  await extension(h.pi as any);
  const ctx = makeCtx();
  await h.handlers.get("session_start")!({ reason: "startup" }, ctx);

  const command = h.commands.get("schedule-prompt")!;
  return {
    h,
    ctx,
    widget: () => widgets.at(-1)!,
    run: (args: unknown) => command.handler(args, ctx) as Promise<void>,
    completions: command.getArgumentCompletions as (prefix: string) => any,
  };
}

function oneJob() {
  jobs.push({ id: "job-1", name: "Job One" });
}

beforeEach(() => {
  loadSettingsMock.mockReset();
  loadSettingsMock.mockReturnValue({});
  saveSettingsMock.mockReset();
  saveSettingsMock.mockReturnValue(true);
  jobs.length = 0;
  widgets.length = 0;
});

describe("/schedule-prompt <arg>", () => {
  it("hide collapses the widget, persists jobsVisible:false, and skips the menu", async () => {
    oneJob();
    const s = await startSession();
    await s.run("hide");

    expect(s.ctx.ui.select).not.toHaveBeenCalled();
    expect(saveSettingsMock).toHaveBeenCalledWith(s.ctx.cwd, { jobsVisible: false });
    expect(s.ctx.ui.notify).toHaveBeenCalledWith(
      "Jobs hidden (1 job) — /schedule-prompt show to expand",
      "info",
    );
    // Collapsed still means mounted: only the widget-visibility setting unmounts.
    expect(s.widget().hide).not.toHaveBeenCalled();
    expect(s.widget().show).toHaveBeenCalledTimes(2);
    expect(s.h.activeTools()).toContain("schedule_prompt");
  });

  it("show expands the widget, persists jobsVisible:true, and skips the menu", async () => {
    jobs.push({ id: "a", name: "A" }, { id: "b", name: "B" });
    const s = await startSession({ jobsVisible: false });
    await s.run("show");

    expect(s.ctx.ui.select).not.toHaveBeenCalled();
    expect(saveSettingsMock).toHaveBeenCalledWith(s.ctx.cwd, { jobsVisible: true });
    expect(s.ctx.ui.notify).toHaveBeenCalledWith("Jobs shown (2 jobs)", "info");
    expect(s.h.activeTools()).toContain("schedule_prompt");
  });

  it("toggle flips the current in-memory state in both directions", async () => {
    oneJob();
    const s = await startSession();
    await s.run("toggle");
    expect(saveSettingsMock).toHaveBeenLastCalledWith(s.ctx.cwd, { jobsVisible: false });
    expect(s.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Jobs hidden (1 job) — /schedule-prompt show to expand",
      "info",
    );

    // Second run flips back without re-reading settings from disk.
    await s.run("toggle");
    expect(saveSettingsMock).toHaveBeenLastCalledWith(s.ctx.cwd, { jobsVisible: true });
    expect(s.ctx.ui.notify).toHaveBeenLastCalledWith("Jobs shown (1 job)", "info");
    expect(loadSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("still toggles when a hidden state was loaded from settings", async () => {
    const s = await startSession({ jobsVisible: false });
    await s.run("toggle");

    expect(saveSettingsMock).toHaveBeenCalledWith(s.ctx.cwd, { jobsVisible: true });
    expect(s.ctx.ui.notify).toHaveBeenCalledWith("Jobs shown (0 jobs)", "info");
  });

  it("appends the session-only suffix and warns when persistence fails", async () => {
    saveSettingsMock.mockReturnValue(false);
    const s = await startSession();
    await s.run("hide");

    expect(s.ctx.ui.notify).toHaveBeenCalledWith(
      "Jobs hidden (0 jobs) — /schedule-prompt show to expand (session only; failed to persist)",
      "warning",
    );
    expect(s.ctx.ui.select).not.toHaveBeenCalled();
  });

  it("rejects an unknown argument without opening the menu or saving", async () => {
    const s = await startSession();
    await s.run("bogus");

    expect(s.ctx.ui.select).not.toHaveBeenCalled();
    expect(saveSettingsMock).not.toHaveBeenCalled();
    expect(s.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("bogus"), "error");
    expect(s.h.activeTools()).toContain("schedule_prompt");
  });

  it("treats empty or non-string args as no argument (menu still opens)", async () => {
    const s = await startSession();
    await s.run("");
    await s.run("   ");
    await s.run([]);

    expect(s.ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(s.ctx.ui.select).toHaveBeenCalledWith(...MENU);
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });
});

describe("/schedule-prompt — Settings submenu", () => {
  it("offers Jobs visibility between widget visibility and the bind entry", async () => {
    const s = await startSession();
    s.ctx.ui.select
      .mockResolvedValueOnce("Settings")
      .mockResolvedValueOnce("Back");
    await s.run("");

    const [, options] = s.ctx.ui.select.mock.calls[1];
    expect(options).toEqual([
      "Widget visibility: shown",
      "Jobs visibility: shown",
      "Bind new jobs to session: yes",
      "Back",
    ]);
  });

  it("toggling Jobs visibility persists jobsVisible and re-renders the widget", async () => {
    oneJob();
    const s = await startSession();
    const showCallsBefore = s.widget().show.mock.calls.length;
    s.ctx.ui.select
      .mockResolvedValueOnce("Settings")
      .mockResolvedValueOnce("Jobs visibility: shown")
      .mockResolvedValueOnce("Back");
    await s.run("");

    expect(saveSettingsMock).toHaveBeenCalledWith(s.ctx.cwd, { jobsVisible: false });
    expect(s.widget().show.mock.calls.length).toBe(showCallsBefore + 1);
    expect(s.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("warns when the Jobs visibility toggle cannot be persisted", async () => {
    saveSettingsMock.mockReturnValue(false);
    const s = await startSession();
    s.ctx.ui.select
      .mockResolvedValueOnce("Settings")
      .mockResolvedValueOnce("Jobs visibility: shown")
      .mockResolvedValueOnce("Back");
    await s.run("");

    expect(s.ctx.ui.notify).toHaveBeenCalledWith(
      "Jobs hidden (session only; failed to persist)",
      "warning",
    );
  });
});

describe("/schedule-prompt — argument completions", () => {
  it("offers every argument for an empty prefix", async () => {
    const s = await startSession();
    expect(s.completions("").map((item: any) => item.value)).toEqual([
      "hide",
      "show",
      "toggle",
    ]);
    expect(s.completions("").every((item: any) => item.label)).toBe(true);
  });

  it("filters by prefix and returns null when nothing matches", async () => {
    const s = await startSession();
    expect(s.completions("s").map((item: any) => item.value)).toEqual(["show"]);
    expect(s.completions("zzz")).toBeNull();
  });
});
