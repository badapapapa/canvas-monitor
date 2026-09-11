/**
 * `npm run telegram-test` -- prove both chats receive messages before
 * anything depends on them.
 *
 * Sends one message to the content chat and one to the ops chat. Checks the
 * two are different chats, since operational alerts need their own
 * (SPEC.md section 12).
 */

import { Config } from '../core/config.ts';
import { AppError } from '../core/errors.ts';
import { TelegramClient } from '../notify/telegram.ts';
import type { RunContext } from '../core/run-context.ts';

export async function runTelegramTest(ctx: RunContext): Promise<number> {
  const config = await Config.load(ctx.db);
  const token = config.require('telegram_bot_token');
  const content = config.require('telegram_content_chat_id');
  const ops = config.require('telegram_ops_chat_id');
  if (content === ops) {
    throw new AppError(
      'config_invalid',
      'telegram_content_chat_id and telegram_ops_chat_id are the same chat.',
      'Operational alerts need their own chat so failures never get lost in content.',
    );
  }

  const messages = [
    {
      chat: content,
      label: 'content',
      text: '✅ <b>Canvas monitor</b> · content chat\nNew announcements, assignments, grades and feedback will arrive here.',
    },
    {
      chat: ops,
      label: 'ops',
      text: '✅ <b>Canvas monitor</b> · ops chat\nOnly operational alerts arrive here: auth failures, stale courses, token expiry.',
    },
  ];

  if (ctx.dryRun) {
    for (const m of messages) process.stdout.write(`\nDRY RUN: would send to ${m.label} chat:\n${m.text}\n`);
    process.stdout.write('\n');
    return 0;
  }

  const telegram = new TelegramClient({ token, log: ctx.log });
  let failures = 0;
  process.stdout.write('\n');
  for (const m of messages) {
    const result = await telegram.send(m.chat, m.text);
    if (result.ok) {
      process.stdout.write(`  ${m.label.padEnd(8)} sent\n`);
    } else {
      failures += 1;
      process.stdout.write(`  ${m.label.padEnd(8)} FAILED (${result.status ?? 'network'}): ${result.description}\n`);
      if (result.status === 403) {
        process.stdout.write('           The bot cannot message this chat. For a personal chat, send /start to the bot first;\n');
        process.stdout.write('           for a group, check the bot is still a member.\n');
      } else if (result.status === 400) {
        process.stdout.write('           Telegram does not recognise this chat id. Re-check it.\n');
      }
    }
  }
  process.stdout.write(failures === 0 ? '\nBoth chats reachable. Check your phone: two messages, two chats.\n\n' : '\n');
  return failures === 0 ? 0 : 1;
}
