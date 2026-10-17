/* SPDX-License-Identifier: MIT
 * Exercise the actual private transport parsers without opening a TCP port.
 * The CLI entry point is compiled but never invoked. */
#define main openboard_fuzz_http_cli
#include "../src/http.c"
#undef main
#include <assert.h>

#define FUZZ_LIMIT 65536

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (!size || size > FUZZ_LIMIT) return 0;
  unsigned controls = data[0], mode = controls % 4;
  data++; size--;
  if (mode == 0) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) abort();
    int capacity = FUZZ_LIMIT * 2;
    (void)setsockopt(pair[0], SOL_SOCKET, SO_SNDBUF, &capacity, sizeof capacity);
    int flags = fcntl(pair[0], F_GETFL);
    if (flags < 0 || fcntl(pair[0], F_SETFL, flags | O_NONBLOCK)) abort();
    size_t sent = 0;
    while (sent < size) {
      ssize_t n = send(pair[0], data + sent, size - sent, 0);
      if (n > 0) sent += (size_t)n;
      else if (n < 0 && errno == EINTR) continue;
      else break;
    }
    /* EOF prevents malformed/incomplete bodies from consuming a deadline. */
    if (shutdown(pair[0], SHUT_WR)) abort();
    ob_config.body_limit = FUZZ_LIMIT;
    ob_config.public_url = controls & 8 ? "https://fuzz.example.invalid" : NULL;
    ob_config.trusted_proxy = controls & 4 ? "192.0.2.10" : NULL;
    Request request = {0};
    snprintf(request.peer, sizeof request.peer, "%s", controls & 4 ? "192.0.2.10" : "127.0.0.1");
    int status = read_request(pair[1], &request);
    assert(status == 0 || status == 400 || status == 403 || status == 408 ||
           status == 413 || status == 415 || status == 431 || status == 503);
    if (!status) {
      assert(request.body && request.body_len <= FUZZ_LIMIT);
      assert(request.body[request.body_len] == 0);
      assert(!memchr(request.body, 0, request.body_len));
      assert(valid_utf8(request.body, request.body_len));
      assert(request.path[0] == '/');
    }
    free(request.body);
    close(pair[0]); close(pair[1]);
  } else if (mode == 1 || mode == 2) {
    char out[64]; memset(out, 0xa5, sizeof out);
    size_t capacity = size ? data[0] % (sizeof out + 1) : 0;
    if (size) { data++; size--; }
    int result;
    if (mode == 1) result = decode((const char *)data, size, out, capacity);
    else {
      Request request = {0};
      size_t n = size < sizeof request.query - 1 ? size : sizeof request.query - 1;
      memcpy(request.query, data, n);
      result = ob_query(&request, "q", out, capacity);
      assert(result >= -1 && result <= 1);
    }
    if ((mode == 1 && result == 0) || (mode == 2 && result == 1)) {
      assert(capacity && memchr(out, 0, capacity));
      assert(valid_utf8(out, strlen(out)));
      for (const unsigned char *p = (const unsigned char *)out; *p; p++)
        assert(*p >= 32 && *p != 127);
    }
  } else {
    char value[FUZZ_LIMIT + 1], canonical[64];
    memcpy(value, data, size); value[size] = 0;
    if (client_address(value, canonical)) {
      struct in_addr v4; struct in6_addr v6;
      assert(inet_pton(AF_INET, canonical, &v4) == 1 ||
             inet_pton(AF_INET6, canonical, &v6) == 1);
      char again[64]; assert(client_address(canonical, again));
      assert(!strcmp(canonical, again));
    }
  }
  return 0;
}
