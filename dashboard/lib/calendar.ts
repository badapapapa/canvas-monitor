/**
 * "Add to calendar": a Google Calendar event-template link, built on the server
 * (DECISIONS.md D-65). The event is the hour before the deadline, in SGT
 * (`ctz=Asia/Singapore`, wall-clock times without a zone). Nothing is sent
 * anywhere until I click it; the page's Referrer-Policy keeps the dashboard's
 * address out of the request.
 */

const SGT_MS = 8 * 3600_000;

/** "20261009T235900": an instant as SGT wall-clock time. */
export function sgtStamp(at: Date): string {
  return new Date(at.getTime() + SGT_MS).toISOString().replace(/[-:]/g, '').slice(0, 15);
}

export function googleCalendarLink(d: { title: string; moduleCode: string; dueAt: string; canvasUrl: string | null }): string | null {
  const due = new Date(d.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const start = new Date(due.getTime() - 3600_000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Due: ${d.title} (${d.moduleCode})`,
    dates: `${sgtStamp(start)}/${sgtStamp(due)}`,
    ctz: 'Asia/Singapore',
    ...(d.canvasUrl !== null && d.canvasUrl.startsWith('https://') ? { details: d.canvasUrl } : {}),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
