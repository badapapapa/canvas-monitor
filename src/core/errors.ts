/** Errors this program raises about itself, as distinct from Canvas outcomes. */

export type AppErrorCode =
  | 'config_missing'
  | 'config_invalid'
  | 'migration_failed'
  | 'usage'
  | 'dry_run_violation';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly hint: string | undefined;

  constructor(code: AppErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = hint;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
