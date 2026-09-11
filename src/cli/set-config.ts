/**
 * `npm run set-config <key>` (SPEC.md section 12).
 *
 * The value is read from STDIN, never from argv. A token passed as an argument
 * lands in shell history, in `ps` output, and in any process listing on the
 * machine. Paste it and press Ctrl-D.
 *
 * `--from-env` exists for the first insert in an automated context, where
 * there is no terminal to paste into.
 */

import { AppError } from '../core/errors.ts';
import { CONFIG_SPEC, Config, configKeys, isConfigKey, setConfig, type ConfigKey } from '../core/config.ts';
import type { RunContext } from '../core/run-context.ts';

export async function runSetConfig(
  ctx: RunContext,
  args: { key?: string | undefined; fromEnv: boolean },
): Promise<void> {
  const rawKey = args.key;
  if (rawKey === undefined) {
    throw new AppError('usage', 'set-config requires a key.', `Known keys: ${configKeys().join(', ')}`);
  }
  if (!isConfigKey(rawKey)) {
    throw new AppError(
      'usage',
      `Unknown config key "${rawKey}".`,
      `Known keys: ${configKeys().join(', ')}`,
    );
  }
  const key: ConfigKey = rawKey;
  const spec = CONFIG_SPEC[key];

  let value: string;
  if (args.fromEnv) {
    const envVar = 'envVar' in spec ? spec.envVar : undefined;
    if (envVar === undefined) {
      throw new AppError('usage', `Config key "${key}" has no --from-env source.`);
    }
    const found = process.env[envVar];
    if (found === undefined || found.trim() === '') {
      throw new AppError('config_missing', `--from-env given but ${envVar} is not set.`);
    }
    value = found.trim();
  } else {
    if (process.stdin.isTTY === true) {
      process.stderr.write(`Paste the value for ${key}, then press Ctrl-D:\n`);
    }
    value = (await readStdin()).trim();
    if (value === '') {
      throw new AppError('usage', `No value read from stdin for "${key}".`);
    }
  }

  const pattern = 'pattern' in spec ? spec.pattern : undefined;
  if (pattern !== undefined && !pattern.test(value)) {
    const hint = 'formatHint' in spec ? spec.formatHint : undefined;
    // Never echo the value: this path handles secrets, and a mis-pasted token
    // would otherwise land in the terminal scrollback and the run log.
    throw new AppError(
      'config_invalid',
      `That does not look like a valid ${key} (${value.length} characters). Nothing was stored.`,
      hint === undefined ? undefined : `Expected ${hint}.`,
    );
  }

  await setConfig(ctx.db, ctx.clock, key, value);

  ctx.log.info('config.set', { key, secret: spec.secret, dry_run: ctx.dryRun });
  process.stderr.write(
    ctx.dryRun
      ? `\nDRY RUN: would set ${key} (${value.length} chars). Nothing written.\n\n`
      : `\nSet ${key}.\n\n`,
  );
}

export async function runConfigList(ctx: RunContext): Promise<void> {
  const config = await Config.load(ctx.db);
  const out = process.stdout;
  out.write('\n');
  for (const key of configKeys()) {
    const spec = CONFIG_SPEC[key];
    const value = config.get(key);
    const shown =
      value === undefined || value === ''
        ? '(unset)'
        : spec.secret
          ? `(set, ${value.length} chars, hidden)`
          : value;
    out.write(`${key.padEnd(28)} ${shown}\n`);
    out.write(`${' '.repeat(28)} ${spec.description}\n`);
  }
  out.write('\n');
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
