import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CronScheduler } from "../src/scheduler.js";
import type { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { runJobsFlow } from "../src/ui/jobs-flow.js";

const job: CronJob = {
  id: "job-1",
  name: "daily-report",
  type: "cron",
  schedule: "0 0 9 * * *",
  prompt: "write report",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  runCount: 0,
  session: "session-a",
};
const otherJob: CronJob = { ...job, id: "job-2", name: "other-report", session: "session-b" };

function makeHarness(choices: (string | undefined)[], confirmations: boolean[] = [true], jobs = [job]) {
  jobs = jobs.map((item) => ({ ...item }));
  const queue = [...choices];
  const confirmationQueue = [...confirmations];
  const select = vi.fn(async (title: string, options: string[]) => {
    const choice = queue.shift();
    if (choice !== undefined && !options.includes(choice)) throw new Error(`Unexpected choice for ${title}: ${choice}`);
    return choice;
  });
  const confirm = vi.fn(async () => confirmationQueue.shift() ?? false);
  const ui = { select, confirm };
  const storage = {
    getAllJobs: vi.fn(() => jobs),
    updateJob: vi.fn((id: string, update: Partial<CronJob>) => {
      const existing = jobs.find((item) => item.id === id);
      if (existing) Object.assign(existing, update);
    }),
    removeJob: vi.fn((id: string) => {
      const index = jobs.findIndex((item) => item.id === id);
      if (index !== -1) jobs.splice(index, 1);
    }),
  } as unknown as CronStorage;
  const scheduler = { updateJob: vi.fn(), removeJob: vi.fn() } as unknown as CronScheduler;
  return { ctx: { ui } as unknown as ExtensionCommandContext, ui, storage, scheduler, jobs };
}

const entry = "daily-report — enabled · session-only";
const quit = "Quit";
const back = "Back";

describe("runJobsFlow", () => {
  it("offers selectable job actions and toggles the chosen job", async () => {
    const h = makeHarness([entry, "Disable job", undefined]);

    await runJobsFlow(h.ctx, h.storage, h.scheduler, "session-a", vi.fn());

    expect(h.ui.select).toHaveBeenNthCalledWith(1, "Jobs", ["Add job", entry, "Clean up disabled jobs (0)", quit]);
    expect(h.ui.select).toHaveBeenNthCalledWith(2, "daily-report", ["Disable job", "Make shared", "Remove job", back]);
    expect(h.storage.updateJob).toHaveBeenCalledWith(job.id, { enabled: false });
    expect(h.scheduler.updateJob).toHaveBeenCalledWith(job.id, { ...job, enabled: false });
  });

  it("enables a disabled job", async () => {
    const disabled = { ...job, enabled: false };
    const h = makeHarness(["daily-report — disabled · session-only", "Enable job", quit], [true], [disabled]);
    await runJobsFlow(h.ctx, h.storage, h.scheduler, "session-a", vi.fn());
    expect(h.storage.updateJob).toHaveBeenCalledWith(job.id, { enabled: true });
  });

  it("changes scope in either direction", async () => {
    const h = makeHarness([entry, "Make shared", quit]);
    await runJobsFlow(h.ctx, h.storage, h.scheduler, "session-a", vi.fn());
    expect(h.storage.updateJob).toHaveBeenCalledWith(job.id, { session: undefined });
    expect(h.scheduler.updateJob).toHaveBeenCalledWith(job.id, { ...job, session: undefined });

    const shared = { ...job, session: undefined };
    const second = makeHarness(["daily-report — enabled · shared", "Make session-only", quit], [true], [shared]);
    await runJobsFlow(second.ctx, second.storage, second.scheduler, "session-a", vi.fn());
    expect(second.storage.updateJob).toHaveBeenCalledWith(job.id, { session: "session-a" });
  });

  it("removes one job only after confirmation", async () => {
    const h = makeHarness([entry, "Remove job", quit], [true]);
    await runJobsFlow(h.ctx, h.storage, h.scheduler, "session-a", vi.fn());
    expect(h.ui.confirm).toHaveBeenCalledWith("Remove job", 'Remove "daily-report"?');
    expect(h.storage.removeJob).toHaveBeenCalledExactlyOnceWith(job.id);
    expect(h.scheduler.removeJob).toHaveBeenCalledExactlyOnceWith(job.id);

    const canceled = makeHarness([entry, "Remove job", quit], [false]);
    await runJobsFlow(canceled.ctx, canceled.storage, canceled.scheduler, "session-a", vi.fn());
    expect(canceled.storage.removeJob).not.toHaveBeenCalled();
    expect(canceled.scheduler.removeJob).not.toHaveBeenCalled();
  });

  it("cleans up only disabled jobs available to this session after confirmation", async () => {
    const disabledMine = { ...job, enabled: false };
    const disabledForeign = { ...otherJob, enabled: false };
    const h = makeHarness(["Clean up disabled jobs (1)", quit], [true], [job, disabledMine, disabledForeign]);
    await runJobsFlow(h.ctx, h.storage, h.scheduler, "session-a", vi.fn());
    expect(h.ui.confirm).toHaveBeenCalledWith("Clean up disabled jobs", "Remove 1 disabled job(s) belonging to this session?");
    expect(h.storage.removeJob).toHaveBeenCalledExactlyOnceWith(disabledMine.id);
    expect(h.scheduler.removeJob).toHaveBeenCalledExactlyOnceWith(disabledMine.id);

    const canceled = makeHarness(["Clean up disabled jobs (1)", quit], [false], [disabledMine]);
    await runJobsFlow(canceled.ctx, canceled.storage, canceled.scheduler, "session-a", vi.fn());
    expect(canceled.storage.removeJob).not.toHaveBeenCalled();
  });

  it("delegates Add job and returns to the menu", async () => {
    const add = vi.fn(async () => {});
    const h = makeHarness(["Add job", quit]);
    await runJobsFlow(h.ctx, h.storage, h.scheduler, "session-a", add);
    expect(add).toHaveBeenCalledOnce();
    expect(h.ui.select).toHaveBeenCalledTimes(2);
  });

  it("exits only through the explicit Quit choice and safely cancels dismissal", async () => {
    const h = makeHarness([quit]);
    await runJobsFlow(h.ctx, h.storage, h.scheduler, "session-a", vi.fn());
    expect(h.ui.select).toHaveBeenCalledOnce();
    const dismissed = makeHarness([undefined]);
    await runJobsFlow(dismissed.ctx, dismissed.storage, dismissed.scheduler, "session-a", vi.fn());
    expect(dismissed.storage.updateJob).not.toHaveBeenCalled();
  });

  it("shows foreign-session jobs read-only without offering mutations", async () => {
    const foreignLabel = "other-report — enabled · other session (read-only)";
    const h = makeHarness([foreignLabel, back, quit], [true], [job, otherJob]);
    await runJobsFlow(h.ctx, h.storage, h.scheduler, "session-a", vi.fn());
    expect(h.ui.select).toHaveBeenNthCalledWith(1, "Jobs", ["Add job", entry, foreignLabel, "Clean up disabled jobs (0)", quit]);
    expect(h.ui.select).toHaveBeenNthCalledWith(2, "other-report (read-only)", [back]);
    expect(h.storage.updateJob).not.toHaveBeenCalled();
    expect(h.storage.removeJob).not.toHaveBeenCalled();
    expect(h.scheduler.updateJob).not.toHaveBeenCalled();
    expect(h.scheduler.removeJob).not.toHaveBeenCalled();
  });
});
