/** The main view (DECISIONS.md D-65). Session first; then one read-only snapshot. */

import { snapshot } from '../lib/readmodel.ts';
import { requireSession } from './_auth.ts';
import { ActivityList, Coverage, Deadlines, Followups, Header, SystemHealth, Tiles } from './_view.tsx';
import { NewSince } from './new-since.tsx';
import { Unavailable } from './unavailable.tsx';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { session, secrets } = await requireSession();
  const snap = await snapshot(session, secrets, null).catch(() => null);
  if (snap === null) return <Unavailable />;
  const now = new Date();
  const modules = new Map(snap.modules.map((m) => [m.id, m]));
  return (
    <main className="page">
      <Header snap={snap} now={now} title="Canvas Monitor" />
      <Tiles snap={snap} now={now} />
      <div className="columns">
        <div className="col-main">
          <Deadlines items={snap.deadlines} modules={modules} now={now} />
          <ActivityList items={snap.activity} modules={modules} limit={30} />
        </div>
        <div className="col-side">
          <Followups items={snap.followups} modules={modules} now={now} showModule />
          <Coverage modules={snap.modules} />
          <SystemHealth snap={snap} now={now} />
        </div>
      </div>
      <p className="muted small footnote">Read-only. It cannot see inside Panopto recordings, Zoom sessions, or anything said only in a lecture.</p>
      <NewSince />
    </main>
  );
}
