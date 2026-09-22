/**
 * Interactive add flow for `/schedule-prompt`.
 * Steps the user through name → type → schedule (with re-prompt on validation
 * failure) → prompt → scope → confirm, or (for wait jobs) a live-session
 * picker → prompt → confirm. Saves and schedules the new job, or returns
 * silently on cancellation.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import {
  DEFAULT_COORDINATOR_DIR,
  listWaitTargets,
  type SessionRecord,
} from "../coordinator.js";
import { CronScheduler } from "../scheduler.js";
import type { ScheduleSettings } from "../settings.js";
import type { CronStorage } from "../storage.js";
import type { CronJob, CronJobType } from "../types.js";
import { WAIT_SCHEDULE } from "../types.js";

export async function runAddFlow(
  ctx: ExtensionCommandContext,
  storage: CronStorage,
  scheduler: CronScheduler,
  settings: ScheduleSettings,
  mySessionId: string | undefined,
  coordinatorDir: string = DEFAULT_COORDINATOR_DIR,
): Promise<void> {
  const name = await ctx.ui.input("Job Name", "Enter a name for this scheduled prompt");
  if (!name) return;

  if (storage.hasJobWithName(name)) {
    ctx.ui.notify(`A job named "${name}" already exists`, "error");
    return;
  }

  const WAIT_OPTION = "Wait (session idle)";
  const typeChoice = await ctx.ui.select("Job Type", [
    "Cron (recurring)",
    "Once (one-shot)",
    "Interval (periodic)",
    WAIT_OPTION,
  ]);
  if (!typeChoice) return;

  const typeMap: Record<string, CronJobType> = {
    "Cron (recurring)": "cron",
    "Once (one-shot)": "once",
    "Interval (periodic)": "interval",
    [WAIT_OPTION]: "wait",
  };
  const jobType = typeMap[typeChoice];

  // Wait jobs target one live session and carry no clock schedule, so pick the
  // target now and skip both the schedule field and the scope selector.
  let waitTarget: string | undefined;
  if (jobType === "wait") {
    const targets = listWaitTargets(coordinatorDir, ctx.cwd);
    if (targets.length === 0) {
      ctx.ui.notify("No live sessions to wait for in this working directory", "info");
      return;
    }
    const labels = targets.map((t) => waitTargetLabel(t, mySessionId));
    const choice = await ctx.ui.select("Wait for", labels);
    if (!choice) return;
    const index = labels.indexOf(choice);
    if (index === -1) return;
    waitTarget = targets[index].sessionId;
  }

  const placeholders: Record<string, string> = {
    cron: "6-field cron, e.g. '0 0 9 * * *' for 9am daily",
    once: "ISO timestamp or relative time (+10s, +5m, +1h)",
    interval: "Duration, e.g. '5m', '1h', '30s'",
  };

  // Re-prompt the schedule field on validation failure so the user
  // doesn't lose name/type and have to start over from the menu.
  let schedule: string | undefined;
  let intervalMs: number | undefined;
  if (jobType === "wait") {
    schedule = WAIT_SCHEDULE;
  } else {
    let title = "Schedule";
    while (true) {
      const raw = await ctx.ui.input(title, placeholders[jobType]);
      if (!raw) return;
      const result = CronScheduler.validateSchedule(jobType, raw.trim());
      if (result.ok) {
        schedule = result.schedule;
        intervalMs = result.intervalMs;
        break;
      }
      // The input component ignores the placeholder, so surface the error in
      // the title - where the dialog always renders it - to keep it visible.
      title = `Schedule — ${result.error}`;
    }
  }

  const prompt = await ctx.ui.input("Prompt", "Enter the prompt to execute");
  if (!prompt) return;

  let session: string | undefined;
  if (jobType === "wait") {
    session = waitTarget;
  } else {
    // Last decision before save. Default option is listed first, picked up
    // from the global `defaultJobScope` setting - so hitting enter takes the
    // configured default.
    const defaultIsSession = (settings.defaultJobScope ?? "session") === "session";
    const SCOPE_SESSION = "Bind to this session — only this pi fires it";
    const SCOPE_SHARED = "Shared — every pi in this cwd fires it (accepts duplicate fires)";
    const scopeChoice = await ctx.ui.select(
      "Scope",
      defaultIsSession ? [SCOPE_SESSION, SCOPE_SHARED] : [SCOPE_SHARED, SCOPE_SESSION],
    );
    if (!scopeChoice) return;
    session = scopeChoice === SCOPE_SESSION ? mySessionId : undefined;
  }

  const isWait = jobType === "wait";
  const summary = isWait
    ? `Save "${name}"?\nType: wait\nTarget: ${waitTarget}\nPrompt: ${prompt}`
    : `Save "${name}"?\nSchedule: ${CronScheduler.describeSchedule(jobType, schedule)}\nScope: ${session ? "session-bound" : "shared (any pi here)"}\nPrompt: ${prompt}`;
  const confirmed = await ctx.ui.confirm("Confirm", summary);
  if (!confirmed) return;

  const job: CronJob = {
    id: nanoid(10),
    name,
    schedule,
    prompt,
    enabled: true,
    type: jobType,
    intervalMs,
    createdAt: new Date().toISOString(),
    runCount: 0,
    session,
    ownerSession: isWait ? mySessionId : undefined,
  };

  storage.addJob(job);
  scheduler.addJob(job);
  const detail = isWait
    ? `wait for ${waitTarget}`
    : CronScheduler.describeSchedule(jobType, schedule);
  ctx.ui.notify(`Created scheduled prompt: ${name} (${detail})`, "info");
}

/** Selector label: the target id, its status, and a marker for this session. */
function waitTargetLabel(record: SessionRecord, mySessionId: string | undefined): string {
  const current = record.sessionId === mySessionId ? " · current" : "";
  return `${record.sessionId} [${record.status}]${current}`;
}
