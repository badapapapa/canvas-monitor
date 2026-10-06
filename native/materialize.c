/*
 * materialize -- download online-only OneDrive files for the mirror
 * (DECISIONS.md D-73, D-77).
 *
 * macOS refuses to download a "dataless" (online-only) file for a process
 * whose I/O policy forbids it, and the system default for processes is to
 * forbid it; children inherit their parent's policy. The mirror's launchd job
 * therefore gets EDEADLK ("Unknown system error -11") on such a file.
 *
 * The mirror runs this helper, as its own child, only for files it was
 * refused that way. The helper:
 *   1. allows dataless-file materialization for ITSELF only
 *      (setiopolicy_np, IOPOL_SCOPE_PROCESS);
 *   2. opens each path read-only, never following a symlink, and reads it
 *      through to the end, which makes OneDrive download it;
 *   3. writes nothing, prints no path, and exits:
 *        0  every file was read; 1  some could not be; 2  usage; 3  policy refused.
 *
 * It never writes, renames or deletes anything, and touches nothing in
 * OneDrive's cloud copy: a download only fills in the local copy. The mirror
 * passes only paths its guard has already approved as inside the archive.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: materialize <file>...\n");
    return 2;
  }
  if (setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS,
                     IOPOL_MATERIALIZE_DATALESS_FILES_ON) != 0) {
    fprintf(stderr, "materialize: setiopolicy_np: %s\n", strerror(errno));
    return 3;
  }
  static char buf[1 << 16];
  int failed = 0;
  for (int i = 1; i < argc; i++) {
    int fd = open(argv[i], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) {
      fprintf(stderr, "materialize: file %d: open: %s\n", i, strerror(errno));
      failed++;
      continue;
    }
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf)) > 0) {
    }
    if (n < 0) {
      fprintf(stderr, "materialize: file %d: read: %s\n", i, strerror(errno));
      failed++;
    }
    close(fd);
  }
  return failed == 0 ? 0 : 1;
}
