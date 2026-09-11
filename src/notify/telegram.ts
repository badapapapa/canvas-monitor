/**
 * Telegram Bot API client (SPEC.md section 12).
 *
 * The bot token is part of the request URL (`/bot<token>/sendMessage`), which
 * makes it the one secret in this system that can leak through an error
 * message: some fetch failures quote the URL. Every error string leaving this
 * module passes through scrubString, which matches the token even inside that
 * URL (see core/redact.ts). test/unit/telegram.test.ts pins it.
 */

import { scrubString } from '../core/redact.ts';
import { sleep } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';

export const TELEGRAM_API = 'https://api.telegram.org';

/** Telegram's hard cap is 4096; the margin absorbs entity-length accounting. */
export const MESSAGE_LIMIT = 4000;

export type SendOutcome =
  | { ok: true; messageId: number }
  | { ok: false; retryable: boolean; status: number | null; description: string };

export interface TelegramOptions {
  token: string;
  log: Logger;
  /** Overridable for tests against a local fake. */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface TelegramResponse {
  ok?: boolean;
  result?: { message_id?: number };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  private readonly token: string;
  private readonly log: Logger;
  private readonly apiBase: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TelegramOptions) {
    this.token = options.token;
    this.log = options.log;
    this.apiBase = (options.apiBase ?? TELEGRAM_API).replace(/\/+$/, '');
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * Send one message. `silent` sets disable_notification: the message arrives
   * but does not buzz. Used for operational alerts during quiet hours, so a
   * 3am outage is waiting on waking without waking me (DECISIONS.md D-42).
   */
  async send(chatId: string, html: string, options: { silent?: boolean } = {}): Promise<SendOutcome> {
    const first = await this.attempt(chatId, html, options.silent === true);
    if (first.ok || first.retryAfterMs === undefined) return strip(first);

    // 429: Telegram says exactly how long to wait. Honour it once, bounded,
    // then give the decision back to the queue rather than blocking a run.
    const wait = Math.min(first.retryAfterMs, 30_000);
    this.log.warn('telegram.rate_limited', { wait_ms: wait });
    await sleep(wait);
    return strip(await this.attempt(chatId, html, options.silent === true));
  }

  private async attempt(
    chatId: string,
    html: string,
    silent: boolean,
  ): Promise<SendOutcome & { retryAfterMs?: number }> {
    let response: Response;
    let body: TelegramResponse;
    try {
      response = await this.doFetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          disable_notification: silent,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = (await response.json().catch(() => ({}))) as TelegramResponse;
    } catch (error) {
      return {
        ok: false,
        retryable: true,
        status: null,
        description: scrubString(error instanceof Error ? error.message : String(error)),
      };
    }

    if (response.ok && body.ok === true && typeof body.result?.message_id === 'number') {
      return { ok: true, messageId: body.result.message_id };
    }

    const status = body.error_code ?? response.status;
    const description = scrubString(body.description ?? `HTTP ${response.status}`);
    const retryAfter = body.parameters?.retry_after;
    return {
      ok: false,
      // 400 (bad markup, chat not found) and 403 (bot blocked, never /started)
      // do not improve by retrying. 429 and 5xx do.
      retryable: status === 429 || status >= 500,
      status,
      description,
      ...(status === 429 && typeof retryAfter === 'number' ? { retryAfterMs: retryAfter * 1000 } : {}),
    };
  }
}

function strip(outcome: SendOutcome & { retryAfterMs?: number }): SendOutcome {
  if (outcome.ok) return outcome;
  return { ok: false, retryable: outcome.retryable, status: outcome.status, description: outcome.description };
}
