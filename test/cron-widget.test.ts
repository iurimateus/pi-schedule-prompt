import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CronScheduler } from "../src/scheduler.js";
import type { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { CronWidget } from "../src/ui/cron-widget.js";

function makeStorage(jobs: CronJob[]): CronStorage {
  return {
    getJob: vi.fn((id: string) => jobs.find((j) => j.id === id)),
    getAllJobs: vi.fn(() => jobs),
    addJob: vi.fn(),
    removeJob: vi.fn(),
    updateJob: vi.fn(),
  } as any;
}

function makeScheduler(_jobs: CronJob[]): CronScheduler {
  return {
    getNextRun: vi.fn(() => null),
    isLoadedFor: vi.fn(() => true),
  } as any;
}

function makePi(): ExtensionAPI {
  return {
    events: { on: vi.fn(() => () => {}) },
  } as any;
}

function makeCtx(): any {
  return {
    ui: {
      setWidget: vi.fn(),
    },
  };
}

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-1",
    name: "Test Job",
    schedule: "0 * * * * *",
    type: "cron",
    prompt: "say hello",
    enabled: true,
    ...overrides,
  } as CronJob;
}

const passthroughTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeWidget(opts: {
  job?: CronJob;
  isVisible?: () => boolean;
  isExpanded?: () => boolean;
} = {}): CronWidget {
  const job = opts.job ?? exampleJob();
  return new CronWidget(
    makeStorage([job]),
    makeScheduler([job]) as any,
    makePi(),
    opts.isVisible ?? (() => true),
    opts.isExpanded ?? (() => true),
    "test-session",
  );
}

/** Mount the widget, then render it through the factory handed to setWidget. */
function renderLines(ctx: any, width = 100): string[] {
  const factory = ctx.ui.setWidget.mock.calls.at(-1)?.[1];
  return factory(null, passthroughTheme).render(width);
}

describe("CronWidget — render", () => {
  it("handles jobs with undefined runCount without crashing", () => {
    const widget = makeWidget({ job: exampleJob({ runCount: undefined }) });
    const ctx = makeCtx();
    widget.show(ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
    expect(() => renderLines(ctx)).not.toThrow();
  });
});

describe("CronWidget — jobs visibility", () => {
  it("collapses to a single header line without job rows", () => {
    const widget = makeWidget({ isExpanded: () => false });
    const ctx = makeCtx();
    widget.show(ctx);

    const lines = renderLines(ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Scheduled Prompts (1 jobs)");
    expect(lines[0]).not.toContain("Test Job");
    expect(lines[0]).not.toContain("say hello");
    // Collapsed still means mounted - that is the point of the setting.
    expect(ctx.ui.setWidget.mock.calls[0][1]).toBeTypeOf("function");
  });

  it("renders the job table when expanded", () => {
    const widget = makeWidget({ isExpanded: () => true });
    const ctx = makeCtx();
    widget.show(ctx);

    const rendered = renderLines(ctx).join("\n");
    expect(rendered).toContain("Scheduled Prompts (1 jobs)");
    expect(rendered).toContain("Test Job");
    expect(rendered).toContain("say hello");
  });

  it("unmounts when widget visibility is off", () => {
    const widget = makeWidget({ isVisible: () => false });
    const ctx = makeCtx();
    widget.show(ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith("schedule-prompts", undefined);
  });

  it("stops the refresh interval when collapsed and restarts it when expanded", () => {
    vi.useFakeTimers();
    try {
      let expanded = true;
      const widget = makeWidget({ isExpanded: () => expanded });
      const ctx = makeCtx();

      widget.show(ctx);
      expect(vi.getTimerCount()).toBe(1);

      // Collapsing must not leave a timer re-rendering a one-line widget.
      expanded = false;
      widget.show(ctx);
      expect(vi.getTimerCount()).toBe(0);

      expanded = true;
      widget.show(ctx);
      expect(vi.getTimerCount()).toBe(1);

      widget.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
