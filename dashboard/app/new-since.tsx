'use client';

/**
 * "New since my last visit" (DECISIONS.md D-65): tracked per device, in this
 * browser's localStorage only. The server never learns it and never writes.
 *
 * A visit ends after 30 minutes idle. Items seen by the monitor after the end
 * of the previous visit are marked New. The first visit on a device marks
 * nothing (there is no "last visit" yet).
 */

import { useEffect } from 'react';

const KEY = 'cm.visit.v1';
const IDLE_MS = 30 * 60_000;

interface Visit { previousEnd: string | null; lastActive: string }

function load(): Visit | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? null : (JSON.parse(raw) as Visit);
  } catch {
    return null;
  }
}

function save(v: Visit): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private mode: nothing is remembered, nothing breaks */
  }
}

export function NewSince() {
  useEffect(() => {
    const now = Date.now();
    const stored = load();
    const newVisit = stored === null || now - new Date(stored.lastActive).getTime() > IDLE_MS;
    const previousEnd = stored === null ? null : newVisit ? stored.lastActive : stored.previousEnd;
    save({ previousEnd, lastActive: new Date(now).toISOString() });

    const since = previousEnd === null ? null : new Date(previousEnd).getTime();
    let count = 0;
    document.querySelectorAll<HTMLElement>('[data-seen]').forEach((row) => {
      const isNew = since !== null && new Date(row.dataset['seen'] ?? '').getTime() > since;
      if (isNew) count += 1;
      row.classList.toggle('is-new', isNew);
      const badge = row.querySelector<HTMLElement>('.badge-new');
      if (badge !== null) badge.hidden = !isNew;
    });
    document.querySelectorAll<HTMLElement>('[data-new-count]').forEach((el) => { el.textContent = since === null ? '—' : String(count); });
    document.querySelectorAll<HTMLElement>('[data-new-summary]').forEach((el) => {
      el.textContent = since === null ? '· first visit on this device' : `· ${count} new since your last visit`;
    });

    const touch = () => save({ previousEnd, lastActive: new Date().toISOString() });
    document.addEventListener('visibilitychange', touch);
    return () => document.removeEventListener('visibilitychange', touch);
  }, []);
  return null;
}
