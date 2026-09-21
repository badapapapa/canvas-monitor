import type { Config } from '../core/config.ts';
import { setConfig } from '../core/config.ts';
import type { RunContext } from '../core/run-context.ts';
import { TokenProvider } from '../graph/auth.ts';
import { GraphDrive } from '../graph/drive.ts';
import { RequestGuard, SCOPES, type RootSpec } from '../graph/guard.ts';

/** The same drive construction as sync, for one-off commands. */
export function buildDriveForCli(ctx: RunContext, config: Config): GraphDrive {
  const root: RootSpec = config.get('graph_scope') === 'full'
    ? { mode: 'folder', name: config.require('onedrive_root_folder') }
    : { mode: 'appfolder' };
  const guard = new RequestGuard({ root });
  const tokens = new TokenProvider({
    clientId: config.require('graph_client_id'), scope: SCOPES[root.mode], guard, log: ctx.log, clock: ctx.clock,
    refreshToken: () => config.require('graph_refresh_token'),
    saveRefreshToken: async (t) => {
      await setConfig(ctx.db, ctx.clock, 'graph_refresh_token', t);
      config.override('graph_refresh_token', t);
    },
  });
  return new GraphDrive({ root, guard, tokens, log: ctx.log, clock: ctx.clock });
}
