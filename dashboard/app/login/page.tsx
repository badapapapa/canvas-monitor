/**
 * The login page (DECISIONS.md D-65): the only page reachable without a
 * session, so it carries no course data of any kind -- a password field and a
 * generic error, nothing else.
 */

import { notFound } from 'next/navigation';
import { secrets, servingAllowed } from '../../lib/env.ts';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!servingAllowed() || secrets() === null) notFound();
  const failed = (await searchParams)['e'] === '1';
  return (
    <main className="login">
      <h1 className="title">Canvas Monitor</h1>
      <form method="post" action="/api/login" className="card login-card">
        <label htmlFor="password" className="label">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={256} className="input" autoFocus />
        {failed ? <p className="error" role="alert">That did not work. Try again.</p> : null}
        <button type="submit" className="button">Sign in</button>
      </form>
    </main>
  );
}
