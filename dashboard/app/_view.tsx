/**
 * The dashboard's sections, rendered on the server from a read-model snapshot
 * (DECISIONS.md D-65). Read-only: there are links out, and one logout button,
 * and no control that changes anything.
 */

import Link from 'next/link';
import { googleCalendarLink } from '../lib/calendar.ts';
import { day, daysSince, relative, size, when } from '../lib/format.ts';
import type { Activity, Deadline, Followup, Module, Snapshot } from '../lib/readmodel.ts';

const out = { target: '_blank', rel: 'noopener noreferrer' } as const;

export function ModuleChip({ m }: { m: Module | undefined }) {
  if (m === undefined) return null;
  return <Link href={`/m/${m.id}`} className={`chip chip-${m.id % 4}`}>{m.code}{m.kind === 'group' ? ' · group' : ''}</Link>;
}

const KIND_LABEL: Record<string, string> = {
  announcement: 'announcement', assignment: 'assignment', file: 'file', grade: 'grade posted', feedback: 'feedback posted',
};

export function Header({ snap, now, title, subtitle }: { snap: Snapshot; now: Date; title: string; subtitle?: string }) {
  const alerts = Number(snap.health['active_alerts'] ?? '0');
  const critical = Number(snap.health['active_critical_alerts'] ?? '0');
  const lastSync = snap.health['last_sync_at'];
  const healthy = alerts === 0 && snap.health['last_sync_status'] !== 'failed';
  return (
    <header className="header">
      <div>
        <h1 className="title">{title}</h1>
        <p className="muted">
          {subtitle ?? `${snap.modules.filter((m) => m.kind === 'course').length} modules, ${snap.modules.filter((m) => m.kind === 'group').length} groups`}
          {lastSync !== undefined ? ` · last checked ${relative(lastSync, now)}` : ''}
        </p>
      </div>
      <div className="header-side">
        <span className={healthy ? 'pill pill-ok' : critical > 0 ? 'pill pill-bad' : 'pill pill-warn'}>
          {healthy ? 'All checks passing' : `${alerts} alert${alerts === 1 ? '' : 's'} open${critical > 0 ? ` (${critical} critical)` : ''}`}
        </span>
        <form method="post" action="/api/logout"><button type="submit" className="link-button">Log out</button></form>
      </div>
    </header>
  );
}

export function Deadlines({ items, modules, now }: { items: Deadline[]; modules: Map<number, Module>; now: Date }) {
  const upcoming = items.filter((d) => new Date(d.dueAt).getTime() >= now.getTime());
  return (
    <section className="card">
      <h2 className="h2">Deadlines</h2>
      {upcoming.length === 0 ? <p className="muted">Nothing due.</p> : null}
      {upcoming.map((d) => {
        const m = modules.get(d.moduleId);
        const cal = googleCalendarLink({ title: d.title, moduleCode: m?.code ?? '', dueAt: d.dueAt, canvasUrl: d.canvasUrl });
        return (
          <div key={d.ref} className="row deadline">
            <div className="grow">
              <div className="meta"><ModuleChip m={m} />{d.revisedAt !== null ? <span className="muted small">details revised {day(d.revisedAt)}</span> : null}</div>
              <div className="item-title">{d.canvasUrl !== null ? <a href={d.canvasUrl} {...out}>{d.title}</a> : d.title}</div>
              <div className="muted small">{when(d.dueAt)} SGT · {relative(d.dueAt, now)}</div>
            </div>
            {cal !== null ? <a href={cal} {...out} className="button">Add to calendar</a> : null}
          </div>
        );
      })}
    </section>
  );
}

export function ActivityList({ items, modules, limit }: { items: Activity[]; modules: Map<number, Module>; limit: number }) {
  return (
    <section className="card">
      <h2 className="h2">Recent activity <span className="muted small" data-new-summary=""></span></h2>
      {items.length === 0 ? <p className="muted">Nothing in the last three weeks.</p> : null}
      {items.slice(0, limit).map((a) => (
        <div key={a.ref} className="row activity" data-seen={a.seenAt}>
          <div className="grow">
            <div className="meta">
              <ModuleChip m={modules.get(a.moduleId)} />
              <span className="muted small">{KIND_LABEL[a.kind] ?? a.kind}{a.change === 'revised' ? ' (updated)' : ''} · {when(a.at)}</span>
              <span className="badge-new" hidden>New</span>
            </div>
            <div className="item-title">{a.canvasUrl !== null ? <a href={a.canvasUrl} {...out}>{a.title ?? '(untitled)'}</a> : (a.title ?? '(untitled)')}</div>
            {a.kind === 'file' ? (
              <div className="muted small">
                {[size(a.fileSize), a.fileRoute !== null ? `→ ${a.fileRoute}` : 'not archived'].filter((x) => x !== '').join(' · ')}
                {a.onedriveUrl !== null ? <> · <a href={a.onedriveUrl} {...out}>open in OneDrive</a></> : null}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}

export function Followups({ items, modules, now, showModule }: { items: Followup[]; modules: Map<number, Module>; now: Date; showModule: boolean }) {
  return (
    <section className="card">
      <h2 className="h2">Waiting on the lecturer</h2>
      {items.length === 0 ? <p className="muted">No answers outstanding.</p> : null}
      {items.map((f) => {
        const age = daysSince(f.postedAt, now);
        return (
          <div key={f.id} className="line">
            <span>{showModule ? `${modules.get(f.moduleId)?.code ?? ''} ` : ''}{f.label}</span>
            <span className={age >= 7 ? 'small warn' : 'small muted'}>answers pending · {age} day{age === 1 ? '' : 's'}</span>
          </div>
        );
      })}
      <p className="muted small note">Dismiss one from the terminal: npm run followups -- dismiss &lt;id&gt;</p>
    </section>
  );
}

const COVERAGE: Record<string, string> = {
  full: 'files, announcements, grades', modules_only: 'files via Modules only', none: 'no file access', unknown: 'not checked yet',
};

export function Coverage({ modules }: { modules: Module[] }) {
  return (
    <section className="card">
      <h2 className="h2">Coverage</h2>
      {modules.map((m) => (
        <div key={m.id} className="line">
          <span><ModuleChip m={m} /></span>
          <span className={m.coverage === 'full' ? 'small ok' : 'small warn'}>
            {COVERAGE[m.coverage] ?? m.coverage}{m.kind === 'course' && !m.answersTracked ? ' · answers not tracked' : ''}
          </span>
        </div>
      ))}
    </section>
  );
}

export function SystemHealth({ snap, now }: { snap: Snapshot; now: Date }) {
  const h = snap.health;
  const drift = h['drift_p95_seconds'];
  const rows: Array<[string, string]> = [
    ['Last sync', h['last_sync_at'] !== undefined ? `${relative(h['last_sync_at'], now)}${h['last_sync_status'] !== undefined ? ` (${h['last_sync_status']})` : ''}` : 'never'],
    ['Runs, last 7 days', `${h['runs_7d'] ?? '0'}, ${h['failed_runs_7d'] ?? '0'} failed`],
    ['Schedule drift, p95', drift !== undefined ? `${Math.round(Number(drift) / 60)} minutes` : 'no data'],
    ['Open alerts', h['active_alerts'] ?? '0'],
    ['Archived to OneDrive', `${h['archived_files'] ?? '0'} files · ${size(Number(h['archived_bytes'] ?? '0'))}`],
    ['Too large to archive', h['too_large_files'] ?? '0'],
    ['Dashboard data', snap.publishedAt !== null ? `published ${relative(snap.publishedAt, now)}` : 'not yet published'],
  ];
  return (
    <section className="card">
      <h2 className="h2">System</h2>
      {rows.map(([k, v]) => <div key={k} className="line"><span className="muted small">{k}</span><span className="small">{v}</span></div>)}
    </section>
  );
}

export function Tiles({ snap, now }: { snap: Snapshot; now: Date }) {
  const soon = snap.deadlines.filter((d) => { const t = new Date(d.dueAt).getTime(); return t >= now.getTime() && t <= now.getTime() + 14 * 86_400_000; }).length;
  const tiles: Array<[string, string, string?]> = [
    ['Due in the next 14 days', String(soon)],
    ['New since your last visit', '—', 'new-count'],
    ['Archived to OneDrive', snap.health['archived_files'] ?? '0'],
    ['Waiting on a routing rule', snap.health['unsorted_files'] ?? '0'],
  ];
  return (
    <div className="tiles">
      {tiles.map(([label, value, id]) => (
        <div key={label} className="card tile"><p className="muted small">{label}</p><p className="tile-value" {...(id !== undefined ? { 'data-new-count': '' } : {})}>{value}</p></div>
      ))}
    </div>
  );
}
