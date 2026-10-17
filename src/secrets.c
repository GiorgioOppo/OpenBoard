/* Private file-backed service credentials. SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include "secrets.h"
#include <errno.h>
#include <fcntl.h>
#include <openssl/crypto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SECRET_LIMIT 16384

static int load_secret(const char *name, const char *file_name) {
    const char *path = getenv(file_name);
    if (!path) return 0;
    if (!*path || getenv(name)) goto invalid;
    /* O_NONBLOCK also prevents an accidentally mounted FIFO from blocking
     * startup before fstat can reject it. Never follow a final symlink. */
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) goto invalid;
    struct stat info;
    char *value = NULL;
    size_t used = 0;
    int result = -1;
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) ||
        (info.st_mode & (S_IRWXG | S_IRWXO)) ||
        info.st_size <= 0 || info.st_size > SECRET_LIMIT) goto done;
    value = malloc(SECRET_LIMIT + 1);
    if (!value) goto done;
    while (used < SECRET_LIMIT + 1) {
        ssize_t count = read(fd, value + used, SECRET_LIMIT + 1 - used);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) goto done;
        if (!count) break;
        used += (size_t)count;
    }
    if (!used || used > SECRET_LIMIT || memchr(value, '\0', used)) goto done;
    if (used && value[used - 1] == '\n') used--;
    if (used && value[used - 1] == '\r') used--;
    if (!used || memchr(value, '\n', used) || memchr(value, '\r', used)) goto done;
    value[used] = '\0';
    result = setenv(name, value, 1) == 0 ? 0 : -1;
done:
    if (value) { OPENSSL_cleanse(value, SECRET_LIMIT + 1); free(value); }
    close(fd);
    if (!result) return 0;
invalid:
    fprintf(stderr, "Invalid private credential file configuration: %s.\n", file_name);
    return -1;
}

int ob_load_secret_files(void) {
    if (load_secret("OPENBOARD_POSTGRES_URL", "OPENBOARD_POSTGRES_URL_FILE")) return -1;
    return load_secret("OPENBOARD_MONGODB_URI", "OPENBOARD_MONGODB_URI_FILE");
}
