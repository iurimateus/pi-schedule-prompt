import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CronScheduler } from "../scheduler.js";
import type { CronStorage } from "../storage.js";
import type { CronJob } from "../types.js";

const BACK = "Back";
const QUIT = "Quit";
const ADD = "Add job";
const CLEANUP = "Clean up disabled jobs";

export async function runJobsFlow(
  ctx: ExtensionCommandContext,
  storage: CronStorage,
  scheduler: CronScheduler,
  mySessionId: string | undefined,
  runAdd: () => Promise<void>,
): Promise<void> {
  while (true) {
    const jobs = storage.getAllJobs();
    const mine = jobs.filter((job) => CronScheduler.isLoadedFor(job, mySessionId));
    const foreign = jobs.filter((job) => !CronScheduler.isLoadedFor(job, mySessionId));
    const labels = new Map<string, CronJob>();
    for (const job of [...mine, ...foreign]) {
      const isForeign = foreign.includes(job);
      const label = `${job.name} — ${job.enabled ? "enabled" : "disabled"} · ${isForeign ? "other session (read-only)" : job.session ? "session-only" : "shared"}`;
      labels.set(label, job);
    }
    const cleanupLabel = `${CLEANUP} (${mine.filter((job) => !job.enabled).length})`;
    const choice = await ctx.ui.select("Jobs", [ADD, ...labels.keys(), cleanupLabel, QUIT]);
    if (!choice || choice === QUIT) return;
    if (choice === ADD) {
      await runAdd();
      continue;
    }
    if (choice === cleanupLabel) {
      const disabled = mine.filter((job) => !job.enabled);
      if (disabled.length === 0) continue;
      if (await ctx.ui.confirm("Clean up disabled jobs", `Remove ${disabled.length} disabled job(s) belonging to this session?`)) {
        for (const job of disabled) {
          storage.removeJob(job.id);
          scheduler.removeJob(job.id);
        }
      }
      continue;
    }

    const job = labels.get(choice);
    if (!job) continue;
    const isForeign = foreign.includes(job);
    if (isForeign) {
      const back = await ctx.ui.select(`${job.name} (read-only)`, [BACK]);
      if (!back || back === BACK) continue;
    }

    const actions = [
      job.enabled ? "Disable job" : "Enable job",
      job.session ? "Make shared" : "Make session-only",
      "Remove job",
      BACK,
    ];
    const action = await ctx.ui.select(job.name, actions);
    if (!action || action === BACK) continue;
    if (action === "Disable job" || action === "Enable job") {
      const enabled = action === "Enable job";
      storage.updateJob(job.id, { enabled });
      scheduler.updateJob(job.id, { ...job, enabled });
    } else if (action === "Make shared" || action === "Make session-only") {
      const session = action === "Make shared" ? undefined : mySessionId;
      storage.updateJob(job.id, { session });
      scheduler.updateJob(job.id, { ...job, session });
    } else if (action === "Remove job") {
      if (await ctx.ui.confirm("Remove job", `Remove "${job.name}"?`)) {
        storage.removeJob(job.id);
        scheduler.removeJob(job.id);
      }
    }
  }
}
