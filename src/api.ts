/**
 * Extension-to-extension API for scheduling a self-wait.
 *
 * Pi loads each extension as its own module, so another extension cannot import
 * this package's live storage or scheduler. Extensions communicate through
 * `pi.events` instead. A caller emits a request on
 * `SCHEDULE_PROMPT_API_REQUEST_CHANNEL`; this extension answers on
 * `SCHEDULE_PROMPT_API_READY_CHANNEL` with a handle bound to its live session.
 *
 * The protocol is in-process only. Both extensions must run in the same pi
 * process, which is the normal case for installed extensions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import {
  type SelfWaitHost,
  type SelfWaitResult,
  scheduleSelfWait,
} from "./self-wait.js";

/** API revision. Callers can reject a handle with an unknown version. */
export const SCHEDULE_PROMPT_API_VERSION = 1;

/** Channel a caller uses to ask for the API handle. */
export const SCHEDULE_PROMPT_API_REQUEST_CHANNEL = "schedule-prompt:api-request";

/** Channel this extension uses to return the API handle. */
export const SCHEDULE_PROMPT_API_READY_CHANNEL = "schedule-prompt:api";

/** Options accepted by `SchedulePromptApi.scheduleSelfWait`. */
export interface SelfWaitApiOptions {
  /** Text delivered into the current session once it is idle. */
  prompt: string;
  /**
   * Session-scoped idempotency key. While an enabled self-wait with this key
   * exists for the session, the call returns that job. The guarantee covers
   * this process only; see `CronStorage.addJobDeduped`.
   */
  dedupeKey?: string;
  /** Job name. Defaults to a generated name. */
  name?: string;
  /** Free-form job description. */
  description?: string;
}

/**
 * Handle returned to another extension. `scheduleSelfWait` targets the session
 * that owns this extension instance; the handle cannot address another session.
 */
export interface SchedulePromptApi {
  readonly version: typeof SCHEDULE_PROMPT_API_VERSION;
  /** Create or reuse a self-wait for the current session. */
  scheduleSelfWait(options: SelfWaitApiOptions): SelfWaitResult;
}

/** Reply payload on `SCHEDULE_PROMPT_API_READY_CHANNEL`. */
export type SchedulePromptApiReply =
  | { requestId: string; api: SchedulePromptApi }
  | { requestId: string; error: string };

/** Supplies the live session resources, or `undefined` when no session is active. */
export interface SelfWaitHostSource {
  current(): SelfWaitHost | undefined;
}

/**
 * Create an API handle that delegates to the source's current host.
 *
 * A call made before `session_start` or after `session_shutdown` returns
 * `ok: false` with a retry hint. It does not throw.
 */
export function createSchedulePromptApi(source: SelfWaitHostSource): SchedulePromptApi {
  return {
    version: SCHEDULE_PROMPT_API_VERSION,
    scheduleSelfWait(options) {
      const host = source.current();
      if (!host) {
        return {
          ok: false,
          error:
            "schedule-prompt has no active session. Retry after its session_start event.",
        };
      }
      return scheduleSelfWait(host, options);
    },
  };
}

/**
 * Answer API requests on `pi.events`. Call once from the extension factory.
 * Returns an unsubscribe function that removes the request listener.
 */
export function registerSchedulePromptApi(
  pi: ExtensionAPI,
  source: SelfWaitHostSource,
): () => void {
  const api = createSchedulePromptApi(source);
  return pi.events.on(SCHEDULE_PROMPT_API_REQUEST_CHANNEL, (data) => {
    const requestId = readRequestId(data);
    if (requestId === undefined) return;
    const reply: SchedulePromptApiReply = { requestId, api };
    pi.events.emit(SCHEDULE_PROMPT_API_READY_CHANNEL, reply);
  });
}

/** Discovery timeout in milliseconds. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 2000;

export interface DiscoverSchedulePromptApiOptions {
  /** How long to wait for an answer. Defaults to 2000 ms. */
  timeoutMs?: number;
}

/**
 * Ask the running schedule-prompt extension for its API handle.
 *
 * Resolves `undefined` when no extension answers before the timeout. Pair this
 * with a `session_start` listener when the caller can load first.
 */
export function discoverSchedulePromptApi(
  pi: ExtensionAPI,
  options: DiscoverSchedulePromptApiOptions = {},
): Promise<SchedulePromptApi | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  return new Promise((resolve) => {
    const requestId = randomUUID();
    let settled = false;

    const settle = (api?: SchedulePromptApi) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(api);
    };

    const unsubscribe = pi.events.on(SCHEDULE_PROMPT_API_READY_CHANNEL, (data) => {
      const reply = data as Partial<SchedulePromptApiReply> | undefined;
      if (!reply || reply.requestId !== requestId) return;
      settle("api" in reply ? (reply as { api: SchedulePromptApi }).api : undefined);
    });

    const timer = setTimeout(() => settle(undefined), timeoutMs);
    timer.unref?.();

    pi.events.emit(SCHEDULE_PROMPT_API_REQUEST_CHANNEL, { requestId });
  });
}

/** Read a non-empty `requestId` from an untrusted event payload. */
function readRequestId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const requestId = (data as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}
