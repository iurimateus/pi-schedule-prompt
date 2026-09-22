/**
 * Read the cross-process session records written by extensions/coordinator.ts.
 *
 * Records live as one JSON file per live Pi session under
 * `~/.pi/agent/coordinator.d/`. They are the only cross-process signal for
 * "is that other session still running, and is it idle" - exactly what wait
 * jobs need, since Pi has no cross-session delivery API.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionStatus = "working" | "settled" | "exited";

/** The subset of a coordinator record the scheduler observes. */
export interface SessionRecord {
  sessionId: string;
  cwd: string;
  pid: number;
  status: SessionStatus;
  /** Path to the session's JSONL file. Missing on records from older writers. */
  sessionFile?: string;
  /** Epoch ms when the session started. */
  startedAt?: number;
  /** Epoch ms of the last record update; orders the wait-target picker. */
  updatedAt?: number;
}

/** Directory holding one coordinator record per live session. */
export const DEFAULT_COORDINATOR_DIR = join(homedir(), ".pi", "agent", "coordinator.d");

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.sessionId === "string" &&
    r.sessionId.length > 0 &&
    typeof r.cwd === "string" &&
    typeof r.pid === "number" &&
    Number.isInteger(r.pid) &&
    (r.status === "working" || r.status === "settled" || r.status === "exited")
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseRecord(raw: string): SessionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isSessionRecord(parsed)) return undefined;
  const r = parsed as SessionRecord & Record<string, unknown>;
  return {
    sessionId: r.sessionId,
    cwd: r.cwd,
    pid: r.pid,
    status: r.status,
    sessionFile: isString(r.sessionFile) ? r.sessionFile : undefined,
    startedAt: typeof r.startedAt === "number" ? r.startedAt : undefined,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : undefined,
  };
}

/** Parse the record for `sessionId`, or `undefined` if absent or malformed. */
export function readSessionRecord(
  stateDir: string,
  sessionId: string,
): SessionRecord | undefined {
  const path = join(stateDir, `${encodeURIComponent(sessionId)}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return parseRecord(raw);
}

function listRecords(stateDir: string): SessionRecord[] {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = parseRecord(readFileSync(join(stateDir, name), "utf8"));
      if (record) records.push(record);
    } catch {
      // Skip malformed records instead of failing the whole listing.
    }
  }
  return records;
}

/** Whether a process with `pid` currently exists. EPERM still means alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * First line of a session file, bounded so a large session is not fully read.
 * Returns `undefined` when the file cannot be opened or read.
 */
function readFirstLine(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(65536);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const newline = buf.indexOf(0x0a, 0);
    return buf.subarray(0, newline === -1 ? bytes : newline).toString("utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the session at `sessionFile` is a root session. Child/subagent
 * sessions record a `parentSession` in their header and are excluded. Returns
 * false when the header is missing or malformed, so the picker fails closed
 * instead of offering a target it cannot classify.
 */
function isRootSession(sessionFile: string | undefined, sessionId: string): boolean {
  if (!sessionFile) return false;
  const line = readFirstLine(sessionFile);
  if (line === undefined || line.length === 0) return false;
  let header: unknown;
  try {
    header = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof header !== "object" || header === null) return false;
  const h = header as Record<string, unknown>;
  if (h.type !== "session" || h.id !== sessionId) return false;
  if (h.parentSession === undefined) return true;
  return isString(h.parentSession) && h.parentSession.length === 0;
}

/**
 * Live, non-exited coordinator records in `cwd`, newest first, without child
 * sessions. The wait-session picker's candidate list.
 */
export function listWaitTargets(stateDir: string, cwd: string): SessionRecord[] {
  return listRecords(stateDir)
    .filter((r) => r.status !== "exited" && isPidAlive(r.pid) && r.cwd === cwd)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .filter((r) => isRootSession(r.sessionFile, r.sessionId));
}
