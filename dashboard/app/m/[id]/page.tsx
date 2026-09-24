/**
 * One module's view (DECISIONS.md D-65). The URL carries an opaque internal
 * number, never the module code, so request logs name no module.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { snapshot } from '../../../lib/readmodel.ts';
import { requireSession } from '../../_auth.ts';
import { ActivityList, Deadlines, Followups, Header } from '../../_view.tsx';
import { NewSince } from '../../new-since.tsx';
import { Unavailable } from '../../unavailable.tsx';

export const dynamic = 'force-dynamic';

export default async function ModulePage({ params }: { params: Promise<{ id: string }> }) {
  const { session, secrets } = await requireSession();
  const { id } = await params;
  if (!/^\d{1,6}$/.test(id)) notFound();
  const snap = await snapshot(session, secrets, Number(id)).catch(() => null);
  if (snap === null) return <Unavailable />;
  const module = snap.modules.find((m) => m.id === Number(id));
  if (module === undefined) notFound();
  const now = new Date();
  const modules = new Map(snap.modules.map((m) => [m.id, m]));
  return (
    <main className="page">
      <p className="small"><Link href="/">← All modules</Link></p>
      <Header snap={snap} now={now} title={`${module.code}${module.kind === 'group' ? ' · group' : ''}`} subtitle="One module" />
      <div className="columns">
        <div className="col-main">
          <Deadlines items={snap.deadlines} modules={modules} now={now} />
          <ActivityList items={snap.activity} modules={modules} limit={100} />
        </div>
        <div className="col-side">
          <Followups items={snap.followups} modules={modules} now={now} showModule={false} />
        </div>
      </div>
      <NewSince />
    </main>
  );
}
