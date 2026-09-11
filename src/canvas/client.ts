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
  CanvasCourse,
  CanvasDiscussionTopic,
  CanvasEnrollment,
  CanvasFile,
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
}
