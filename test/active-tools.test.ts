import { describe, expect, it, vi } from "vitest";

// The extension registers `schedule_prompt` once and leaves it active in every
// session. Toggling the active tool set on demand would change the prompt
// prefix and bust the provider cache, so these tests pin that invariant.

vi.mock("../src/scheduler.js", () => {
  return {
    CronScheduler: class {
      static isLoadedFor = () => true;
      start = vi.fn();
      stop = vi.fn(async () => {});
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
      migrateLegacy = () => "none";
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

vi.mock("../src/ui/add-flow.js", () => ({ runAddFlow: vi.fn() }));

import extension from "../src/index.js";

// Mock ExtensionAPI: records handlers/commands and tracks the active-tool set.
// `activeTools` is the state pi would send to the model.
function makeHarness(initialActive: string[]) {
  const active = [...initialActive];
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const commands = new Map<string, { handler: (args: unknown, ctx: any) => Promise<void> }>();
  const pi = {
    // The extension answers cross-extension API requests on this bus.
    events: { on: vi.fn(() => () => {}), emit: vi.fn() },
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
    cwd: "/tmp/pi-schedule-prompt-active-tools-test",
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      select: vi.fn(async () => undefined),
      custom: vi.fn(),
      notify: vi.fn(),
    },
  };
}

const OTHER_TOOLS = ["bash", "read", "edit"];
const ACTIVE = [...OTHER_TOOLS, "schedule_prompt"];

describe("schedule_prompt — always active", () => {
  it("registers the tool at load and keeps it in the active set", async () => {
    const h = makeHarness(ACTIVE);
    await extension(h.pi as any);

    expect(h.pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "schedule_prompt" }),
    );
    expect(h.activeTools()).toEqual(ACTIVE);
  });

  it("does not change the active tool set on session_start (startup, resume, reload)", async () => {
    const h = makeHarness(ACTIVE);
    await extension(h.pi as any);

    await h.handlers.get("session_start")!({ reason: "startup" }, makeCtx());
    await h.handlers.get("session_start")!({ reason: "resume" }, makeCtx());
    await h.handlers.get("session_start")!({ reason: "reload" }, makeCtx());

    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(h.activeTools()).toEqual(ACTIVE);
  });

  it("/schedule-prompt does not change the active tool set", async () => {
    const h = makeHarness(ACTIVE);
    await extension(h.pi as any);
    await h.handlers.get("session_start")!({ reason: "startup" }, makeCtx());

    await h.commands.get("schedule-prompt")!.handler([], makeCtx());

    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(h.activeTools()).toEqual(ACTIVE);
  });
});
