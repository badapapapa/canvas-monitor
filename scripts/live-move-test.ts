/**
 * One live test of the re-route move against the real OneDrive (DECISIONS.md
 * D-57), approved by the owner on 2026-09-22 on these conditions:
 *   - every request goes through RequestGuard (no bypass);
 *   - probe files only, inside 2610/_probe/;
 *   - no URLs printed: output goes only through diagnostic() (D-56);
 *   - report every path created, for deletion by hand (the app never deletes).
 *
 * Test 1: a normal move, _probe/_unsorted/probe-a.txt -> _probe/Tutorials/.
 * Test 2: the undocumented case. Drive A confirms _probe/Tutorials/probe-b.txt
 *         absent; a second, independent guarded drive (B) then uploads a file
 *         to that name; A's move is sent anyway. What OneDrive does with the
 *         clash -- 409, rename, or replace -- is the finding.
 *
 * Run locally only:  node scripts/live-move-test.ts
 */

process.loadEnvFile('.env');
import { startRun } from '../src/core/run-context.ts';
import { Config, setConfig } from '../src/core/config.ts';
import { diagnostic } from '../src/core/redact.ts';
import { quickXorHash } from '../src/archive/quickxor.ts';
import { GraphError, TokenProvider } from '../src/graph/auth.ts';
import { GraphDrive, type DriveItem } from '../src/graph/drive.ts';
import { RequestGuard, SCOPES, type RootSpec } from '../src/graph/guard.ts';

if (process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true') throw new Error('local only');

const ctx = await startRun({ command: 'live-move-test', dryRun: false, recordRun: false });
const config = await Config.load(ctx.db);
const root: RootSpec = { mode: 'appfolder' };
const say = (label: string, value: unknown = undefined) => process.stdout.write(`${label}${value === undefined ? '' : ` ${diagnostic(value)}`}\n`);

// One token chain shared by both drives, each with its OWN guard.
const tokenGuard = new RequestGuard({ root });
const tokens = new TokenProvider({
  clientId: config.require('graph_client_id'), scope: SCOPES.appfolder, guard: tokenGuard, log: ctx.log, clock: ctx.clock,
  refreshToken: () => config.require('graph_refresh_token'),
  saveRefreshToken: async (t) => { await setConfig(ctx.db, ctx.clock, 'graph_refresh_token', t); config.override('graph_refresh_token', t); },
});
const driveA = new GraphDrive({ root, guard: new RequestGuard({ root }), tokens, log: ctx.log, clock: ctx.clock });
const driveB = new GraphDrive({ root, guard: new RequestGuard({ root }), tokens, log: ctx.log, clock: ctx.clock });
driveA.allowMoveDestinations(['Tutorials']);

const P = ['2610', '_probe'];
const created: string[] = [];
const summary = (i: DriveItem | null) => i === null ? 'ABSENT' : { name: i.name, size: i.size, quickXorHash: i.file?.hashes?.quickXorHash ?? null, parent: (i as { parentReference?: { path?: string } }).parentReference?.path ?? null };

const A = Buffer.from('probe A: canvas-monitor live move test, 2026-09-22. Safe to delete.\n');
const B_SOURCE = Buffer.from('probe B (the file being moved): canvas-monitor live move test. Safe to delete.\n');
const B_RACED = Buffer.from('probe B (raced in at the destination): canvas-monitor live move test. Safe to delete.\n');
say('hashes', { A: quickXorHash(A), B_SOURCE: quickXorHash(B_SOURCE), B_RACED: quickXorHash(B_RACED) });

// --- setup, all under 2610/_probe/
for (const f of [[...P], [...P, '_unsorted'], [...P, 'Tutorials']]) {
  const before = await driveA.itemAt(f);
  await driveA.ensureFolders(f);
  if (before === null) created.push(`folder  ${f.join('/')}`);
}
const upA = await driveA.upload([...P, '_unsorted', 'probe-a.txt'], A);
created.push(`file    ${[...P, '_unsorted', 'probe-a.txt'].join('/')}`);
const upB = await driveA.upload([...P, '_unsorted', 'probe-b.txt'], B_SOURCE);
created.push(`file    ${[...P, '_unsorted', 'probe-b.txt'].join('/')}`);

// --- test 1: a normal move
say('\nTEST 1: normal move');
const movedA = await driveA.move([...P, '_unsorted', 'probe-a.txt'], [...P, 'Tutorials']);
say('  result', { sameId: movedA.id === upA.id, sameWebUrl: movedA.webUrl === upA.webUrl, ...(summary(movedA) as object) });
say('  at source now', summary(await driveA.itemAt([...P, '_unsorted', 'probe-a.txt'])));
say('  at destination now', summary(await driveA.itemAt([...P, 'Tutorials', 'probe-a.txt'])));

// --- test 2: a name taken between the check and the move
say('\nTEST 2: destination name taken after the check (race)');
let outcome: unknown;
try {
  const movedB = await driveA.move([...P, '_unsorted', 'probe-b.txt'], [...P, 'Tutorials'], {
    beforePatch: async () => {
      await driveB.ensureFolders([...P, 'Tutorials']);
      await driveB.upload([...P, 'Tutorials', 'probe-b.txt'], B_RACED);
      created.push(`file    ${[...P, 'Tutorials', 'probe-b.txt'].join('/')}  (the raced-in file)`);
    },
  });
  outcome = { status: 'MOVE SUCCEEDED', sameId: movedB.id === upB.id, ...(summary(movedB) as object) };
  if (movedB.name !== 'probe-b.txt') created.push(`file    ${[...P, 'Tutorials', movedB.name].join('/')}  (renamed by OneDrive)`);
} catch (error) {
  outcome = error instanceof GraphError
    ? { status: 'MOVE REFUSED', code: error.code, httpStatus: error.status, graphCode: error.graphCode }
    : { status: 'ERROR', message: error instanceof Error ? error.message : String(error) };
}
say('  outcome', outcome);
say('  at source now', summary(await driveA.itemAt([...P, '_unsorted', 'probe-b.txt'])));
say('  at destination now', summary(await driveA.itemAt([...P, 'Tutorials', 'probe-b.txt'])));

say('\nCreated (delete these on onedrive.live.com; paths are under Apps/Canvas Archive/):');
for (const c of created) say(`  ${c}`);
