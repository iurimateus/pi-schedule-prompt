import { type Static, Type } from "typebox";

/**
 * String enum as `{ type: "string", enum: [...] }` (Google-compatible; a union of
 * literals would emit `anyOf`). Same implementation as the `StringEnum` pi's
 * extension view of pi-ai provides at runtime; defined locally because pi-ai's
 * own export (>=1.5) returns a pi-schema type that TypeBox's `Static` can't infer.
 */
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

/**
 * Type of cron job
 */
export type CronJobType = "cron" | "once" | "interval" | "idle" | "wait";

/**
 * Sentinel stored in `CronJob.schedule` for `wait` jobs. Wait jobs have no
 * clock time: the target session delivers once it is idle and has no running
 * pi-subagents; if the target exits first, the owner session delivers instead.
 */
export const WAIT_SCHEDULE = "wait";

/**
 * Where a wait job's prompt lands once the wait completes. `"target"` (the
 * default) delivers into the waited-on session; `"owner"` delivers into the
 * session that created the job.
 */
export type WaitDelivery = "target" | "owner";

/**
 * Status of the last job execution
 */
export type CronJobStatus = "success" | "error" | "running";

/**
 * A scheduled cron job
 */
export interface CronJob {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Cron expression, ISO timestamp, interval description, or `WAIT_SCHEDULE` for wait jobs. */
  schedule: string;
  /** The prompt to execute */
  prompt: string;
  /** Whether the job is enabled */
  enabled: boolean;
  /** Type of job */
  type: CronJobType;
  /** Duration in milliseconds for interval or idle jobs */
  intervalMs?: number;
  /** When the job was created */
  createdAt: string;
  /** Last execution timestamp */
  lastRun?: string;
  /** Status of last execution */
  lastStatus?: CronJobStatus;
  /** Next scheduled run (computed) */
  nextRun?: string;
  /** Number of times executed */
  runCount: number;
  /** Optional description */
  description?: string;
  /** If set, run the prompt in a separate in-process agent session using this model instead of injecting into the current chat. */
  model?: string;
  /** Subagent jobs only. If true, the parent agent is woken up to react to the subagent's result. Default false (result lands in chat silently). */
  notify?: boolean;
  /** Subagent jobs only. If true, loads all registered extensions. If an array of package names, only those extensions. Default undefined (none). */
  extensions?: boolean | string[];
  /** Subagent jobs only. If true, loads all skills. If an array of skill names, only those skills. Default undefined (none). */
  skills?: boolean | string[];
  /**
   * Session id this job is bound to. When absent, every pi in the cwd loads it.
   * For wait jobs this is the *target* session to wait for.
   */
  session?: string;
  /** Wait jobs only. Session id that created the job (owner of the fallback delivery). */
  ownerSession?: string;
  /**
   * Wait jobs only. Where the prompt lands once the wait completes: `"target"`
   * (the default when absent) delivers into the waited-on `session`, `"owner"`
   * delivers into the creating `ownerSession` once the target is idle.
   */
  deliverTo?: WaitDelivery;
}

/**
 * Persistent storage for cron jobs
 */
export interface CronStore {
  /** Canonical project path the store belongs to. Informational; the file name is the key. */
  cwd?: string;
  /** Set once the project's legacy schedule-prompt file has been imported. */
  legacyImported?: boolean;
  jobs: CronJob[];
  version: number;
}

/**
 * Tool result details for LLM context
 */
export interface CronToolDetails {
  action: string;
  jobs: CronJob[];
  error?: string;
  jobId?: string;
  jobName?: string;
}

/**
 * Tool parameter schema
 */
export const CronToolParams = Type.Object({
  action: StringEnum(["add", "remove", "list", "enable", "disable", "update", "cleanup"], {
    description: "Action to perform",
  }),
  name: Type.Optional(
    Type.String({
      description: "Job name, auto-generated if omitted",
    })
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "Required for add unless type is 'wait'. Accepts six-field cron, ISO timestamp, relative time, or interval."
    })
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Required for add. Prompt text to execute.",
    })
  ),
  jobId: Type.Optional(
    Type.String({
      description: "Required for remove, enable, disable, or update.",
    })
  ),
  type: Type.Optional(
    StringEnum(["cron", "once", "interval", "idle", "wait"], {
      description:
        "Job type: cron (default), once, interval, idle, or wait. Idle fires once after the user is inactive for the scheduled duration; wait delivers inline when the target session is idle and needs no schedule."
    })
  ),
  session: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Wait jobs only. Target a tracked session in the same working directory. Defaults to the creating session.",
    })
  ),
  deliverTo: Type.Optional(
    StringEnum(["target", "owner"] as const, {
      description:
        "Wait jobs only. Where the prompt lands once the wait completes: 'target' (default) delivers into the waited-on session, 'owner' delivers into the creating session once the target is idle. Either mode falls back to the creating session if the target exits first.",
    })
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional job description",
    })
  ),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional model for a separate agent session. Omit to run inline.",
    })
  ),
  notify: Type.Optional(
    Type.Boolean({
      description:
        "Subagent jobs only. If true, notify the parent agent when the result is ready. Defaults to false.",
    })
  ),
  extensions: Type.Optional(
    Type.Union([
      Type.Boolean({
        description: "If true, loads all registered extensions.",
      }),
      Type.Array(Type.String(), {
        description: "List of extension package names to load.",
      }),
    ])
  ),
  skills: Type.Optional(
    Type.Union([
      Type.Boolean({
        description: "If true, loads all skills.",
      }),
      Type.Array(Type.String(), {
        description: "List of skill names to load.",
      }),
    ])
  ),
});

export type CronToolParamsType = Static<typeof CronToolParams>;

/**
 * Event emitted when a job is added, removed, or updated
 */
export interface CronChangeEvent {
  type: "add" | "remove" | "update" | "fire" | "error";
  job?: CronJob;
  jobId?: string;
  error?: string;
}
