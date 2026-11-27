import { beforeEach, describe, expect, it, vi } from "vitest";

// Covers the extension-to-extension API in src/api.ts:
// 1. Discovery over `pi.events` (request/answer protocol).
// 2. The handle's lifecycle, driven through the real src/index.ts wiring with
//    mocked collaborators.

const { storageInstances, schedulerInstances } = vi.hoisted(() => ({
  storageInstances: [] as any[],
  schedulerInstances: [] as any[],
}));

vi.mock("../src/scheduler.js", () => ({
  CronScheduler: class {
    static isLoadedFor = () => true;
    start = vi.fn();
    stop = vi.fn(async () => {});
    addJob = vi.fn();
    constructor() {
      schedulerInstances.push(this);
    }
  },
}));

vi.mock("../src/storage.js", () => ({
  CronStorage: class {
    getAllJobs = vi.fn(() => []);
    migrateLegacy = vi.fn(() => "none");
    removeJob = vi.fn();
    addJobDeduped = vi.fn((job: any) => ({ ok: true, job, added: true }));
    constructor() {
      storageInstances.push(this);
    }
  },
}));

vi.mock("../src/settings.js", () => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn(() => true),
}));

vi.mock("../src/tool.js", () => ({
  createCronTool: vi.fn(() => ({ name: "schedule_prompt" })),
}));

vi.mock("../src/ui/cron-widget.js", () => ({
  CronWidget: class {
    show = vi.fn();
    hide = vi.fn();
    destroy = vi.fn();
  },
}));

vi.mock("../src/ui/jobs-flow.js", () => ({ runJobsFlow: vi.fn() }));
vi.mock("../src/ui/add-flow.js", () => ({ runAddFlow: vi.fn() }));

import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  discoverSchedulePromptApi,
  registerSchedulePromptApi,
  SCHEDULE_PROMPT_API_READY_CHANNEL,
  SCHEDULE_PROMPT_API_REQUEST_CHANNEL,
  SCHEDULE_PROMPT_API_VERSION,
  type SchedulePromptApiReply,
} from "../src/api.js";
import extension from "../src/index.js";
import type { SelfWaitHost } from "../src/self-wait.js";

beforeEach(() => {
  storageInstances.length = 0;
  schedulerInstances.length = 0;
});

type Handler = (data: unknown) => void;

/** In-memory stand-in for pi's EventBus: synchronous, channel-scoped. */
function makeBus() {
  const listeners = new Map<string, Set<Handler>>();
  return {
    emit(channel: string, data: unknown) {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on(channel: string, handler: Handler) {
      const set = listeners.get(channel) ?? new Set<Handler>();
      set.add(handler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(channel);
      };
    },
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
  };
}

/** Host whose storage always creates the requested job. */
function makeHost(sessionId = "session-a") {
  const storage = {
    addJobDeduped: vi.fn((job: any) => ({ ok: true, job, added: true })),
  };
  const scheduler = { addJob: vi.fn() };
  const host = { storage, scheduler, sessionId } as unknown as SelfWaitHost;
  return { host, storage, scheduler };
}

function makeCtx(sessionId: string) {
  return {
    cwd: "/tmp/pi-schedule-prompt-api-test",
    sessionManager: { getSessionId: () => sessionId },
    ui: { select: vi.fn(async () => undefined), notify: vi.fn() },
  } as any;
}

describe("schedule-prompt API — discovery", () => {
  it("answers a discovery request with a versioned handle", async () => {
    const bus = makeBus();
    const pi = { events: bus } as any;
    const { host, storage } = makeHost();
    registerSchedulePromptApi(pi, { current: () => host });

    const api = await discoverSchedulePromptApi(pi);

    expect(api).toBeDefined();
    expect(api!.version).toBe(SCHEDULE_PROMPT_API_VERSION);
    const result = api!.scheduleSelfWait({ prompt: "resume", dedupeKey: "k" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.session).toBe("session-a");
    expect(storage.addJobDeduped).toHaveBeenCalledTimes(1);
  });

  it("resolves undefined when no extension answers before the timeout", async () => {
    vi.useFakeTimers();
    try {
      const bus = makeBus();
      const pi = { events: bus } as any;
      const pending = discoverSchedulePromptApi(pi, { timeoutMs: 50 });

      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toBeUndefined();
      expect(bus.listenerCount(SCHEDULE_PROMPT_API_READY_CHANNEL)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an answer that carries another request id", async () => {
    vi.useFakeTimers();
    try {
      const bus = makeBus();
      const pi = { events: bus } as any;
      const pending = discoverSchedulePromptApi(pi, { timeoutMs: 50 });

      bus.emit(SCHEDULE_PROMPT_API_READY_CHANNEL, {
        requestId: "someone-else",
        api: { version: SCHEDULE_PROMPT_API_VERSION },
      });
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores requests without a non-empty requestId", () => {
    const bus = makeBus();
    const pi = { events: bus } as any;
    const replies: SchedulePromptApiReply[] = [];
    bus.on(SCHEDULE_PROMPT_API_READY_CHANNEL, (data) =>
      replies.push(data as SchedulePromptApiReply),
    );
    registerSchedulePromptApi(pi, { current: () => undefined });

    for (const payload of [undefined, null, {}, { requestId: 42 }, { requestId: "" }]) {
      bus.emit(SCHEDULE_PROMPT_API_REQUEST_CHANNEL, payload);
    }

    expect(replies).toHaveLength(0);
  });

  it("stops answering requests after unsubscribe", () => {
    const bus = makeBus();
    const pi = { events: bus } as any;
    const unsubscribe = registerSchedulePromptApi(pi, { current: () => undefined });
    expect(bus.listenerCount(SCHEDULE_PROMPT_API_REQUEST_CHANNEL)).toBe(1);

    unsubscribe();

    expect(bus.listenerCount(SCHEDULE_PROMPT_API_REQUEST_CHANNEL)).toBe(0);
  });

  it("keeps the default discovery timeout at 2000 ms", () => {
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(2000);
  });
});

describe("schedule-prompt API — session lifecycle", () => {
  it("returns a handle before session_start whose calls fail with a retry hint", async () => {
    const bus = makeBus();
    const pi = {
      events: bus,
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    await extension(pi as any);

    const api = await discoverSchedulePromptApi(pi as any);

    expect(api).toBeDefined();
    const result = api!.scheduleSelfWait({ prompt: "resume" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no active session");
    expect(result.error).toContain("session_start");
  });

  it("creates a self-wait in the current session after session_start", async () => {
    const { handlers, pi } = await startHarness();
    const api = await discoverSchedulePromptApi(pi as any);
    expect(api).toBeDefined();

    await handlers.get("session_start")!({ reason: "startup" }, makeCtx("session-a"));

    const result = api!.scheduleSelfWait({ prompt: "resume", dedupeKey: "k" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.job).toMatchObject({
      type: "wait",
      prompt: "resume",
      session: "session-a",
      ownerSession: "session-a",
      dedupeKey: "k",
    });
    expect(storageInstances).toHaveLength(1);
    expect(storageInstances[0].addJobDeduped).toHaveBeenCalledTimes(1);
    expect(schedulerInstances[0].addJob).toHaveBeenCalledWith(result.job);
  });

  it("rejects calls after session_shutdown and works again on the next session", async () => {
    const { handlers, pi } = await startHarness();
    const api = (await discoverSchedulePromptApi(pi as any))!;

    await handlers.get("session_start")!({ reason: "startup" }, makeCtx("session-a"));
    await handlers.get("session_shutdown")!({}, makeCtx("session-a"));

    expect(schedulerInstances[0].stop).toHaveBeenCalled();
    const afterShutdown = api.scheduleSelfWait({ prompt: "resume" });
    expect(afterShutdown.ok).toBe(false);
    if (!afterShutdown.ok) expect(afterShutdown.error).toContain("no active session");

    await handlers.get("session_start")!({ reason: "resume" }, makeCtx("session-b"));

    expect(storageInstances).toHaveLength(2);
    expect(schedulerInstances).toHaveLength(2);
    expect(schedulerInstances[1].start).toHaveBeenCalled();
    const result = api.scheduleSelfWait({ prompt: "resume" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.session).toBe("session-b");
    expect(storageInstances[1].addJobDeduped).toHaveBeenCalledTimes(1);
  });
});

/** Load the extension and expose the lifecycle handlers pi would invoke. */
async function startHarness() {
  const bus = makeBus();
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const pi = {
    events: bus,
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, cb: any) => {
      handlers.set(event, cb);
    }),
  };
  await extension(pi as any);
  return { bus, handlers, pi };
}
