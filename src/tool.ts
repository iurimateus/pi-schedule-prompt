import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { nanoid } from "nanoid";
import {
  checkWaitTarget,
  DEFAULT_COORDINATOR_DIR,
} from "./coordinator.js";
import { CronScheduler, displaySchedule, formatLocal } from "./scheduler.js";
import { scheduleSelfWait } from "./self-wait.js";
import type { JobScope } from "./settings.js";
import type { CronStorage } from "./storage.js";
import type { CronJob, CronJobType, CronToolDetails } from "./types.js";
import { CronToolParams } from "./types.js";

interface WaitTargetResult {
  ok: boolean;
  error?: string;
}

/**
 * Reject an explicit wait target that the coordinator does not track or that
 * is no longer active. The creator's working directory does not restrict the
 * target: a session in another workspace of the same repository can receive
 * the prompt once it is idle.
 */
function validateWaitTarget(sessionId: string, coordinatorDir: string): WaitTargetResult {
  const check = checkWaitTarget(coordinatorDir, sessionId);
  if (check === "untracked") {
    return {
      ok: false,
      error: `Target session is not tracked by the coordinator: ${sessionId}. Start it first, or omit 'session' to wait for the current session.`,
    };
  }
  if (check === "inactive") {
    return {
      ok: false,
      error: `Target session is not active: ${sessionId}. Start it first, or omit 'session' to wait for the current session.`,
    };
  }
  return { ok: true };
}

/**
 * Create the schedule_prompt tool definition.
 * `getDefaultScope` is a getter so live setting toggles affect the next `add`.
 * `coordinatorDir` is injectable so tests can use a temp directory.
 */
export function createCronTool(
  getStorage: () => CronStorage,
  getScheduler: () => CronScheduler,
  getDefaultScope: () => JobScope = () => "session",
  coordinatorDir: string = DEFAULT_COORDINATOR_DIR,
): ToolDefinition<typeof CronToolParams, CronToolDetails> {
  return {
    name: "schedule_prompt",
    label: "Schedule Prompt",
    description:
      "Schedule prompts by cron, ISO time, relative time, or interval. For add, provide prompt and schedule unless type is 'wait'. Type defaults to 'cron'; use 'once' for relative or ISO times, or 'wait' for inline delivery when the target session is idle.", 
    parameters: CronToolParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage();
      const scheduler = getScheduler();
      
      // Prevent recursive scheduling from within scheduled prompts
      if (params.action === "add") {
        const entries = ctx.sessionManager.getEntries();
        const recentEntries = entries.slice(-10); // Check last 10 entries
        const hasScheduledPrompt = recentEntries.some(
          (entry) => entry.type === "custom" && entry.customType === "scheduled_prompt"
        );
        
        if (hasScheduledPrompt) {
          throw new Error(
            "Cannot create scheduled prompts from within a scheduled prompt execution. This prevents infinite loops."
          );
        }
      }
      
      const action = params.action;
      const details: CronToolDetails = {
        action,
        jobs: [],
      };

      try {
        switch (action) {
          case "add": {
            const type = (params.type || "cron") as CronJobType;
            const isWait = type === "wait";

            if (!params.prompt) {
              throw new Error(
                "Missing required parameter for add action: 'prompt'. Provide the text to execute."
              );
            }
            if (!isWait && !params.schedule) {
              throw new Error(
                "Missing required parameter for add action: 'schedule'. Provide a schedule (e.g., '+10s', '*/5 * * * * *')."
              );
            }

            // Defense-in-depth - the schema also enforces this with minLength: 1,
            // but tool callers can bypass the schema by passing params directly.
            if (params.model !== undefined && params.model.length === 0) {
              throw new Error(
                "'model' must be a non-empty string. Omit the field for inline (no-model) jobs."
              );
            }

            // Generate name if not provided
            const jobName = params.name || `job-${nanoid(6)}`;

            // Check for duplicate names. Wait jobs defer this check to the
            // shared creation path, which looks for a dedupe hit first.
            if (!isWait && storage.hasJobWithName(jobName)) {
              throw new Error(
                `A job named "${jobName}" already exists. Please use a different name or remove the existing job first.`
              );
            }

            // Wait jobs deliver inline into the target/creating session, so they
            // have no subagent mode to run in.
            if (isWait && params.model !== undefined) {
              throw new Error("'wait' jobs run inline only and do not accept a 'model'.");
            }

            // `deliverTo` picks the destination chat for a wait job; a clock
            // job always delivers where it fires.
            if (!isWait && params.deliverTo !== undefined) {
              throw new Error("'deliverTo' applies to 'wait' jobs only.");
            }

            // `dedupeKey` gives wait creation a session-scoped identity; clock
            // jobs have no wait identity to deduplicate.
            if (!isWait && params.dedupeKey !== undefined) {
              throw new Error("'dedupeKey' applies to 'wait' jobs only.");
            }
            if (isWait && params.dedupeKey !== undefined && params.dedupeKey.length === 0) {
              throw new Error("'dedupeKey' must be a non-empty string.");
            }

            // Defense-in-depth - the schema enforces minLength: 1, but direct
            // callers can bypass the schema.
            if (isWait && params.session !== undefined && params.session.length === 0) {
              throw new Error("'session' must be a non-empty string.");
            }

            const mySessionId = ctx.sessionManager.getSessionId();

            let job: CronJob;
            let reused = false;
            if (isWait) {
              // Wait jobs have no clock time: `schedule` is a sentinel and an
              // explicit target must be a tracked, active session. The shared
              // creation path persists with the optional dedupeKey and arms the
              // job only when it created a new one.
              if (params.session !== undefined) {
                const target = validateWaitTarget(params.session, coordinatorDir);
                if (!target.ok) throw new Error(target.error);
              }
              const created = scheduleSelfWait(
                { storage, scheduler, sessionId: mySessionId },
                {
                  prompt: params.prompt,
                  targetSession: params.session ?? mySessionId,
                  dedupeKey: params.dedupeKey,
                  name: jobName,
                  description: params.description,
                  deliverTo: params.deliverTo,
                },
              );
              if (!created.ok) throw new Error(created.error);
              job = created.job;
              reused = !created.created;
            } else {
              const validated = CronScheduler.validateSchedule(type, params.schedule as string);
              if (!validated.ok) throw new Error(validated.error);
              job = {
                id: nanoid(10),
                name: jobName,
                schedule: validated.schedule,
                prompt: params.prompt,
                enabled: true,
                type,
                intervalMs: validated.intervalMs,
                createdAt: new Date().toISOString(),
                runCount: 0,
                description: params.description,
                model: params.model,
                notify: params.notify,
                extensions: params.extensions,
                skills: params.skills,
                session: getDefaultScope() === "session" ? mySessionId : undefined,
                ownerSession: undefined,
                deliverTo: undefined,
              };
              storage.addJob(job);
              scheduler.addJob(job);
            }
            details.jobs = [job];
            details.jobId = job.id;
            details.jobName = job.name;

            const modelLine = job.model
              ? `\nModel: ${job.model} (runs in subagent${job.notify ? ", notifies parent" : ""}${job.extensions ? ", extensions" : ""}${job.skills ? ", skills" : ""})`
              : "";
            const waitLine = isWait
              ? `\nWaits for session: ${job.session}\nDelivers to: ${job.deliverTo === "owner" ? "this session (once the target is idle)" : "the waited-on session"}\nFallback: this session if the target exits first`
              : `\nSchedule: ${displaySchedule(job)}`;
            const dedupeLine =
              isWait && job.dedupeKey
                ? `\nDedupe key: ${job.dedupeKey} (session-scoped)`
                : "";
            const reuseLine = reused
              ? "\nReused the existing wait job; no new job was created"
              : "";
            return {
              content: [
                {
                  type: "text",
                  text: `${reused ? "✓ Reused existing wait job" : "✓ Created cron job"} "${job.name}" (${job.id})\nType: ${job.type}${waitLine}${dedupeLine}${reuseLine}\nPrompt: ${job.prompt}${modelLine}`,
                },
              ],
              details,
            };
          }

          case "remove": {
            if (!params.jobId) {
              throw new Error("jobId is required for remove action");
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            const removed = storage.removeJob(params.jobId);
            if (removed) {
              scheduler.removeJob(params.jobId);
              details.jobId = params.jobId;
              details.jobName = job.name;

              return {
                content: [
                  {
                    type: "text",
                    text: `✓ Removed cron job "${job.name}" (${params.jobId})`,
                  },
                ],
                details,
              };
            }
            throw new Error(`Failed to remove job: ${params.jobId}`);
          }

          case "enable":
          case "disable": {
            if (!params.jobId) {
              throw new Error(`jobId is required for ${action} action`);
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            const enabled = action === "enable";
            storage.updateJob(params.jobId, { enabled });
            const updated = { ...job, enabled };
            scheduler.updateJob(params.jobId, updated);

            details.jobs = [updated];
            details.jobId = params.jobId;
            details.jobName = job.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ ${enabled ? "Enabled" : "Disabled"} cron job "${job.name}" (${params.jobId})`,
                },
              ],
              details,
            };
          }

          case "cleanup": {
            // Only touch jobs this session can see — foreign-session jobs are
            // owned by other pis. Unbound disabled jobs are fair game.
            const mySessionId = ctx.sessionManager.getSessionId();
            const disabledJobs = storage
              .getAllJobs()
              .filter((j) => !j.enabled && CronScheduler.isLoadedFor(j, mySessionId));

            if (disabledJobs.length === 0) {
              details.jobs = [];
              return {
                content: [
                  {
                    type: "text",
                    text: "No disabled jobs to clean up",
                  },
                ],
                details,
              };
            }

            for (const job of disabledJobs) {
              storage.removeJob(job.id);
              scheduler.removeJob(job.id);
            }

            details.jobs = disabledJobs;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Removed ${disabledJobs.length} disabled job(s):\n${disabledJobs.map((j) => `  - ${j.name} (${j.id})`).join("\n")}`,
                },
              ],
              details,
            };
          }

          case "update": {
            if (!params.jobId) {
              throw new Error("jobId is required for update action");
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            if (job.type === "wait" && params.schedule) {
              throw new Error(
                "'wait' jobs have no schedule; they deliver once the target session is idle, with an owner fallback if the target exits first."
              );
            }
            if (job.type === "wait" && params.model !== undefined) {
              throw new Error("'wait' jobs run inline only and do not accept a 'model'.");
            }
            if (job.type !== "wait" && params.deliverTo !== undefined) {
              throw new Error("'deliverTo' applies to 'wait' jobs only.");
            }

            // `dedupeKey` is fixed at creation: changing it after the fact
            // would silently change which job a later request reuses.
            if (params.dedupeKey !== undefined) {
              throw new Error(
                "'dedupeKey' is fixed at creation; it applies to 'wait' jobs created by add."
              );
            }

            // Reject empty-string model (schema also enforces minLength: 1).
            // To switch a job from subagent → inline mode, remove and re-add
            // it without `model` — there's no in-place clearing.
            if (params.model !== undefined && params.model.length === 0) {
              throw new Error(
                "'model' must be a non-empty string. To switch a job from subagent back to inline, remove and re-add it without a model."
              );
            }

            const updates: Partial<CronJob> = {};
            if (params.name && params.name !== job.name) {
              if (storage.hasJobWithName(params.name)) {
                throw new Error(
                  `A job named "${params.name}" already exists. Please use a different name.`
                );
              }
              updates.name = params.name;
            }
            if (params.prompt) updates.prompt = params.prompt;
            if (params.description !== undefined) updates.description = params.description;
            if (params.model !== undefined) updates.model = params.model;
            if (params.notify !== undefined) updates.notify = params.notify;
            if (params.extensions !== undefined) updates.extensions = params.extensions;
            if (params.skills !== undefined) updates.skills = params.skills;
            if (params.deliverTo !== undefined) updates.deliverTo = params.deliverTo;

            if (params.schedule) {
              // Same resolution rules as `add`: relative time (`+5m`) → ISO,
              // ISO accepted as-is, cron validated by croner.
              const validated = CronScheduler.validateSchedule(job.type, params.schedule);
              if (!validated.ok) throw new Error(validated.error);
              updates.schedule = validated.schedule;
              if (validated.intervalMs !== undefined) updates.intervalMs = validated.intervalMs;
            }

            storage.updateJob(params.jobId, updates);
            const updated = { ...job, ...updates };
            scheduler.updateJob(params.jobId, updated);

            details.jobs = [updated];
            details.jobId = params.jobId;
            details.jobName = updated.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Updated cron job "${updated.name}" (${params.jobId})`,
                },
              ],
              details,
            };
          }

          case "list": {
            const mySessionId = ctx.sessionManager.getSessionId();
            const jobs = storage
              .getAllJobs()
              .filter((j) => CronScheduler.isLoadedFor(j, mySessionId));
            details.jobs = jobs;

            if (jobs.length === 0) {
              return {
                content: [{ type: "text", text: "No cron jobs configured." }],
                details,
              };
            }

            const lines = ["Configured cron jobs:", ""];
            for (const job of jobs) {
              const status = job.enabled ? "✓" : "✗";
              const nextRun = scheduler.getNextRun(job.id);
              const nextStr = nextRun ? `Next: ${formatLocal(nextRun)}` : "";
              const lastStr = job.lastRun ? `Last: ${formatLocal(job.lastRun)}` : "Never run";

              lines.push(`${status} ${job.name} (${job.id})`);
              lines.push(
                job.type === "wait"
                  ? `  Type: wait | Waits for session: ${job.session} | Delivers to: ${job.deliverTo ?? "target"}`
                  : `  Type: ${job.type} | Schedule: ${displaySchedule(job)}`
              );
              if (job.model) {
                lines.push(`  Model: ${job.model} (runs in subagent${job.notify ? ", notifies parent" : ""}${job.extensions ? ", extensions" : ""}${job.skills ? ", skills" : ""})`);
              }
              lines.push(`  Prompt: ${job.prompt}`);
              lines.push(`  ${lastStr} ${nextStr ? `| ${nextStr}` : ""}`);
              lines.push(`  Runs: ${job.runCount} | Status: ${job.lastStatus || "pending"}`);
              if (job.description) {
                lines.push(`  Description: ${job.description}`);
              }
              lines.push("");
            }

            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details,
            };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        details.error = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `✗ Error: ${details.error}`,
            },
          ],
          details,
        };
      }
    },

    renderCall(params, theme) {
      const action = params.action;
      const name = params.name || params.jobId || "";
      const actionText = theme.fg("accent", action);
      const nameText = theme.fg("text", name);

      let text: string;
      switch (action) {
        case "add":
          text = `Adding cron job: ${nameText}`;
          break;
        case "remove":
          text = `Removing cron job: ${nameText}`;
          break;
        case "enable":
        case "disable":
          text = `${actionText.charAt(0).toUpperCase() + actionText.slice(1)} job: ${nameText}`;
          break;
        case "update":
          text = `Updating cron job: ${nameText}`;
          break;
        case "list":
          text = `Listing all cron jobs`;
          break;
        default:
          text = `${actionText} cron job`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      if (!result.details) {
        const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        return new Text(text, 0, 0);
      }

      const details = result.details;
      const lines: string[] = [];

      // Show action result
      if (details.error) {
        lines.push(theme.fg("error", `✗ Error: ${details.error}`));
      } else {
        const action = details.action;
        const jobName = details.jobName || details.jobId || "";
        lines.push(theme.fg("success", `✓ ${action} ${jobName}`));
      }

      // Show job table for list action
      if (details.action === "list" && details.jobs.length > 0) {
        lines.push("");
        lines.push(theme.bold("Cron Jobs:"));
        for (const job of details.jobs) {
          const status = job.enabled ? theme.fg("success", "✓") : theme.fg("muted", "✗");
          lines.push(`${status} ${theme.fg("text", job.name)} ${theme.fg("dim", `(${job.id})`)}`);
          lines.push(
            job.type === "wait"
              ? `  ${theme.fg("dim", "Type:")} wait ${theme.fg("dim", "| Waits for session:")} ${job.session} ${theme.fg("dim", "| Delivers to:")} ${job.deliverTo ?? "target"}`
              : `  ${theme.fg("dim", "Type:")} ${job.type} ${theme.fg("dim", "| Schedule:")} ${displaySchedule(job)}`
          );
          if (job.model) {
            const subagentTag = job.notify ? "(subagent, notifies parent)" : "(subagent)";
            const tags = [];
            if (job.extensions) tags.push("extensions");
            if (job.skills) tags.push("skills");
            const tagStr = tags.length ? ", " + tags.join(" + ") : "";
            lines.push(`  ${theme.fg("dim", "Model:")} ${job.model} ${theme.fg("dim", subagentTag)}${tagStr}`);
          }
          lines.push(`  ${theme.fg("dim", "Prompt:")} ${job.prompt}`);
          if (job.lastRun) {
            lines.push(`  ${theme.fg("dim", "Last run:")} ${formatLocal(job.lastRun)}`);
          }
          lines.push(`  ${theme.fg("dim", "Runs:")} ${job.runCount}`);
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  };
}
