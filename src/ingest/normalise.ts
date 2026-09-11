/**
 * Canvas objects -> items (SPEC.md section 6).
 *
 * Each normaliser decides two things beyond field mapping:
 *
 *   contentHash  -- exactly the fields whose change is worth telling me about.
 *                  Not updated_at: it moves for reasons I do not care about.
 *   notifiable   -- whether this item, if new or changed, is news at all.
 *                  A grade held back under a manual posting policy is not;
 *                  my own submission comment is not.
 */

import { createHash } from 'node:crypto';
import { htmlToText, preview } from '../core/html.ts';
import type { CanvasAnnouncement, CanvasAssignment, CanvasSubmission } from '../canvas/types.ts';

export type ResourceType = 'announcement' | 'assignment' | 'grade' | 'comment';

export const RESOURCE_TYPES: readonly ResourceType[] = ['announcement', 'assignment', 'grade', 'comment'];

export interface ItemRecord {
  resourceType: ResourceType;
  externalId: string;
  title: string | null;
  bodyText: string | null;
  bodyHash: string | null;
  contentHash: string;
  canvasUrl: string | null;
  postedAt: string | null;
  updatedAt: string | null;
  dueAt: string | null;
  meta: Record<string, unknown>;
  notifiable: boolean;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable JSON: key order must never change a hash. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

export function hashOf(value: unknown): string {
  return sha256(stable(value));
}

/** The `items.id` for a (context, resource, external id) triple. */
export function itemId(contextId: number, resourceType: ResourceType, externalId: string): string {
  return sha256(`${contextId} ${resourceType} ${externalId}`);
}

export function normaliseAnnouncement(a: CanvasAnnouncement, now: Date): ItemRecord | null {
  // A delayed post is invisible to students until it goes live. If Canvas ever
  // returns one early, it is not news yet.
  if (a.delayed_post_at !== null && a.delayed_post_at !== undefined && new Date(a.delayed_post_at) > now) {
    return null;
  }
  const title = a.title ?? null;
  const text = htmlToText(a.message);
  return {
    resourceType: 'announcement',
    externalId: String(a.id),
    title,
    bodyText: text,
    bodyHash: sha256(text),
    // Announcements carry no updated_at (observed 2026-09-11). Hashing title
    // and body is the only way an edit is detectable at all.
    contentHash: hashOf({ title, text }),
    canvasUrl: a.html_url ?? null,
    postedAt: a.posted_at ?? a.created_at ?? null,
    updatedAt: null,
    dueAt: null,
    meta: { preview: preview(text) },
    notifiable: true,
  };
}

/**
 * The fields an assignment change is judged on. A named shape because the
 * classifier diffs it field by field to say WHAT changed.
 */
export interface AssignmentFacts {
  name: string | null;
  due_at: string | null;
  lock_at: string | null;
  unlock_at: string | null;
  points_possible: number | null;
  description_hash: string;
}

export function normaliseAssignment(a: CanvasAssignment): ItemRecord {
  const description = htmlToText(a.description);
  const facts: AssignmentFacts = {
    name: a.name ?? null,
    due_at: a.due_at ?? null,
    lock_at: a.lock_at ?? null,
    unlock_at: a.unlock_at ?? null,
    points_possible: a.points_possible ?? null,
    description_hash: sha256(description),
  };

  // D-13 cross-check. No resolver: none of 8 real assignments had overrides,
  // and all_dates always agreed with due_at. If they ever disagree, both are
  // shown with a warning rather than one being picked (SPEC.md section 17).
  const disagreeing = (a.all_dates ?? [])
    .map((d) => d.due_at ?? null)
    .filter((due) => due !== facts.due_at);

  return {
    resourceType: 'assignment',
    externalId: String(a.id),
    title: facts.name,
    bodyText: description,
    bodyHash: facts.description_hash,
    contentHash: hashOf(facts),
    canvasUrl: a.html_url ?? null,
    postedAt: null,
    updatedAt: a.updated_at ?? null,
    dueAt: facts.due_at,
    meta: {
      facts,
      has_overrides: a.has_overrides === true,
      ...(disagreeing.length > 0 ? { other_due_dates: [...new Set(disagreeing)] } : {}),
    },
    // Students cannot see unpublished assignments. If one appears, it is not
    // yet something to act on.
    notifiable: a.published !== false,
  };
}

export interface GradeFacts {
  posted: boolean;
  score: number | null;
  grade: string | null;
  excused: boolean;
}

export function normaliseGrade(s: CanvasSubmission, assignment: CanvasAssignment | undefined): ItemRecord {
  const posted = s.posted_at !== null && s.posted_at !== undefined;
  const facts: GradeFacts = {
    posted,
    // A held grade's score is withheld from the student anyway. Including it
    // only when posted keeps the hash honest if Canvas ever leaks one early.
    score: posted ? (s.score ?? null) : null,
    grade: posted ? (s.grade ?? null) : null,
    excused: s.excused === true,
  };
  return {
    resourceType: 'grade',
    externalId: String(s.id),
    title: assignment?.name ?? null,
    bodyText: null,
    bodyHash: null,
    contentHash: hashOf(facts),
    canvasUrl: assignment?.html_url ?? null,
    postedAt: s.posted_at ?? null,
    updatedAt: s.graded_at ?? null,
    dueAt: null,
    meta: { facts, assignment_id: s.assignment_id, points_possible: assignment?.points_possible ?? null },
    // Only a POSTED grade is news. `graded` with `posted_at: null` was observed
    // live; announcing it would say "graded" and then withhold the score.
    notifiable: posted,
  };
}

/** Comments by anyone other than me, one item each. */
export function normaliseComments(
  s: CanvasSubmission,
  assignment: CanvasAssignment | undefined,
  selfId: number,
): ItemRecord[] {
  return (s.submission_comments ?? [])
    .filter((c) => c.author_id !== selfId)
    .map((c) => {
      const text = (c.comment ?? '').trim();
      return {
        resourceType: 'comment' as const,
        externalId: String(c.id),
        title: assignment?.name ?? null,
        bodyText: text,
        bodyHash: sha256(text),
        contentHash: hashOf({ text }),
        canvasUrl: assignment?.html_url ?? null,
        postedAt: c.created_at ?? null,
        updatedAt: c.edited_at ?? null,
        dueAt: null,
        // No author name is stored: who wrote the feedback is incidental to
        // "there is feedback", and third-party names are minimised (D-11).
        meta: { preview: preview(text), assignment_id: s.assignment_id },
        notifiable: true,
      };
    });
}
