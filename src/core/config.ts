/**
 * The `config` table (SPEC.md section 12).
 *
 * The Canvas token lives here rather than in an environment variable so that
 * rotating it -- which NUS forces at most every 90 days -- is a paste, not a
 * redeploy. Adding a key to this table is cheap; adding one to env is a
 * deviation.
 */

import type { Db } from './db/writer.ts';
import { AppError } from './errors.ts';
import type { Clock } from './clock.ts';

interface KeySpec {
  readonly secret: boolean;
  readonly description: string;
  readonly default?: string;
  /** Env var accepted by `set-config --from-env` for first-run bootstrap. */
  readonly envVar?: string;
}

export const CONFIG_SPEC = {
  canvas_base_url: {
    secret: false,
    description: 'Canvas API root.',
    default: 'https://canvas.nus.edu.sg/api/v1',
    envVar: 'CANVAS_BASE_URL',
  },
  canvas_token: {
    secret: true,
    description: 'Canvas personal access token. NUS caps these at 90 days.',
    envVar: 'CANVAS_TOKEN',
  },
  canvas_token_expires_at: {
    secret: false,
    description: 'ISO-8601 expiry of canvas_token, as shown by Canvas at creation.',
    envVar: 'CANVAS_TOKEN_EXPIRES_AT',
  },
  raw_capture_enabled: {
    secret: false,
    description: 'Capture raw Canvas responses to var/raw for later --replay.',
    default: 'true',
  },
  raw_capture_retention_days: {
    secret: false,
    description: 'Age at which `npm run prune-raw` deletes captures.',
    default: '60',
  },
} as const satisfies Record<string, KeySpec>;

export type ConfigKey = keyof typeof CONFIG_SPEC;

export function isConfigKey(raw: string): raw is ConfigKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_SPEC, raw);
}

export function configKeys(): ConfigKey[] {
  return Object.keys(CONFIG_SPEC) as ConfigKey[];
}

export class Config {
  private readonly values: Map<string, string>;

  private constructor(values: Map<string, string>) {
    this.values = values;
  }

  static async load(db: Db): Promise<Config> {
    const result = await db.read('SELECT key, value FROM config');
    const values = new Map<string, string>();
    for (const row of result.rows) {
      values.set(String(row['key']), String(row['value']));
    }
    return new Config(values);
  }

  get(key: ConfigKey): string | undefined {
    const stored = this.values.get(key);
    if (stored !== undefined) return stored;
    const spec: KeySpec = CONFIG_SPEC[key];
    return spec.default;
  }

  require(key: ConfigKey): string {
    const value = this.get(key);
    if (value === undefined || value === '') {
      throw new AppError(
        'config_missing',
        `Config key "${key}" is not set: ${CONFIG_SPEC[key].description}`,
        `Set it with:  npm run set-config ${key}     (value is read from stdin, never argv)`,
      );
    }
    return value;
  }

  has(key: ConfigKey): boolean {
    const value = this.get(key);
    return value !== undefined && value !== '';
  }

  getBoolean(key: ConfigKey, fallback: boolean): boolean {
    const raw = this.get(key);
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  getNumber(key: ConfigKey, fallback: number): number {
    const raw = this.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
}

export async function setConfig(db: Db, clock: Clock, key: ConfigKey, value: string): Promise<void> {
  const spec: KeySpec = CONFIG_SPEC[key];
  await db.write.execute(`set config ${key}`, {
    sql: `INSERT INTO config (key, value, secret, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, spec.secret ? 1 : 0, clock.now().toISOString()],
  });
}

/** Days until the Canvas token expires, or null if no expiry is recorded. */
export function tokenDaysRemaining(config: Config, now: Date): number | null {
  const raw = config.get('canvas_token_expires_at');
  if (raw === undefined || raw === '') return null;
  const expiry = new Date(raw);
  if (Number.isNaN(expiry.getTime())) return null;
  return Math.floor((expiry.getTime() - now.getTime()) / 86_400_000);
}
