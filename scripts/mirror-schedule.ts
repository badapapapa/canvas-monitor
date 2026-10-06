/**
 * The mirror's launchd schedule (DECISIONS.md D-58): every 20 minutes while
 * the Mac is on, and at login. Prints the plist by default; writes and loads
 * it only with --install, and removes it with --uninstall.
 *
 *   node scripts/mirror-schedule.ts            # print, change nothing
 *   node scripts/mirror-schedule.ts --install  # only once approved
 *   node scripts/mirror-schedule.ts --uninstall
 *   node scripts/mirror-schedule.ts --materialize-test <archive path>   # D-77: one-shot test agent
 *   node scripts/mirror-schedule.ts --remove-materialize-test
 *
 * The plist runs the mirror's OWN copy of node (var/runtime/bin/node, made by
 * scripts/mirror-runtime.ts, D-59), so the macOS file-access grant belongs to
 * that binary alone and survives `brew upgrade node`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'local.canvas-monitor.mirror';
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtimeNode = path.join(repo, 'var', 'runtime', 'bin', 'node');
const node = existsSync(runtimeNode) ? runtimeNode : realpathSync(process.execPath);
const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = path.join(repo, 'var', 'mirror', 'launchd.log');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(path.join(repo, 'src', 'cli', 'index.ts'))}</string>
    <string>mirror</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(repo)}</string>
  <key>StartInterval</key><integer>1200</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;

const arg = process.argv[2];
const domain = `gui/${userInfo().uid}`;

// D-77: a one-shot agent that runs the permission test exactly as the mirror
// runs -- same node, same launchd domain, same Background process type -- once.
const TEST_LABEL = 'local.canvas-monitor.materialize-test';
const testPlistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${TEST_LABEL}.plist`);
const testLogPath = path.join(repo, 'var', 'mirror', 'materialize-test.log');
const testPlist = (archivePath: string) => plist
  .replace(`<string>${LABEL}</string>`, `<string>${TEST_LABEL}</string>`)
  .replace('    <string>mirror</string>\n', `    <string>mirror</string>\n    <string>--materialize-test</string>\n    <string>${esc(archivePath)}</string>\n`)
  .replace('  <key>StartInterval</key><integer>1200</integer>\n', '')
  .replaceAll(esc(logPath), esc(testLogPath));

if (arg === '--materialize-test') {
  const archivePath = process.argv[3];
  if (archivePath === undefined || archivePath.startsWith('/') || archivePath.split('/').includes('..')) {
    process.stderr.write('Usage: node scripts/mirror-schedule.ts --materialize-test <term>/<module>/<folder>/<file>  (a path inside the archive)\n');
    process.exit(2);
  }
  if (node !== runtimeNode) {
    process.stderr.write(`Refusing: the mirror's own node is missing.\nRun:  node scripts/mirror-runtime.ts\n`);
    process.exit(2);
  }
  mkdirSync(path.dirname(testLogPath), { recursive: true });
  mkdirSync(path.dirname(testPlistPath), { recursive: true });
  writeFileSync(testPlistPath, testPlist(archivePath));
  execFileSync('launchctl', ['bootstrap', domain, testPlistPath], { stdio: 'inherit' });
  process.stdout.write(`Loaded the one-shot test (it runs now). Result: tail -1 ${testLogPath}\nThen remove it: node scripts/mirror-schedule.ts --remove-materialize-test\n`);
  process.exit(0);
}
if (arg === '--remove-materialize-test') {
  if (existsSync(testPlistPath)) {
    spawnSync('launchctl', ['bootout', domain, testPlistPath], { stdio: 'inherit' });
    rmSync(testPlistPath);
  }
  process.stdout.write('Test agent removed.\n');
  process.exit(0);
}

if (arg === '--install' && node !== runtimeNode) {
  process.stderr.write(`Refusing to install: the mirror's own node is missing.\nRun:  node scripts/mirror-runtime.ts\n`);
  process.exit(2);
} else if (arg === '--install') {
  mkdirSync(path.dirname(logPath), { recursive: true });
  mkdirSync(path.dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);
  execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
  process.stdout.write(`Installed and loaded ${plistPath}\nIt runs now (RunAtLoad), then every 20 minutes. Log: ${logPath}\n`);
} else if (arg === '--uninstall') {
  if (existsSync(plistPath)) {
    execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'inherit' });
    rmSync(plistPath);
  }
  process.stdout.write('Schedule removed.\n');
} else {
  process.stdout.write(`${plist}\n(printed only; nothing installed)\nbinary the grant belongs to: ${node}${node === runtimeNode ? '' : '  <-- run scripts/mirror-runtime.ts first'}\n`);
}
