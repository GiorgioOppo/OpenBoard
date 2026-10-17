/* Test-only filesystem measurements and a non-mutating SQLite BEGIN observer.
 * Production storage.c is compiled unchanged into this translation unit. */
#define _POSIX_C_SOURCE 200809L
#include "../../src/openboard.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/statvfs.h>
#include <unistd.h>

static int fixture_statvfs(const char *, struct statvfs *);
/* Function-like substitution leaves `struct statvfs` and its header intact. */
#define statvfs(path, info) fixture_statvfs((path), (info))
#include "../../src/storage.c"
#undef statvfs

static int fixture_begin_observer(unsigned event, void *context,
                                  void *statement, void *detail) {
  (void)context;
  (void)detail;
  if (event != SQLITE_TRACE_STMT) return 0;
  const char *sql = sqlite3_sql((sqlite3_stmt *)statement);
  const char *signal = getenv("OPENBOARD_FIXTURE_STORAGE_BEGIN");
  if (!sql || strcmp(sql, "BEGIN IMMEDIATE") || !signal || !*signal) return 0;
  int fd = open(signal, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd >= 0) {
    const char marker[] = "BEGIN IMMEDIATE\n";
    (void)write(fd, marker, sizeof marker - 1);
    close(fd);
  }
  return 0;
}

static int fixture_statvfs(const char *path, struct statvfs *info) {
  (void)path;
  /* Merely observe when the real engine starts BEGIN. Do not replace its busy
   * handler, timeout, locks, hashing, SQL execution or transaction outcomes. */
  if (db && sqlite3_trace_v2(db, SQLITE_TRACE_STMT,
                            fixture_begin_observer, NULL) != SQLITE_OK) {
    errno = EIO;
    return -1;
  }
  const char *control = getenv("OPENBOARD_FIXTURE_STORAGE_PRESSURE");
  FILE *file = control && *control ? fopen(control, "r") : NULL;
  if (!file) return -1;
  char state[16] = {0};
  bool read = fgets(state, sizeof state, file) != NULL;
  fclose(file);
  if (!read || !strcmp(state, "error\n")) {
    errno = EIO;
    return -1;
  }
  if (strcmp(state, "ok\n") && strcmp(state, "low\n")) {
    errno = EINVAL;
    return -1;
  }
  memset(info, 0, sizeof *info);
  info->f_bsize = info->f_frsize = 4096;
  info->f_bavail = !strcmp(state, "ok\n") ? 1048576 : 0;
  return 0;
}
