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
