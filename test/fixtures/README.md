# Fixtures

Captured from real Canvas responses (SPEC.md section 15) and committed, so that
classification, routing and version-grouping logic can be tested without
waiting for a real upload.

## Redaction is mandatory, and it happens before capture

Everything under `var/raw/` is already passed through `src/core/redact.ts` on
write. A fixture is a **capture that has been reviewed and promoted** — never a
fresh hand-saved response.

To promote a capture into a fixture:

1. `npm run probe` (or whichever command exercises the endpoint) with
   `raw_capture_enabled = true`.
2. Find the capture under `var/raw/<day>/<run-id>/`.
3. **Read it.** Redaction is a data-minimisation pass, not a guarantee. Look
   specifically for names in free text, email addresses in unusual fields, and
   NUS matriculation numbers inside PDF filenames.
4. Replace remaining identifying values with obvious placeholders
   (`Student One`, `student-one@example.test`). Keep the shape, drop the person.
5. Move it here under a name that says what it demonstrates, not where it came
   from: `course-files-disabled.json`, not `bt2102-week6.json`.

## Fixtures the spec requires (SPEC.md section 15)

Captured as the phases that need them arrive. None exist yet — Phase 0 has no
classification logic to test against them.

| Fixture | Demonstrates | Needed by |
|---|---|---|
| `course-files-disabled.json` | 404 from `/files` that is a permission denial | Phase 3 |
| `assignment-section-overrides.json` | `has_overrides` with `all_dates` | Phase 2 |
| `announcement-delayed-post.json` | `created_at` diverging from `posted_at` | Phase 2 |
| `files-same-name-different-folder.json` | Name collision that is not a version | Phase 7 |
| `file-genuine-v2.json` | A real re-upload | Phase 7 |
| `malformed.pdf` | A PDF that must not kill a poll run | Phase 7 |

`assignment-section-overrides.json` is the highest-value one: SPEC.md section 4
records an assumption about how `all_dates` behaves on a **student** token that
has not been checked against a live instance. Capture it before writing any
resolver.
