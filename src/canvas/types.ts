/**
 * Canvas response shapes -- only the fields this system reads.
 *
 * Deliberately partial and deliberately tolerant: every field that Canvas
 * documents as optional is optional here. SPEC.md section 17 says to trust the
 * API over the spec, and a type that over-promises turns a benign missing
 * field into a crash mid-poll.
 */

export interface CanvasTerm {
  id: number;
  name?: string | null;
  start_at?: string | null;
  end_at?: string | null;
}

export interface CanvasCourse {
  id: number;
  name?: string | null;
  course_code?: string | null;
  workflow_state?: string | null;
  term?: CanvasTerm | null;
  enrollment_term_id?: number | null;
  start_at?: string | null;
  end_at?: string | null;
  /** Present when the course is inaccessible; Canvas still lists the row. */
  access_restricted_by_date?: boolean;
}

export interface CanvasUser {
  id: number;
  name?: string | null;
  short_name?: string | null;
  sortable_name?: string | null;
}

/** A course row that Canvas returned but restricted. Not a usable course. */
export function isAccessRestricted(course: CanvasCourse): boolean {
  return course.access_restricted_by_date === true;
}

export function courseTermName(course: CanvasCourse): string | null {
  return course.term?.name ?? null;
}

export interface CanvasEnrollment {
  id: number;
  course_id?: number | null;
  course_section_id?: number | null;
  type?: string | null;
  role?: string | null;
  enrollment_state?: string | null;
  sis_section_id?: string | null;
}

export interface CanvasFile {
  id: number;
  display_name?: string | null;
  filename?: string | null;
  size?: number | null;
  updated_at?: string | null;
  folder_id?: number | null;
  locked?: boolean;
  hidden?: boolean;
  hidden_for_user?: boolean;
  'content-type'?: string | null;
}

export interface CanvasModuleItem {
  id: number;
  title?: string | null;
  type?: string | null;
  content_id?: number | null;
}

export interface CanvasModule {
  id: number;
  name?: string | null;
  items?: CanvasModuleItem[] | null;
  items_count?: number | null;
}

export interface CanvasGroup {
  id: number;
  name?: string | null;
  /** "Course" for course groups. Account-level groups have no parent course. */
  context_type?: string | null;
  /** The parent course. Canvas states this directly; nothing to infer. */
  course_id?: number | null;
  /** True once the parent course has concluded. Its content is then unreadable. */
  concluded?: boolean | null;
  group_category_id?: number | null;
  members_count?: number | null;
}

export interface CanvasDiscussionTopic {
  id: number;
  title?: string | null;
  posted_at?: string | null;
  delayed_post_at?: string | null;
  created_at?: string | null;
}

/**
 * An announcement, from /announcements. Observed 2026-09-11: there is NO
 * `updated_at` field at all, so an edit is only detectable by hashing the
 * content (SPEC.md section 4). `context_code` says which course it came from
 * when several are requested in one call.
 */
export interface CanvasAnnouncement {
  id: number;
  title?: string | null;
  message?: string | null;
  posted_at?: string | null;
  delayed_post_at?: string | null;
  created_at?: string | null;
  context_code?: string | null;
  html_url?: string | null;
}

/** One entry of an assignment's `all_dates`. Fields vary by permission. */
export interface CanvasAssignmentDate {
  id?: number | null;
  base?: boolean | null;
  title?: string | null;
  due_at?: string | null;
  lock_at?: string | null;
  unlock_at?: string | null;
}

export interface CanvasAssignment {
  id: number;
  name?: string | null;
  description?: string | null;
  due_at?: string | null;
  lock_at?: string | null;
  unlock_at?: string | null;
  points_possible?: number | null;
  html_url?: string | null;
  published?: boolean | null;
  has_overrides?: boolean | null;
  all_dates?: CanvasAssignmentDate[] | null;
  updated_at?: string | null;
}

/**
 * Submission comments. None existed on 2026-09-11, so this is typed from the
 * Canvas documentation and the handling is unexercised against real data.
 */
export interface CanvasSubmissionComment {
  id: number;
  author_id?: number | null;
  author_name?: string | null;
  comment?: string | null;
  created_at?: string | null;
  edited_at?: string | null;
}

export interface CanvasSubmission {
  id: number;
  assignment_id: number;
  user_id?: number | null;
  workflow_state?: string | null;
  score?: number | null;
  grade?: string | null;
  excused?: boolean | null;
  /**
   * NULL while a grade is held under a manual posting policy. Observed live on
   * 2026-09-11: `workflow_state: graded` with `posted_at: null` and
   * `score: null`. A grade is announced only once this is set.
   */
  posted_at?: string | null;
  graded_at?: string | null;
  submission_comments?: CanvasSubmissionComment[] | null;
}
