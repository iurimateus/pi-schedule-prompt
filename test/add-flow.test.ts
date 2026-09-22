import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import type { ScheduleSettings } from "../src/settings.js";
import type { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { runAddFlow } from "../src/ui/add-flow.js";

function makeHarness(inputs: (string | undefined)[]) {
  const queue = [...inputs];
  const input = vi.fn(async () => queue.shift());
  const ui = {
    input,
    select: vi.fn(async (_title: string, options: string[]) => options[0]),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
  };

  const addJob = vi.fn();
  const storage = { hasJobWithName: () => false, addJob } as unknown as CronStorage;
  const scheduler = { addJob: vi.fn() } as unknown as CronScheduler;
  const settings: ScheduleSettings = { defaultJobScope: "session" };
  const ctx = { ui, cwd: "/work" } as unknown as ExtensionCommandContext;

  return { ctx, ui, storage, scheduler, settings, addJob };
}

describe("runAddFlow schedule step", () => {
  it("re-prompts on an invalid schedule and shows the validation error", async () => {
    const h = makeHarness(["my job", "not a cron", "0 0 9 * * *", "the prompt"]);
    await runAddFlow(h.ctx, h.storage, h.scheduler, h.settings, undefined);

    expect(h.ui.input.mock.calls[1][0]).toBe("Schedule");
    expect(h.ui.input.mock.calls[2][0]).toContain("must have 6 fields");
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
