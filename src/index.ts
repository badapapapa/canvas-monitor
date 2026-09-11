/**
 * Library entry point.
 *
 * SPEC.md section 3: the poller is a library with a thin CLI wrapper, not a
 * monolithic script, so individual stages can be run by hand and, later, by a
 * separate Next.js dashboard reading the same database.
 */

export { CanvasClient } from './canvas/client.ts';
export { CanvasHttp } from './canvas/http.ts';
export { RateLimitGovernor } from './canvas/rate-limit.ts';
export { createRawStore, pruneRawCaptures } from './canvas/raw-store.ts';
export { classifyResponse } from './canvas/classify-error.ts';
export { parseLinkHeader } from './canvas/paginate.ts';
export type { CanvasCourse, CanvasUser, CanvasTerm } from './canvas/types.ts';

export { Config, setConfig, tokenDaysRemaining, CONFIG_SPEC } from './core/config.ts';
export { createDb } from './core/db/writer.ts';
export type { Db, Mutator, TxHandle } from './core/db/writer.ts';
export { migrate, loadMigrations } from './core/db/migrate.ts';
export { startRun, finishRun } from './core/run-context.ts';
export type { RunContext } from './core/run-context.ts';
export { createLogger, silentLogger } from './core/log.ts';
export { redact, scrubString } from './core/redact.ts';
export { maskIdentity, suppressionNotice, IDENTITY_MASK } from './core/presentation.ts';
export { ok, failure, deniedOrAbsent, isOk, mapOk, describe } from './core/result.ts';
export type { Result } from './core/result.ts';
export { systemClock, fixedClock, tickingClock, sleep } from './core/clock.ts';
export * as time from './core/time.ts';

export { runProbe } from './cli/probe.ts';
export { runDiscover } from './discover/run.ts';
export { runSeedCourses } from './cli/seed-courses.ts';
export * as moduleCode from './discover/module-code.ts';
export { probeCoverage } from './discover/coverage.ts';
