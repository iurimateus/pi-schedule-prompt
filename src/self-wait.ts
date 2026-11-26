/**
 * Programmatic self-wait API.
 *
 * A self-wait is a `wait` job whose target and owner are the calling session:
 * it delivers its prompt back into that same chat once the session is idle
 * (`settled`, alive, and no running pi-subagents). This module is the shared
 * creation path for the `schedule_prompt` tool's self-wait case and for code
 * that imports it directly.
 *
 * Lifecycle: create (enabled) -> pending while the session is busy -> delivered
 * once (disabled + `lastStatus: "success"`) or failed once (disabled +
 * `lastStatus: "error"`) -> removed by disabled-job cleanup on the next session
 * start/shutdown or by an explicit remove. Disabling or removing the job before
 * delivery cancels it. An optional `dedupeKey` makes creation idempotent for the
 * session while the matching job is enabled.
 */

import { nanoid } from "nanoid";
import type { AddJobDedupedResult } from "./storage.js";
import type { CronJob, WaitDelivery } from "./types.js";
import { WAIT_SCHEDULE } from "./types.js";

/** The storage and scheduler surface a self-wait needs. */
export interface SelfWaitHost {
  storage: {
    addJobDeduped(job: CronJob, dedupeKey?: string): AddJobDedupedResult;
  };
  scheduler: {
    addJob(job: CronJob): void;
  };
  /** Session that receives the prompt; also the dedupe scope. */
  sessionId: string;
}

export interface SelfWaitOptions {
  prompt: string;
  /**
   * Target session. Defaults to the calling session, which makes this a
   * self-wait. An explicit target must already be active; the tool validates it.
   */
  targetSession?: string;
  /**
   * Session-scoped idempotency key. While an enabled self-wait with this key
   * exists for the session, creation returns that job instead of adding one.
   */
  dedupeKey?: string;
  /** Job name. Defaults to `job-<random>`. */
  name?: string;
  description?: string;
  /** `"target"` (default) delivers here; `"owner"` also resolves to here. */
  deliverTo?: WaitDelivery;
}

export type SelfWaitResult =
  | { ok: true; job: CronJob; created: boolean }
  | { ok: false; error: string };

const DELIVERIES: readonly WaitDelivery[] = ["target", "owner"];

/**
 * Create a self-wait job, or return the enabled job that holds `dedupeKey`.
 *
 * `created: false` means an existing job was reused; no new job was stored and
 * no scheduler call was made. A storage failure returns `ok: false`. A scheduler
 * failure also returns `ok: false`, but the job may already be persisted; a
 * retry with the same `dedupeKey` then returns that job.
 */
export function scheduleSelfWait(
  host: SelfWaitHost,
  options: SelfWaitOptions,
): SelfWaitResult {
  if (!host.sessionId) {
    return { ok: false, error: "A self-wait needs a non-empty session id." };
  }
  if (!options.prompt) {
    return { ok: false, error: "A self-wait needs a non-empty prompt." };
  }
  if (options.dedupeKey !== undefined && options.dedupeKey.trim().length === 0) {
    return {
      ok: false,
      error: "'dedupeKey' must be a non-empty string when provided.",
    };
  }

  const deliverTo = options.deliverTo ?? "target";
  if (!DELIVERIES.includes(deliverTo)) {
    return {
      ok: false,
      error: `'deliverTo' must be 'target' or 'owner', got '${deliverTo}'.`,
    };
  }

  const target = options.targetSession ?? host.sessionId;
  if (target.length === 0) {
    return { ok: false, error: "'targetSession' must be a non-empty string." };
  }

  const job: CronJob = {
    id: nanoid(10),
    name: options.name ?? `job-${nanoid(6)}`,
    schedule: WAIT_SCHEDULE,
    prompt: options.prompt,
    enabled: true,
    type: "wait",
    createdAt: new Date().toISOString(),
    runCount: 0,
    description: options.description,
    session: target,
    ownerSession: host.sessionId,
    deliverTo,
    dedupeKey: options.dedupeKey,
  };

  let stored: AddJobDedupedResult;
  try {
    stored = host.storage.addJobDeduped(job, job.dedupeKey);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to persist self-wait job: ${reason}` };
  }

  if (!stored.ok) {
    return {
      ok: false,
      error: `A job named "${job.name}" already exists. Please use a different name or remove the existing job first.`,
    };
  }

  if (stored.added) {
    try {
      host.scheduler.addJob(stored.job);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Failed to schedule self-wait job: ${reason}` };
    }
  }

  return { ok: true, job: stored.job, created: stored.added };
}
