/**
 * Typed Canvas endpoints (SPEC.md section 4).
 *
 * Phase 0 needs exactly two: validate the token, and list courses. Endpoints
 * for announcements, files, modules and groups arrive with the phases that use
 * them -- SPEC.md section 14 says not to build ahead, and an untested endpoint
 * method is a liability dressed as progress.
 */

import type { CanvasHttp } from './http.ts';
import type { Result } from '../core/result.ts';
import type {
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasSubmission,
  CanvasCourse,
  CanvasDiscussionTopic,
  CanvasEnrollment,
  CanvasFile,
  CanvasFolder,
  CanvasGroup,
  CanvasModule,
  CanvasUser,
} from './types.ts';

export class CanvasClient {
  private readonly http: CanvasHttp;

  constructor(http: CanvasHttp) {
    this.http = http;
  }

  /** Cheapest possible token check. A 401 here means the token is dead. */
  getSelf(): Promise<Result<CanvasUser>> {
    return this.http.get<CanvasUser>('/users/self');
  }

  /**
   * Courses I am actively enrolled in, with term included so Phase 1 can
   * propose the `Canvas/<term>/<module_code>/` tree without a second call.
   */
  listActiveCourses(): Promise<Result<CanvasCourse[]>> {
    return this.listCourses('active');
  }

  /**
   * `completed` is probed in Phase 1 to answer D-28: NUS revokes access to
   * concluded courses, which is the reason this archive exists -- and which may
   * mean there is no history for `tune-patterns` to learn from.
   */
  listCourses(enrollmentState: 'active' | 'completed'): Promise<Result<CanvasCourse[]>> {
    return this.http.list<CanvasCourse>('/courses', {
      enrollment_state: enrollmentState,
      'include[]': ['term'],
    });
  }

  /** My own enrolment, for `course_section_id`. */
  listSelfEnrollments(courseId: number): Promise<Result<CanvasEnrollment[]>> {
    return this.http.list<CanvasEnrollment>(`/courses/${courseId}/enrollments`, {
      user_id: 'self',
    });
  }

  /** Coverage probe. One page: the question is visibility, not inventory. */
  probeFiles(courseId: number): Promise<Result<CanvasFile[]>> {
    return this.http.firstPage<CanvasFile>(`/courses/${courseId}/files`);
  }

  /** Coverage probe fallback, when the Files tab is disabled. */
  probeModules(courseId: number): Promise<Result<CanvasModule[]>> {
    return this.http.firstPage<CanvasModule>(`/courses/${courseId}/modules`, {
      'include[]': ['items'],
    });
  }

  /** D-32: does `/files` honour the sort that the early-stop depends on? */
  probeFilesSorted(courseId: number): Promise<Result<CanvasFile[]>> {
    return this.http.firstPage<CanvasFile>(`/courses/${courseId}/files`, {
      sort: 'updated_at',
      order: 'desc',
    });
  }

  listGroups(): Promise<Result<CanvasGroup[]>> {
    return this.http.list<CanvasGroup>('/users/self/groups', {});
  }

  /** D-30: probe the real `context_codes[]` cap rather than assuming 10. */
  probeAnnouncements(
    contextCodes: readonly string[],
    startDate: string,
    endDate: string,
  ): Promise<Result<CanvasDiscussionTopic[]>> {
    return this.http.firstPage<CanvasDiscussionTopic>('/announcements', {
      'context_codes[]': contextCodes as readonly string[],
      start_date: startDate,
      end_date: endDate,
    });
  }

  /** D-29, route A. */
  probeGroupAnnouncementsViaContext(
    groupId: number,
    startDate: string,
    endDate: string,
  ): Promise<Result<CanvasDiscussionTopic[]>> {
    return this.probeAnnouncements([`group_${groupId}`], startDate, endDate);
  }

  /** D-29, route B. */
  probeGroupAnnouncementsViaTopics(groupId: number): Promise<Result<CanvasDiscussionTopic[]>> {
    return this.http.firstPage<CanvasDiscussionTopic>(`/groups/${groupId}/discussion_topics`, {
      only_announcements: true,
    });
  }

  // --- Phase 2 ingest ------------------------------------------------------

  /**
   * Announcements for many courses at once, chunked at 10 context codes per
   * request. D-30 established the cap is at least 8 and could not reach 10;
   * chunking at 10 is correct whichever it turns out to be.
   *
   * COURSE codes only: /announcements rejects `group_N` with a 400 (D-29).
   * Group announcements come from discussion_topics in Phase 3.
   *
   * Returns one Result per chunk, not a merged list: a failed chunk must fail
   * only the contexts in it (SPEC.md section 2.6), and a caller merging chunks
   * could not tell which contexts an error belonged to.
   */
  async listAnnouncements(
    courseIds: readonly number[],
    window: { start: string; end: string },
  ): Promise<Array<{ courseIds: number[]; result: Result<CanvasAnnouncement[]> }>> {
    const out: Array<{ courseIds: number[]; result: Result<CanvasAnnouncement[]> }> = [];
    for (let i = 0; i < courseIds.length; i += ANNOUNCEMENT_CHUNK) {
      const chunk = courseIds.slice(i, i + ANNOUNCEMENT_CHUNK);
      const result = await this.http.list<CanvasAnnouncement>('/announcements', {
        'context_codes[]': chunk.map((id) => `course_${id}`),
        start_date: window.start,
        end_date: window.end,
      });
      out.push({ courseIds: chunk, result });
    }
    return out;
  }

  listAssignments(courseId: number): Promise<Result<CanvasAssignment[]>> {
    return this.http.list<CanvasAssignment>(`/courses/${courseId}/assignments`, {
      'include[]': ['all_dates', 'submission'],
    });
  }

  // --- Phase 3 file detection ----------------------------------------------

  /**
   * Every file, every run. No early stop on updated_at (D-32 deferred, D-47):
   * at observed sizes this is one page per course, and stopping at an old
   * updated_at would miss a file published without that timestamp moving.
   */
  listFiles(kind: FileContextKind, id: number): Promise<Result<CanvasFile[]>> {
    return this.http.list<CanvasFile>(`/${kind}/${id}/files`, { sort: 'updated_at', order: 'desc' });
  }

  listFolders(kind: FileContextKind, id: number): Promise<Result<CanvasFolder[]>> {
    return this.http.list<CanvasFolder>(`/${kind}/${id}/folders`);
  }

  /** The modules fallback, used only when /files is denied (SPEC.md section 4). */
  listModules(courseId: number): Promise<Result<CanvasModule[]>> {
    return this.http.list<CanvasModule>(`/courses/${courseId}/modules`, { 'include[]': ['items'] });
  }

  listSubmissions(courseId: number): Promise<Result<CanvasSubmission[]>> {
    return this.http.list<CanvasSubmission>(`/courses/${courseId}/students/submissions`, {
      'student_ids[]': ['self'],
      'include[]': ['submission_comments'],
    });
  }
}

/** DECISIONS.md D-30: safe whether the true cap is 10 or higher. */
export type FileContextKind = 'courses' | 'groups';

export const ANNOUNCEMENT_CHUNK = 10;
