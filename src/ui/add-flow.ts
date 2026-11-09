/**
 * Interactive add flow for `/schedule-prompt`.
 * A navigable wizard: name → type → schedule (re-polling while invalid) →
 * prompt → scope → confirm for clock jobs, or name → type → live-session
 * picker → prompt → confirm for wait jobs. Every step can go back - dialog
 * dismissal and selecting `Back` retreat one step - and the step order is
 * re-derived from the chosen type, so switching type skips or inserts steps.
 * Saves and schedules the new job; going back from the first step exits.
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

const BACK = "Back";

const CLOCK_STEPS = ["name", "type", "schedule", "prompt", "scope", "confirm"] as const;
const WAIT_STEPS = ["name", "type", "waitTarget", "prompt", "confirm"] as const;

type AddStep = (typeof CLOCK_STEPS)[number] | (typeof WAIT_STEPS)[number];

interface AddDraft {
  name?: string;
  jobType?: CronJobType;
  waitTarget?: string;
  schedule?: string;
  intervalMs?: number;
  prompt?: string;
  session?: string;
}

/** Wait jobs target one live session and carry no clock schedule or scope. */
function stepsFor(jobType: CronJobType | undefined): readonly AddStep[] {
  return jobType === "wait" ? WAIT_STEPS : CLOCK_STEPS;
}

export async function runAddFlow(
  ctx: ExtensionCommandContext,
  storage: CronStorage,
  scheduler: CronScheduler,
  settings: ScheduleSettings,
  mySessionId: string | undefined,
  coordinatorDir: string = DEFAULT_COORDINATOR_DIR,
): Promise<void> {
  const WAIT_OPTION = "Wait (session idle)";
  const typeMap: Record<string, CronJobType> = {
    "Cron (recurring)": "cron",
    "Once (one-shot)": "once",
    "Interval (periodic)": "interval",
    [WAIT_OPTION]: "wait",
  };
  const placeholders: Record<string, string> = {
    cron: "6-field cron, e.g. '0 0 9 * * *' for 9am daily",
    once: "ISO timestamp or relative time (+10s, +5m, +1h)",
    interval: "Duration, e.g. '5m', '1h', '30s'",
  };

  const draft: AddDraft = {};
  let steps = stepsFor(draft.jobType);
  let index = 0;
  // Shown in the schedule title while the user retries an invalid value.
  let scheduleError: string | undefined;

  const goBack = (): boolean => {
    index -= 1;
    return index >= 0;
  };

  while (true) {
    switch (steps[index]) {
      case "name": {
        const name = await ctx.ui.input("Job Name", "Enter a name for this scheduled prompt");
        if (!name) {
          if (!goBack()) return;
          break;
        }
        if (storage.hasJobWithName(name)) {
          ctx.ui.notify(`A job named "${name}" already exists`, "error");
          return;
        }
        draft.name = name;
        index += 1;
        break;
      }
      case "type": {
        const typeChoice = await ctx.ui.select("Job Type", [...Object.keys(typeMap), BACK]);
        const jobType = typeChoice ? typeMap[typeChoice] : undefined;
        if (!jobType) {
          if (!goBack()) return;
          break;
        }
        draft.jobType = jobType;
        steps = stepsFor(jobType);
        index += 1;
        break;
      }
      case "waitTarget": {
        const targets = listWaitTargets(coordinatorDir, ctx.cwd);
        if (targets.length === 0) {
          ctx.ui.notify("No live sessions to wait for in this working directory", "info");
          return;
        }
        const labels = targets.map((t) => waitTargetLabel(t, mySessionId));
        const choice = await ctx.ui.select("Wait for", [...labels, BACK]);
        const target = choice ? targets[labels.indexOf(choice)] : undefined;
        if (!target) {
          if (!goBack()) return;
          break;
        }
        draft.waitTarget = target.sessionId;
        index += 1;
        break;
      }
      case "schedule": {
        const jobType = draft.jobType!;
        // The input component ignores the placeholder, so surface the error in
        // the title - where the dialog always renders it - to keep it visible.
        const title = scheduleError ? `Schedule — ${scheduleError}` : "Schedule";
        const raw = await ctx.ui.input(title, placeholders[jobType]);
        if (!raw) {
          scheduleError = undefined;
          if (!goBack()) return;
          break;
        }
        const result = CronScheduler.validateSchedule(jobType, raw.trim());
        if (!result.ok) {
          scheduleError = result.error;
          break;
        }
        scheduleError = undefined;
        draft.schedule = result.schedule;
        draft.intervalMs = result.intervalMs;
        index += 1;
        break;
      }
      case "prompt": {
        const prompt = await ctx.ui.input("Prompt", "Enter the prompt to execute");
        if (!prompt) {
          if (!goBack()) return;
          break;
        }
        draft.prompt = prompt;
        index += 1;
        break;
      }
      case "scope": {
        // Last decision before save. Default option is listed first, picked up
        // from the global `defaultJobScope` setting - so hitting enter takes the
        // configured default.
        const defaultIsSession = (settings.defaultJobScope ?? "session") === "session";
        const SCOPE_SESSION = "Bind to this session — only this pi fires it";
        const SCOPE_SHARED = "Shared — every pi in this cwd fires it (accepts duplicate fires)";
        const scopeChoice = await ctx.ui.select(
          "Scope",
          defaultIsSession
            ? [SCOPE_SESSION, SCOPE_SHARED, BACK]
            : [SCOPE_SHARED, SCOPE_SESSION, BACK],
        );
        const scope = scopeChoice === BACK ? undefined : scopeChoice;
        if (!scope) {
          if (!goBack()) return;
          break;
        }
        draft.session = scope === SCOPE_SESSION ? mySessionId : undefined;
        index += 1;
        break;
      }
      case "confirm": {
        // Every answer is recorded by the time confirm is reached; wait jobs
        // skip the schedule step and carry the wait schedule instead.
        const jobType = draft.jobType!;
        const name = draft.name!;
        const prompt = draft.prompt!;
        const isWait = jobType === "wait";
        const schedule = isWait ? WAIT_SCHEDULE : draft.schedule!;
        const summary = isWait
          ? `Save "${name}"?\nType: wait\nTarget: ${draft.waitTarget}\nPrompt: ${prompt}`
          : `Save "${name}"?\nSchedule: ${CronScheduler.describeSchedule(jobType, schedule)}\nScope: ${draft.session ? "session-bound" : "shared (any pi here)"}\nPrompt: ${prompt}`;
        const confirmed = await ctx.ui.confirm("Confirm", summary);
        if (!confirmed) {
          if (!goBack()) return;
          break;
        }

        const job: CronJob = {
          id: nanoid(10),
          name,
          schedule,
          prompt,
          enabled: true,
          type: jobType,
          intervalMs: isWait ? undefined : draft.intervalMs,
          createdAt: new Date().toISOString(),
          runCount: 0,
          session: isWait ? draft.waitTarget : draft.session,
          ownerSession: isWait ? mySessionId : undefined,
        };

        storage.addJob(job);
        scheduler.addJob(job);
        const detail = isWait
          ? `wait for ${draft.waitTarget}`
          : CronScheduler.describeSchedule(jobType, schedule);
        ctx.ui.notify(`Created scheduled prompt: ${name} (${detail})`, "info");
        return;
      }
    }
  }
}

/** Selector label: the target id, its status, and a marker for this session. */
function waitTargetLabel(record: SessionRecord, mySessionId: string | undefined): string {
  const current = record.sessionId === mySessionId ? " · current" : "";
  return `${record.sessionId} [${record.status}]${current}`;
}
