#ifndef OPENBOARD_H
#define OPENBOARD_H
#include <sqlite3.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define OB_VERSION "0.6.1"
#define OB_HEADER_LIMIT 16384
#define OB_BODY_LIMIT 2097152

typedef struct {
  char method[12], path[1024], query[2048], host[256], origin[512];
  char content_type[128], fetch_site[32], cookie[2048], csrf[128];
  char if_match[80], if_none_match[128], idempotency_key[128], request_id[64],
      peer[64];
  char *body;
  size_t body_len;
  int64_t user_id;
  char role[16];
} Request;

typedef struct {
  int status;
  char *body;
  const char *type;
  char headers[2048];
} Response;

typedef struct {
  int port, workers;
  const char *db_path, *public_url, *backup_path, *bind_address, *trusted_proxy;
  bool auth_enabled, no_demo, quiet;
  int busy_timeout_ms, body_limit;
  bool integrity_check, checkpoint, diagnostics;
} OBConfig;

extern OBConfig ob_config;
extern _Thread_local sqlite3 *db;
sqlite3_stmt *prepare(const char *sql);
void bind_text(sqlite3_stmt *s, int index, const char *value);
void sql_exec(const char *sql);
Response json_response(int status, const char *json);
Response error_response(int status, const char *message);
Response success(int status, int64_t id);
Response query_json(const char *sql, int64_t id);
bool valid_object(const char *json);
int json_string(const char *json, const char *field, char **out, size_t limit);
int json_integer(const char *json, const char *field, int64_t *out, int64_t min,
                 int64_t max, bool boolean);
int64_t parse_id(const char *s);
bool valid_utf8(const char *s, size_t length);
void ob_free(void *pointer);
int ob_initialize_database(void);
int ob_worker_init(void);
void ob_worker_close(void);
Response ob_route(Request *request);
/* Internal composition, inside the request transaction and under the same ACL. */
Response ob_create_card(Request *request, int64_t column, const char *payload);
int ob_backup(const char *path);
int ob_query(const Request *request, const char *key, char *out,
             size_t capacity);
Response ob_metrics(Request *request);
#endif
