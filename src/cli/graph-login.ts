/**
 * `npm run graph-login` -- connect OneDrive, once (SPEC.md section 5).
 *
 * Signs in with the device code flow against /consumers (personal accounts
 * only), stores the refresh token, then proves the connection works: reads the
 * app's root, checks the drive is a PERSONAL OneDrive, and reports whether the
 * quota is readable under the chosen scope. Nothing is uploaded.
 *
 * `--scope full|appfolder` overrides the configured scope for this sign-in
 * only. It exists for the AppFolder provisioning workaround (D-51).
 */

import { Config, setConfig } from '../core/config.ts';
import { AppError } from '../core/errors.ts';
import type { RunContext } from '../core/run-context.ts';
import { deviceCodeLogin, GraphError, TokenProvider } from '../graph/auth.ts';
import { GraphDrive } from '../graph/drive.ts';
import { RequestGuard, SCOPES, type RootSpec } from '../graph/guard.ts';
import { humanSize } from '../notify/render.ts';

export async function runGraphLogin(ctx: RunContext, args: { scope?: string | undefined }): Promise<number> {
  const config = await Config.load(ctx.db);
  const clientId = config.require('graph_client_id');
  const scopeName = args.scope ?? config.get('graph_scope') ?? 'appfolder';
  if (scopeName !== 'appfolder' && scopeName !== 'full') {
    throw new AppError('usage', `--scope must be appfolder or full, not "${scopeName}".`);
  }
  const root: RootSpec = scopeName === 'full' ? { mode: 'folder', name: config.require('onedrive_root_folder') } : { mode: 'appfolder' };
  const guard = new RequestGuard({ root });
  const out = process.stdout;

  if (ctx.dryRun) {
    out.write(`\nDRY RUN: would sign in with scope "${SCOPES[root.mode]}" via the /consumers authority. Nothing done.\n\n`);
    return 0;
  }

  out.write(`\nSigning in with scope: ${SCOPES[root.mode]}\n`);
  out.write('Use the Microsoft account that holds your PERSONAL OneDrive. NUS accounts cannot sign in here.\n\n');
  const login = await deviceCodeLogin({ clientId, scope: SCOPES[root.mode], guard, clock: ctx.clock, prompt: (m) => out.write(`${m}\n\n`) });
  await setConfig(ctx.db, ctx.clock, 'graph_refresh_token', login.refreshToken);
  config.override('graph_refresh_token', login.refreshToken);
  out.write('Signed in. Refresh token stored.\n');

  const tokens = new TokenProvider({
    clientId, scope: SCOPES[root.mode], guard, log: ctx.log, clock: ctx.clock,
    refreshToken: () => config.require('graph_refresh_token'),
    saveRefreshToken: async (t) => {
      await setConfig(ctx.db, ctx.clock, 'graph_refresh_token', t);
      config.override('graph_refresh_token', t);
    },
  });
  const drive = new GraphDrive({ root, guard, tokens, log: ctx.log, clock: ctx.clock });

  try {
    const item = await drive.rootItem();
    const driveType = item.parentReference?.driveType ?? 'unknown';
    out.write(`\nArchive root: ${item.webUrl ?? item.name}\n`);
    out.write(`Drive type:   ${driveType}${driveType === 'personal' ? '' : '   <-- NOT a personal OneDrive; archiving will refuse to run'}\n`);
    const quota = await drive.quota();
    out.write(
      quota === 'unreadable'
        ? 'Quota:        not readable with this scope (storage alerts off; a full drive still alerts)\n'
        : `Quota:        ${humanSize(quota.used)} used of ${humanSize(quota.total)}\n`,
    );
    out.write('\nNext: npm run set-config archive_enabled   (enter: true)\n\n');
    return driveType === 'personal' ? 0 : 1;
  } catch (error) {
    if (error instanceof GraphError && error.code === 'provisioning') {
      out.write(
        '\nOneDrive refused the app as read-only / pending provisioning. This is a known Microsoft\n' +
          'regression (Aug 2026) for newly consented AppFolder-only apps -- see DECISIONS.md D-51.\n' +
          'User-reported workaround:\n' +
          '  1. npm run graph-login -- --scope full        (consent once to the broader scope)\n' +
          '  2. remove the app at https://account.live.com/consent/Manage\n' +
          '  3. npm run graph-login                        (AppFolder again)\n\n',
      );
      return 1;
    }
    throw error;
  }
}
