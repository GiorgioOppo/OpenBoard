/* SPDX-License-Identifier: MIT — bounded concurrent HTTP transport. */
#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#endif
#include "auth.h"
#include "openboard.h"
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <openssl/crypto.h>
#include <openssl/sha.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

OBConfig ob_config = {.port = 8080,
                      .workers = 8,
                      .web_root = "web",
                      .db_path = "data/openboard.db",
                      .busy_timeout_ms = 5000,
                      .body_limit = OB_BODY_LIMIT};
static volatile sig_atomic_t stopping;
static atomic_ullong sequence = 1;
static atomic_ullong metric_requests, metric_errors, metric_duration_ms,
    metric_overloads;
static atomic_uint metric_active;
#define QUEUE_CAPACITY 64
static int queue[QUEUE_CAPACITY], queue_head, queue_count, ready_count,
    failed_workers;
static bool pool_stopping;
static pthread_mutex_t queue_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t queue_available = PTHREAD_COND_INITIALIZER;
static pthread_cond_t workers_ready = PTHREAD_COND_INITIALIZER;

static int64_t milliseconds(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void stop_signal(int sig) {
  (void)sig;
  stopping = 1;
}
static int wait_socket(int fd, short events, int64_t deadline) {
  for (;;) {
    int64_t left = deadline - milliseconds();
    if (left <= 0)
      return 0;
    struct pollfd item = {fd, events, 0};
    int result = poll(&item, 1, left > INT_MAX ? INT_MAX : (int)left);
    if (result < 0 && errno == EINTR)
      continue;
    return result;
  }
  return -1;
}
static ssize_t read_until(int fd, void *data, size_t size, int64_t deadline) {
  for (;;) {
    int ready = wait_socket(fd, POLLIN, deadline);
    if (ready <= 0) {
      errno = ready == 0 ? ETIMEDOUT : EINTR;
      return -1;
    }
    ssize_t n = recv(fd, data, size, 0);
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
      continue;
    return n;
  }
}
static bool send_until(int fd, const void *data, size_t size,
                       int64_t deadline) {
  const char *p = data;
  while (size) {
    if (wait_socket(fd, POLLOUT, deadline) <= 0)
      return false;
    ssize_t n = send(fd, p, size, 0);
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
      continue;
    if (n <= 0)
      return false;
    p += n;
    size -= (size_t)n;
  }
  return true;
}
static int hex_digit(unsigned char c) {
  if (c >= '0' && c <= '9')
    return c - '0';
  if (c >= 'a' && c <= 'f')
    return c - 'a' + 10;
  if (c >= 'A' && c <= 'F')
    return c - 'A' + 10;
  return -1;
}
static int decode(const char *start, size_t size, char *out, size_t capacity) {
  size_t j = 0;
  if (!capacity)
    return -1;
  for (size_t i = 0; i < size; i++) {
    unsigned char c = (unsigned char)start[i];
    if (c == '%') {
      if (i + 2 >= size)
        return -1;
      int a = hex_digit((unsigned char)start[i + 1]),
          b = hex_digit((unsigned char)start[i + 2]);
      if (a < 0 || b < 0)
        return -1;
      c = (unsigned char)(a * 16 + b);
      i += 2;
    } else if (c == '+')
      c = ' ';
    if (!c || c < 32 || c == 127 || j + 1 >= capacity)
      return -1;
    out[j++] = (char)c;
  }
  out[j] = 0;
  return valid_utf8(out, j) ? 0 : -1;
}
int ob_query(const Request *r, const char *key, char *out, size_t capacity) {
  const char *cursor = r->query;
  int found = 0;
  if (capacity)
    out[0] = 0;
  while (*cursor) {
    const char *end = strchr(cursor, '&');
    if (!end)
      end = cursor + strlen(cursor);
    const char *eq = memchr(cursor, '=', (size_t)(end - cursor));
    const char *name_end = eq ? eq : end;
    char name[128];
    if (decode(cursor, (size_t)(name_end - cursor), name, sizeof name))
      return -1;
    if (!strcmp(name, key)) {
      if (found)
        return -1;
      const char *value = eq ? eq + 1 : end;
      if (decode(value, (size_t)(end - value), out, capacity))
        return -1;
      found = 1;
    }
    cursor = *end ? end + 1 : end;
  }
  return found;
}
static bool set_header(char *out, size_t size, const char *value) {
  if (strlen(value) >= size)
    return false;
  memcpy(out, value, strlen(value) + 1);
  return true;
}
static const char *public_authority(void) {
  if (!ob_config.public_url)
    return NULL;
  const char *p = strstr(ob_config.public_url, "://");
  return p ? p + 3 : NULL;
}
static bool valid_host(const char *host) {
  char a[64], b[64];
  snprintf(a, sizeof a, "127.0.0.1:%d", ob_config.port);
  snprintf(b, sizeof b, "localhost:%d", ob_config.port);
  const char *external = public_authority();
  return !strcasecmp(host, a) || !strcasecmp(host, b) ||
         (ob_config.port == 80 &&
          (!strcasecmp(host, "localhost") || !strcmp(host, "127.0.0.1"))) ||
         (external && !strcasecmp(host, external));
}
static bool valid_origin(const Request *r) {
  if (!strcmp(r->fetch_site, "cross-site"))
    return false;
  if (!r->origin[0])
    return true;
  char local[300];
  snprintf(local, sizeof local, "http://%s", r->host);
  if (!strcmp(r->origin, local) &&
      (!public_authority() || strcasecmp(r->host, public_authority())))
    return true;
  if (ob_config.public_url && !strcmp(r->origin, ob_config.public_url))
    return true;
  return !ob_config.public_url && !strcmp(r->origin, local);
}
static int read_request(int fd, Request *r) {
  char headers[OB_HEADER_LIMIT + 1];
  size_t used = 0, header_end = 0;
  int64_t deadline = milliseconds() + 5000;
  while (!header_end) {
    if (used == OB_HEADER_LIMIT)
      return 431;
    ssize_t n =
        read_until(fd, headers + used, OB_HEADER_LIMIT - used, deadline);
    if (n <= 0)
      return errno == ETIMEDOUT ? 408 : 400;
    used += (size_t)n;
    headers[used] = 0;
    if (memchr(headers, 0, used))
      return 400;
    char *end = strstr(headers, "\r\n\r\n");
    if (end)
      header_end = (size_t)(end - headers) + 4;
  }
  size_t initial = used - header_end;
  headers[header_end - 2] = 0;
  char *cursor = headers, *line_end = strstr(cursor, "\r\n");
  if (!line_end)
    return 400;
  *line_end = 0;
  char version[16], extra;
  if (sscanf(cursor, "%11s %1023s %15s %c", r->method, r->path, version,
             &extra) != 3 ||
      strcmp(version, "HTTP/1.1"))
    return 400;
  for (char *p = r->method; *p; p++)
    if (*p < 'A' || *p > 'Z')
      return 400;
  if (r->path[0] != '/' || strchr(r->path, '#'))
    return 400;
  for (char *p = r->path; *p; p++)
    if ((unsigned char)*p <= 32 || (unsigned char)*p >= 127)
      return 400;
  char *query = strchr(r->path, '?');
  if (query) {
    *query++ = 0;
    if (!set_header(r->query, sizeof r->query, query))
      return 400;
  }
  cursor = line_end + 2;
  size_t length = 0;
  unsigned seen = 0;
  while (*cursor) {
    line_end = strstr(cursor, "\r\n");
    if (!line_end)
      return 400;
    *line_end = 0;
    if (!*cursor || *cursor == ' ' || *cursor == '\t')
      return 400;
    char *colon = strchr(cursor, ':');
    if (!colon || colon == cursor)
      return 400;
    for (char *p = cursor; p < colon; p++)
      if (!isalnum((unsigned char)*p) && *p != '-' && *p != '_')
        return 400;
    *colon = 0;
    char *value = colon + 1;
    while (*value == ' ' || *value == '\t')
      value++;
    char *tail = value + strlen(value);
    while (tail > value && (tail[-1] == ' ' || tail[-1] == '\t'))
      *--tail = 0;
    for (char *p = value; *p; p++)
      if ((unsigned char)*p < 32 && *p != '\t')
        return 400;
    unsigned flag = 0;
    char *destination = NULL;
    size_t cap = 0;
#define FIELD(name, member, bit)                                               \
  if (!strcasecmp(cursor, name)) {                                             \
    flag = 1u << (bit);                                                        \
    destination = r->member;                                                   \
    cap = sizeof r->member;                                                    \
  }
    FIELD("Host", host, 0)
    else FIELD("Origin", origin, 1) else FIELD("Content-Type", content_type, 2) else FIELD(
        "Sec-Fetch-Site", fetch_site,
        3) else FIELD("Cookie", cookie,
                      4) else FIELD("X-CSRF-Token", csrf,
                                    5) else FIELD("If-Match", if_match,
                                                  6) else FIELD("Idempotency-"
                                                                "Key",
                                                                idempotency_key,
                                                                7) else FIELD("If-None-Match",
                                                                              if_none_match,
                                                                              8) else if (!strcasecmp(cursor,
                                                                                                      "Content-Length")) {
      flag = 1u << 9;
      if ((seen & flag) || !*value)
        return 400;
      for (char *p = value; *p; p++) {
        if (!isdigit((unsigned char)*p))
          return 400;
        unsigned digit = (unsigned)(*p - '0');
        if (length > ((size_t)ob_config.body_limit - digit) / 10)
          return 413;
        length = length * 10 + digit;
      }
    }
    else if (!strcasecmp(cursor, "X-Request-ID")) {
      flag = 1u << 10;
      if (!*value || strlen(value) >= sizeof r->request_id)
        return 400;
      for (const char *p = value; *p; p++)
        if (!isalnum((unsigned char)*p) && *p != '-' && *p != '_' &&
            *p != '.' && *p != ':')
          return 400;
      destination = r->request_id;
      cap = sizeof r->request_id;
    }
    else if (!strcasecmp(cursor, "Content-Encoding")) {
      flag = 1u << 11;
      if (strcasecmp(value, "identity"))
        return 415;
    }
    else if (!strcasecmp(cursor, "Transfer-Encoding") ||
             !strcasecmp(cursor, "Expect")) return 400;
#undef FIELD
    if (flag) {
      if (seen & flag)
        return 400;
      seen |= flag;
      if (destination && !set_header(destination, cap, value))
        return 400;
    }
    cursor = line_end + 2;
  }
  if (!(seen & 1) || !valid_host(r->host))
    return 403;
  if (initial > length)
    return 400;
  r->body = malloc(length + 1);
  if (!r->body)
    return 503;
  memcpy(r->body, headers + header_end, initial);
  size_t received = initial;
  deadline = milliseconds() + 10000;
  while (received < length) {
    ssize_t n = read_until(fd, r->body + received, length - received, deadline);
    if (n <= 0)
      return errno == ETIMEDOUT ? 408 : 400;
    received += (size_t)n;
  }
  r->body[length] = 0;
  r->body_len = length;
  if (memchr(r->body, 0, length) || !valid_utf8(r->body, length))
    return 400;
  if (strcmp(r->method, "GET") && strcmp(r->method, "HEAD") && !valid_origin(r))
    return 403;
  return 0;
}
static const char *reason(int status) {
  switch (status) {
  case 200:
    return "OK";
  case 201:
    return "Created";
  case 204:
    return "No Content";
  case 304:
    return "Not Modified";
  case 400:
    return "Bad Request";
  case 401:
    return "Unauthorized";
  case 403:
    return "Forbidden";
  case 404:
    return "Not Found";
  case 405:
    return "Method Not Allowed";
  case 408:
    return "Request Timeout";
  case 409:
    return "Conflict";
  case 412:
    return "Precondition Failed";
  case 413:
    return "Content Too Large";
  case 415:
    return "Unsupported Media Type";
  case 429:
    return "Too Many Requests";
  case 431:
    return "Request Header Fields Too Large";
  case 503:
    return "Service Unavailable";
  default:
    return "Internal Server Error";
  }
}
static void send_response(int fd, const Request *request, Response *r,
                          bool head, bool asset) {
  char header[8192];
  size_t length = r->body ? strlen(r->body) : 0;
  int n = snprintf(
      header, sizeof header,
      "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: "
      "%zu\r\nConnection: close\r\nCache-Control: %s\r\n"
      "X-Request-ID: %s\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: "
      "DENY\r\nReferrer-Policy: same-origin\r\n"
      "Content-Security-Policy: default-src 'self'; script-src 'self'; "
      "style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src "
      "'none'; base-uri 'none'; frame-ancestors 'none'; form-action "
      "'self'\r\n%s\r\n",
      r->status, reason(r->status),
      r->type ? r->type : "application/json; charset=utf-8", length,
      asset ? "public, max-age=0, must-revalidate" : "no-store",
      request->request_id, r->headers);
  int64_t deadline = milliseconds() + 10000;
  if (n > 0 && (size_t)n < sizeof header &&
      send_until(fd, header, (size_t)n, deadline) && !head && r->status != 304)
    send_until(fd, r->body, length, deadline);
}
static Response static_file(Request *r) {
  if (strcmp(r->method, "GET"))
    return error_response(405, "Metodo non consentito.");
  const char *name = !strcmp(r->path, "/") ? "index.html" : r->path + 1;
  if (!*name || strstr(name, "..") || strchr(name, '/') || strlen(name) > 128)
    return error_response(404, "Pagina non trovata.");
  for (const char *p = name; *p; p++)
    if (!isalnum((unsigned char)*p) && *p != '.' && *p != '-' && *p != '_')
      return error_response(404, "Pagina non trovata.");
  const char *extension = strrchr(name, '.'), *type = NULL;
  if (extension && !strcmp(extension, ".html"))
    type = "text/html; charset=utf-8";
  else if (extension && !strcmp(extension, ".css"))
    type = "text/css; charset=utf-8";
  else if (extension && !strcmp(extension, ".js"))
    type = "text/javascript; charset=utf-8";
  else if (extension && !strcmp(extension, ".svg"))
    type = "image/svg+xml";
  if (!type)
    return error_response(404, "Pagina non trovata.");
  char path[4096];
  if (snprintf(path, sizeof path, "%s/%s", ob_config.web_root, name) >=
      (int)sizeof path)
    return error_response(500, "Percorso troppo lungo.");
  int file_fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (file_fd < 0)
    return error_response(404, "Asset non trovato.");
  FILE *file = fdopen(file_fd, "rb");
  if (!file) {
    close(file_fd);
    return error_response(500, "Apertura asset fallita.");
  }
  struct stat st;
  if (fstat(fileno(file), &st) || !S_ISREG(st.st_mode) || st.st_size < 0 ||
      st.st_size > 2 * 1024 * 1024) {
    fclose(file);
    return error_response(500, "Asset non valido.");
  }
  size_t size = (size_t)st.st_size;
  char *body = malloc(size + 1);
  if (!body) {
    fclose(file);
    return error_response(503, "Memoria non disponibile.");
  }
  bool read_ok = fread(body, 1, size, file) == size;
  fclose(file);
  body[size] = 0;
  if (!read_ok || memchr(body, 0, size)) {
    free(body);
    return error_response(500, "Lettura asset fallita.");
  }
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256((unsigned char *)body, size, digest);
  char etag[70];
  etag[0] = '"';
  for (size_t i = 0; i < sizeof digest; i++)
    snprintf(etag + 1 + i * 2, 3, "%02x", digest[i]);
  etag[65] = '"';
  etag[66] = 0;
  Response response = {0};
  response.status = 200;
  response.body = body;
  response.type = type;
  snprintf(response.headers, sizeof response.headers, "ETag: %s\r\n", etag);
  if (!strcmp(r->if_none_match, etag)) {
    free(body);
    response.body = strdup("");
    response.status = 304;
  }
  return response;
}
static Response route(Request *r) {
  if (!strcmp(r->path, "/api/health"))
    return !strcmp(r->method, "GET")
               ? json_response(200, "{\"status\":\"ok\"}")
               : error_response(405, "Metodo non consentito.");
  if (!strcmp(r->path, "/api/ready")) {
    if (strcmp(r->method, "GET"))
      return error_response(405, "Metodo non consentito.");
    sqlite3_stmt *statement = NULL;
    bool ready = db && sqlite3_db_readonly(db, "main") == 0 &&
                 sqlite3_prepare_v2(db, "SELECT count(*) FROM metadata", -1,
                                    &statement, NULL) == SQLITE_OK &&
                 sqlite3_step(statement) == SQLITE_ROW;
    sqlite3_finalize(statement);
    return json_response(ready ? 200 : 503,
                         ready ? "{\"status\":\"ready\"}"
                               : "{\"status\":\"unavailable\"}");
  }
  if (!strcmp(r->path, "/api/version")) {
    if (strcmp(r->method, "GET"))
      return error_response(405, "Metodo non consentito.");
    char text[256];
    snprintf(text, sizeof text,
             "{\"version\":\"%s\",\"sqlite\":\"%s\",\"auth_enabled\":%s,"
             "\"workers\":%d}",
             OB_VERSION, sqlite3_libversion(),
             ob_config.auth_enabled ? "true" : "false", ob_config.workers);
    return json_response(200, text);
  }
  return !strncmp(r->path, "/api/", 5) ? ob_route(r) : static_file(r);
}
static void quote_log(const char *in, char *out, size_t capacity) {
  size_t n = 0;
  for (; *in && n + 3 < capacity; in++) {
    unsigned char c = (unsigned char)*in;
    if (c == '"' || c == '\\')
      out[n++] = '\\';
    out[n++] = c < 32 ? '?' : (char)c;
  }
  out[n] = 0;
}
static void handle(int fd) {
  Request request = {0};
  snprintf(request.request_id, sizeof request.request_id, "%lx-%llu",
           (unsigned long)getpid(),
           (unsigned long long)atomic_fetch_add(&sequence, 1));
  snprintf(request.peer, sizeof request.peer, "127.0.0.1");
  int64_t start = milliseconds();
  atomic_fetch_add(&metric_requests, 1);
  atomic_fetch_add(&metric_active, 1);
  int status = read_request(fd, &request);
  bool head = !strcmp(request.method, "HEAD");
  char method[12];
  memcpy(method, request.method, sizeof method);
  if (head)
    snprintf(request.method, sizeof request.method, "GET");
  Response response =
      status
          ? error_response(
                status, status == 408 ? "Tempo totale della richiesta scaduto."
                        : status == 413 ? "Richiesta troppo grande."
                        : status == 431 ? "Header troppo grandi."
                        : status == 403 ? "Origine o host non consentiti."
                                        : "Richiesta HTTP non valida.")
          : route(&request);
  send_response(fd, &request, &response, head,
                strncmp(request.path, "/api/", 5) != 0);
  if (!ob_config.quiet) {
    char path[2048];
    quote_log(request.path, path, sizeof path);
    flockfile(stderr);
    fprintf(stderr,
            "{\"request_id\":\"%s\",\"method\":\"%s\",\"path\":\"%s\","
            "\"status\":%d,\"duration_ms\":%lld}\n",
            request.request_id, method, path, response.status,
            (long long)(milliseconds() - start));
    funlockfile(stderr);
  }
  free(response.body);
  free(request.body);
  if (response.status >= 400)
    atomic_fetch_add(&metric_errors, 1);
  atomic_fetch_add(&metric_duration_ms,
                   (unsigned long long)(milliseconds() - start));
  atomic_fetch_sub(&metric_active, 1);
}
Response ob_metrics(Request *request) {
  if (strcmp(request->method, "GET"))
    return error_response(405, "Metodo non consentito.");
  if (ob_config.auth_enabled && !auth_is_admin(request))
    return error_response(403, "Metriche riservate agli amministratori.");
  pthread_mutex_lock(&queue_lock);
  int queued = queue_count;
  pthread_mutex_unlock(&queue_lock);
  char body[2048];
  snprintf(body, sizeof body,
           "# TYPE openboard_http_requests_total "
           "counter\nopenboard_http_requests_total %llu\n"
           "# TYPE openboard_http_errors_total "
           "counter\nopenboard_http_errors_total %llu\n"
           "# TYPE openboard_http_duration_seconds_total "
           "counter\nopenboard_http_duration_seconds_total %.3f\n"
           "# TYPE openboard_http_active gauge\nopenboard_http_active %u\n"
           "# TYPE openboard_http_queued gauge\nopenboard_http_queued %d\n"
           "# TYPE openboard_http_overloads_total "
           "counter\nopenboard_http_overloads_total %llu\n"
           "# TYPE openboard_workers gauge\nopenboard_workers %d\n",
           (unsigned long long)atomic_load(&metric_requests),
           (unsigned long long)atomic_load(&metric_errors),
           (double)atomic_load(&metric_duration_ms) / 1000.0,
           atomic_load(&metric_active), queued,
           (unsigned long long)atomic_load(&metric_overloads),
           ob_config.workers);
  Response result = json_response(200, body);
  result.type = "text/plain; version=0.0.4; charset=utf-8";
  return result;
}
static void *worker(void *unused) {
  (void)unused;
  int initialized = ob_worker_init();
  pthread_mutex_lock(&queue_lock);
  ready_count++;
  if (initialized)
    failed_workers++;
  pthread_cond_signal(&workers_ready);
  pthread_mutex_unlock(&queue_lock);
  if (initialized)
    return NULL;
  for (;;) {
    pthread_mutex_lock(&queue_lock);
    while (!queue_count && !pool_stopping)
      pthread_cond_wait(&queue_available, &queue_lock);
    if (!queue_count && pool_stopping) {
      pthread_mutex_unlock(&queue_lock);
      break;
    }
    int fd = queue[queue_head];
    queue_head = (queue_head + 1) % QUEUE_CAPACITY;
    queue_count--;
    pthread_mutex_unlock(&queue_lock);
    handle(fd);
    close(fd);
  }
  ob_worker_close();
  return NULL;
}
static void usage(const char *name) {
  printf("OpenBoard %s\nUso: %s [--port 8080] [--db data/openboard.db] "
         "[--web-root web]\n  --workers 8       Worker HTTP (1..32)\n  --auth  "
         "          Account, sessioni e permessi\n  --public-url URL  Origine "
         "pubblica http(s), proxy sullo stesso host\n  --no-demo         "
         "Database nuovo senza bacheche dimostrative\n  --backup PATH     "
         "Backup consistente ed uscita\n  --quiet           Disabilita log "
         "delle richieste\n",
         OB_VERSION, name);
  puts("  --busy-timeout MS Attesa lock SQLite (1..60000, default 5000)\n"
       "  --body-limit N    Limite corpo HTTP in byte (4096..2097152)\n"
       "  --integrity-check Controlla il DB esistente, senza migrazioni\n"
       "  --checkpoint      Checkpoint WAL TRUNCATE del DB esistente\n"
       "  --diagnostics     JSON con versioni, schema e limiti; nessun server\n"
       "Variabili OPENBOARD_PORT, WORKERS, DB, WEB_ROOT, PUBLIC_URL, AUTH, "
       "NO_DEMO, QUIET, BUSY_TIMEOUT, BODY_LIMIT (tutte con prefisso "
       "OPENBOARD_). CLI prevale.");
}
static bool valid_public_url(const char *url) {
  const char *p = !strncmp(url, "https://", 8)  ? url + 8
                  : !strncmp(url, "http://", 7) ? url + 7
                                                : NULL;
  if (!p || !*p || strlen(url) > 300)
    return false;
  for (; *p; p++)
    if (!isalnum((unsigned char)*p) && *p != '.' && *p != '-' && *p != ':')
      return false;
  return true;
}
static bool config_number(const char *value, int *out, int min, int max) {
  int64_t n = parse_id(value);
  if (n < min || n > max)
    return false;
  *out = (int)n;
  return true;
}
static bool env_bool(const char *name, bool *out) {
  const char *v = getenv(name);
  if (!v)
    return true;
  if (!strcmp(v, "1") || !strcasecmp(v, "true") || !strcasecmp(v, "yes"))
    *out = true;
  else if (!strcmp(v, "0") || !strcasecmp(v, "false") || !strcasecmp(v, "no"))
    *out = false;
  else
    return false;
  return true;
}
static bool environment_config(void) {
  struct {
    const char *name;
    int *out;
    int min, max;
  } numbers[] = {
      {"OPENBOARD_PORT", &ob_config.port, 1, 65535},
      {"OPENBOARD_WORKERS", &ob_config.workers, 1, 32},
      {"OPENBOARD_BUSY_TIMEOUT", &ob_config.busy_timeout_ms, 1, 60000},
      {"OPENBOARD_BODY_LIMIT", &ob_config.body_limit, 4096, OB_BODY_LIMIT}};
  for (size_t i = 0; i < sizeof numbers / sizeof numbers[0]; i++) {
    const char *v = getenv(numbers[i].name);
    if (v && !config_number(v, numbers[i].out, numbers[i].min, numbers[i].max))
      return false;
  }
  const char *v = getenv("OPENBOARD_DB");
  if (v)
    ob_config.db_path = v;
  v = getenv("OPENBOARD_WEB_ROOT");
  if (v)
    ob_config.web_root = v;
  v = getenv("OPENBOARD_PUBLIC_URL");
  if (v && *v) {
    if (!valid_public_url(v))
      return false;
    ob_config.public_url = v;
  }
  return env_bool("OPENBOARD_AUTH", &ob_config.auth_enabled) &&
         env_bool("OPENBOARD_NO_DEMO", &ob_config.no_demo) &&
         env_bool("OPENBOARD_QUIET", &ob_config.quiet);
}
static int maintenance(void) {
  sqlite3 *connection = NULL;
  int mode =
      ob_config.checkpoint ? SQLITE_OPEN_READWRITE : SQLITE_OPEN_READONLY;
  int opened = sqlite3_open_v2(ob_config.db_path, &connection, mode, NULL);
  if (ob_config.diagnostics) {
    int schema = -1;
    sqlite3_stmt *statement = NULL;
    if (opened == SQLITE_OK &&
        sqlite3_prepare_v2(connection, "PRAGMA user_version", -1, &statement,
                           NULL) == SQLITE_OK &&
        sqlite3_step(statement) == SQLITE_ROW)
      schema = sqlite3_column_int(statement, 0);
    sqlite3_finalize(statement);
    sqlite3_close(connection);
    printf("{\"version\":\"%s\",\"sqlite\":\"%s\",\"openssl\":\"%s\",\"sqlite_"
           "threadsafe\":%d,\"schema_version\":%d,\"auth_enabled\":%s,"
           "\"workers\":%d,\"busy_timeout_ms\":%d,\"body_limit\":%d}\n",
           OB_VERSION, sqlite3_libversion(), OpenSSL_version(OPENSSL_VERSION),
           sqlite3_threadsafe(), schema,
           ob_config.auth_enabled ? "true" : "false", ob_config.workers,
           ob_config.busy_timeout_ms, ob_config.body_limit);
    return 0;
  }
  if (opened != SQLITE_OK) {
    fprintf(stderr, "Database esistente non accessibile: %s\n",
            sqlite3_errmsg(connection));
    sqlite3_close(connection);
    return 1;
  }
  sqlite3_busy_timeout(connection, ob_config.busy_timeout_ms);
  sqlite3_stmt *statement = NULL;
  const char *sql = ob_config.checkpoint ? "PRAGMA wal_checkpoint(TRUNCATE)"
                                         : "PRAGMA integrity_check";
  bool ok =
      sqlite3_prepare_v2(connection, sql, -1, &statement, NULL) == SQLITE_OK;
  int rc = ok ? sqlite3_step(statement) : SQLITE_ERROR;
  if (ob_config.checkpoint) {
    ok = rc == SQLITE_ROW && sqlite3_column_int(statement, 0) == 0;
    if (ok)
      printf(
          "{\"status\":\"ok\",\"wal_frames\":%d,\"checkpointed_frames\":%d}\n",
          sqlite3_column_int(statement, 1), sqlite3_column_int(statement, 2));
  } else {
    ok = rc == SQLITE_ROW && sqlite3_column_text(statement, 0) &&
         !strcmp((const char *)sqlite3_column_text(statement, 0), "ok");
    if (ok)
      puts("{\"integrity\":\"ok\"}");
  }
  if (!ok)
    fputs("Controllo o checkpoint fallito; database non modificato dallo "
          "schema applicativo.\n",
          stderr);
  sqlite3_finalize(statement);
  sqlite3_close(connection);
  return ok ? 0 : 1;
}
int main(int argc, char **argv) {
  if (!environment_config()) {
    fputs("Configurazione OPENBOARD_* non valida.\n", stderr);
    return 1;
  }
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) {
      usage(argv[0]);
      return 0;
    }
    if (!strcmp(argv[i], "--version")) {
      puts(OB_VERSION);
      return 0;
    }
    if (!strcmp(argv[i], "--auth")) {
      ob_config.auth_enabled = true;
      continue;
    }
    if (!strcmp(argv[i], "--no-demo")) {
      ob_config.no_demo = true;
      continue;
    }
    if (!strcmp(argv[i], "--quiet")) {
      ob_config.quiet = true;
      continue;
    }
    if (!strcmp(argv[i], "--integrity-check")) {
      ob_config.integrity_check = true;
      continue;
    }
    if (!strcmp(argv[i], "--checkpoint")) {
      ob_config.checkpoint = true;
      continue;
    }
    if (!strcmp(argv[i], "--diagnostics")) {
      ob_config.diagnostics = true;
      continue;
    }
    if (i + 1 >= argc) {
      usage(argv[0]);
      return 1;
    }
    const char *option = argv[i], *value = argv[++i];
    if (!strcmp(option, "--port")) {
      int64_t n = parse_id(value);
      if (n < 1 || n > 65535)
        return 1;
      ob_config.port = (int)n;
    } else if (!strcmp(option, "--workers")) {
      int64_t n = parse_id(value);
      if (n < 1 || n > 32)
        return 1;
      ob_config.workers = (int)n;
    } else if (!strcmp(option, "--db"))
      ob_config.db_path = value;
    else if (!strcmp(option, "--web-root"))
      ob_config.web_root = value;
    else if (!strcmp(option, "--backup"))
      ob_config.backup_path = value;
    else if (!strcmp(option, "--busy-timeout")) {
      if (!config_number(value, &ob_config.busy_timeout_ms, 1, 60000))
        return 1;
    } else if (!strcmp(option, "--body-limit")) {
      if (!config_number(value, &ob_config.body_limit, 4096, OB_BODY_LIMIT))
        return 1;
    } else if (!strcmp(option, "--public-url")) {
      if (!valid_public_url(value)) {
        fputs("Origine pubblica non valida (senza percorso o slash finale).\n",
              stderr);
        return 1;
      }
      ob_config.public_url = value;
    } else {
      usage(argv[0]);
      return 1;
    }
  }
  if (!*ob_config.db_path || !*ob_config.web_root ||
      (ob_config.backup_path && !*ob_config.backup_path))
    return 1;
  int maintenance_modes =
      ob_config.integrity_check + ob_config.checkpoint + ob_config.diagnostics;
  if (maintenance_modes > 1 || (maintenance_modes && ob_config.backup_path))
    return 1;
  if (maintenance_modes)
    return maintenance();
  signal(SIGPIPE, SIG_IGN);
  struct sigaction action = {0};
  action.sa_handler = stop_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGTERM, &action, NULL);
  if (ob_initialize_database())
    return 1;
  if (ob_config.backup_path) {
    int result = ob_backup(ob_config.backup_path);
    ob_worker_close();
    return result;
  }
  ob_worker_close();
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) {
    perror("socket");
    return 1;
  }
  int reuse = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)ob_config.port);
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  if (bind(listener, (struct sockaddr *)&address, sizeof address) ||
      listen(listener, QUEUE_CAPACITY)) {
    perror("bind/listen");
    close(listener);
    return 1;
  }
  fcntl(listener, F_SETFL, fcntl(listener, F_GETFL) | O_NONBLOCK);
  pthread_t threads[32];
  int started = 0;
  for (; started < ob_config.workers; started++)
    if (pthread_create(&threads[started], NULL, worker, NULL))
      break;
  pthread_mutex_lock(&queue_lock);
  while (ready_count < started)
    pthread_cond_wait(&workers_ready, &queue_lock);
  bool failed = failed_workers || started != ob_config.workers;
  pthread_mutex_unlock(&queue_lock);
  if (failed)
    stopping = 1;
  if (!failed) {
    printf("OpenBoard %s: http://127.0.0.1:%d\nDatabase: %s · worker: %d · "
           "accessi: %s\nPremi Ctrl+C per uscire.\n",
           OB_VERSION, ob_config.port, ob_config.db_path, ob_config.workers,
           ob_config.auth_enabled ? "account" : "locale");
    fflush(stdout);
  }
  while (!stopping) {
    struct pollfd p = {listener, POLLIN, 0};
    int available = poll(&p, 1, 200);
    if (available < 0 && errno == EINTR)
      continue;
    if (available <= 0)
      continue;
    int fd = accept(listener, NULL, NULL);
    if (fd < 0)
      continue;
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    pthread_mutex_lock(&queue_lock);
    if (queue_count == QUEUE_CAPACITY) {
      atomic_fetch_add(&metric_overloads, 1);
      pthread_mutex_unlock(&queue_lock);
      const char reply[] = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: "
                           "application/json\r\nContent-Length: "
                           "37\r\nConnection: close\r\nRetry-After: "
                           "1\r\n\r\n{\"error\":\"Server occupato. Riprova.\"}";
      send(fd, reply, sizeof reply - 1, 0);
      close(fd);
    } else {
      queue[(queue_head + queue_count) % QUEUE_CAPACITY] = fd;
      queue_count++;
      pthread_cond_signal(&queue_available);
      pthread_mutex_unlock(&queue_lock);
    }
  }
  close(listener);
  pthread_mutex_lock(&queue_lock);
  pool_stopping = true;
  while (queue_count) {
    close(queue[queue_head]);
    queue_head = (queue_head + 1) % QUEUE_CAPACITY;
    queue_count--;
  }
  pthread_cond_broadcast(&queue_available);
  pthread_mutex_unlock(&queue_lock);
  for (int i = 0; i < started; i++)
    pthread_join(threads[i], NULL);
  puts("OpenBoard arrestato.");
  return failed ? 1 : 0;
}
