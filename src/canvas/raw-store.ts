/**
 * Raw Canvas response capture (SPEC.md section 15).
 *
 * Exists in Phase 0 although `--replay` is not built until Phase 5, because
 * capture cannot be done retroactively. By the time replay is needed there
 * would otherwise be months of history that was never recorded.
 *
 * Privacy policy (DECISIONS.md D-11). These captures contain third-party
 * personal data -- other students' names and emails in discussion topics,
 * submission comments, and group rosters. Therefore:
 *
 *   1. Every payload passes through the SHARED redaction hook in
 *      core/redact.ts before it is written. Not a second copy of that logic.
 *   2. The output root is gitignored AND blocked by .githooks/pre-commit.
 *   3. Captures expire. Default retention is 60 days, enforced by
 *      `npm run prune-raw`, so this does not grow without bound on a machine
 *      I have stopped thinking about.
 *
 * Redaction happens before the first write, not after the first incident.
 */

import { mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../core/redact.ts';
import type { Logger } from '../core/log.ts';
import type { Clock } from '../core/clock.ts';

export const RAW_ROOT = path.resolve(fileURLToPath(new URL('../../var/raw', import.meta.url)));

/**
 * Endpoints with no replay value. Capturing them stores personal data to buy
 * nothing: `--replay` re-runs classification, routing and version grouping, and
 * none of those consult the identity of the account holder.
 *
 * The principle is capture-what-replay-needs, not capture-everything-and-redact.
 */
const NO_REPLAY_VALUE = [/\/users\/self$/, /\/users\/self\/profile$/];

/** Query params that carry credentials and must never reach disk. */
const SENSITIVE_PARAMS = new Set(['access_token', 'verifier', 'token']);

/** Response headers worth keeping for replay and rate-limit forensics. */
const KEPT_HEADERS = [
  'link',
  'x-rate-limit-remaining',
  'x-request-cost',
  'x-canvas-meta',
  'content-type',
  'retry-after',
];

export interface CaptureEntry {
  method: string;
  url: string;
  status: number;
  headers: Headers;
  body: unknown;
  durationMs: number;
}

export interface RawStore {
  readonly enabled: boolean;
  capture(entry: CaptureEntry): Promise<void>;
}

export interface RawStoreOptions {
  runId: string;
  enabled: boolean;
  log: Logger;
  clock: Clock;
  root?: string;
}

export function createRawStore(options: RawStoreOptions): RawStore {
  if (!options.enabled) {
    return { enabled: false, capture: () => Promise.resolve() };
  }

  const root = options.root ?? RAW_ROOT;
  let sequence = 0;

  return {
    enabled: true,
    async capture(entry: CaptureEntry): Promise<void> {
      if (hasNoReplayValue(entry.url)) {
        options.log.debug('raw_store.skipped', { reason: 'no_replay_value' });
        return;
      }
      sequence += 1;
      const now = options.clock.now();
      const day = now.toISOString().slice(0, 10);
      const dir = path.join(root, day, options.runId);
      const name = `${String(sequence).padStart(4, '0')}-${slugify(entry.url)}.json`;

      const payload = {
        captured_at: now.toISOString(),
        run_id: options.runId,
        method: entry.method,
        url: scrubUrl(entry.url),
        status: entry.status,
        duration_ms: entry.durationMs,
        headers: pickHeaders(entry.headers),
        // Captures keep bodies AND identity (file names, folder names, titles)
        // where logs drop both. The tiers differ because the threat differs:
        // logs are published by CI on a public repo, whereas captures are
        // gitignored, pre-commit-blocked, local-only, and expire in 60 days.
        // Phase 5's --replay tunes ROUTING RULES, which match on exactly those
        // file and folder names -- redacting them would leave a capture that
        // replays nothing useful.
        //
        // Third-party PII is dropped at both tiers, unconditionally.
        body: redact(entry.body, { keepBodies: true, keepIdentity: true, maxDepth: 24 }),
      };

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      } catch (error) {
        // A capture failure must never fail a poll. Capture is a convenience;
        // notification is the deliverable.
        options.log.warn('raw_store.capture_failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function hasNoReplayValue(raw: string): boolean {
  try {
    const { pathname } = new URL(raw);
    return NO_REPLAY_VALUE.some((pattern) => pattern.test(pathname));
  } catch {
    return false;
  }
}

export function scrubUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAMS.has(key.toLowerCase())) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return '[unparsable-url]';
  }
}

function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = name === 'link' ? scrubLink(value) : value;
  }
  return out;
}

function scrubLink(value: string): string {
  return value.replace(/<([^>]+)>/g, (_match, url: string) => `<${scrubUrl(url)}>`);
}

function slugify(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/api\/v1\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'root';
  } catch {
    return 'request';
  }
}

export interface PruneOutcome {
  deletedDays: string[];
  keptDays: string[];
  cutoff: string;
}

/** Delete capture day-directories older than `retentionDays`. */
export async function pruneRawCaptures(opts: {
  root?: string;
  retentionDays: number;
  now: Date;
  log: Logger;
  dryRun: boolean;
}): Promise<PruneOutcome> {
  const root = opts.root ?? RAW_ROOT;
  const cutoffMs = opts.now.getTime() - opts.retentionDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  const outcome: PruneOutcome = { deletedDays: [], keptDays: [], cutoff };

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    opts.log.info('raw_store.prune.no_captures', { root });
    return outcome;
  }

  for (const entry of entries.sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const full = path.join(root, entry);
    const info = await stat(full).catch(() => null);
    if (info === null || !info.isDirectory()) continue;

    if (entry < cutoff) {
      if (opts.dryRun) {
        opts.log.info('raw_store.prune.would_delete', { day: entry, dry_run: true });
      } else {
        await rm(full, { recursive: true, force: true });
        opts.log.info('raw_store.prune.deleted', { day: entry });
      }
      outcome.deletedDays.push(entry);
    } else {
      outcome.keptDays.push(entry);
    }
  }

  return outcome;
}
