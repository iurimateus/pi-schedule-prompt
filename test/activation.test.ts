import { describe, expect, it, vi } from "vitest";

// Opt-in activation of `schedule_prompt`. This test drives the real index.ts
// wiring (session_start + /schedule-prompt) against a mock ExtensionAPI that
// tracks the active-tool set. Heavy collaborators are mocked so the test
// isolates active-tool management.

vi.mock("../src/scheduler.js", () => {
  return {
    CronScheduler: class {
      static isLoadedFor = () => true;
      start = vi.fn();
      stop = vi.fn();
      addJob = vi.fn();
      removeJob = vi.fn();
      updateJob = vi.fn();
      getNextRun = vi.fn(() => null);
    },
  };
});

vi.mock("../src/storage.js", () => {
  return {
    CronStorage: class {
      getAllJobs = () => [];
      removeJob = vi.fn();
    },
  };
});

vi.mock("../src/settings.js", () => {
  return {
    loadSettings: vi.fn(() => ({})),
    saveSettings: vi.fn(() => true),
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
    },
  };
});

vi.mock("../src/ui/jobs-view.js", () => ({ JobsView: class {} }));
vi.mock("../src/ui/add-flow.js", () => ({ runAddFlow: vi.fn() }));

import extension from "../src/index.js";

// Mock ExtensionAPI: records handlers/commands and keeps the active-tool set
// in sync, mirroring getActiveTools/setActiveTools semantics (get returns a
// copy; set replaces the set).
function makeHarness(initialActive: string[]) {
  const active = [...initialActive];
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const commands = new Map<string, { handler: (args: string[], ctx: any) => Promise<void> }>();
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

// Only the surface index.ts touches. The command activates the tool before
// opening the menu, so a cancelled select (undefined) exits right after
// activation - that is all these tests need.
function makeCtx(): any {
  return {
    cwd: "/tmp/pi-schedule-prompt-activation-test",
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      select: vi.fn(async () => undefined),
      custom: vi.fn(),
      notify: vi.fn(),
    },
  };
}

const OTHER_TOOLS = ["bash", "read", "edit"];

describe("schedule_prompt — opt-in activation", () => {
  it("registers the tool but session_start disables it, preserving other active tools", async () => {
    const h = makeHarness([...OTHER_TOOLS, "schedule_prompt"]);
    await extension(h.pi as any);

    // Registered but still active until the session starts.
    expect(h.pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "schedule_prompt" }),
    );
    expect(h.activeTools()).toContain("schedule_prompt");

    await h.handlers.get("session_start")!({ reason: "startup" }, makeCtx());

    expect(h.activeTools()).toEqual(OTHER_TOOLS);
    expect(h.activeTools()).not.toContain("schedule_prompt");
  });

  it("stays disabled across a repeated session_start (resume/reload)", async () => {
    const h = makeHarness([...OTHER_TOOLS, "schedule_prompt"]);
    await extension(h.pi as any);

    await h.handlers.get("session_start")!({ reason: "startup" }, makeCtx());
    await h.handlers.get("session_start")!({ reason: "resume" }, makeCtx());

    expect(h.activeTools()).toEqual(OTHER_TOOLS);
  });

  it("/schedule-prompt re-enables the tool, preserving other active tools", async () => {
    const h = makeHarness([...OTHER_TOOLS, "schedule_prompt"]);
    await extension(h.pi as any);
    await h.handlers.get("session_start")!({ reason: "startup" }, makeCtx());
    expect(h.activeTools()).toEqual(OTHER_TOOLS);

    // Cancelled menu (select -> undefined): activation must already have happened.
    await h.commands.get("schedule-prompt")!.handler([], makeCtx());

    expect(h.activeTools()).toEqual([...OTHER_TOOLS, "schedule_prompt"]);
  });

  it("running /schedule-prompt twice does not duplicate the tool", async () => {
    const h = makeHarness([...OTHER_TOOLS, "schedule_prompt"]);
    await extension(h.pi as any);
    await h.handlers.get("session_start")!({ reason: "startup" }, makeCtx());

    await h.commands.get("schedule-prompt")!.handler([], makeCtx());
    await h.commands.get("schedule-prompt")!.handler([], makeCtx());

    expect(h.activeTools()).toEqual([...OTHER_TOOLS, "schedule_prompt"]);
  });
});
