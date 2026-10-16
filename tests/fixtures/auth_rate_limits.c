/* Exercise the real private limiter, with a deterministic clock and seed. */
#include "../../src/auth.c"
#include <assert.h>
#include <stdatomic.h>

static void reset_rates(void) {
    memset(peer_rates, 0, sizeof peer_rates);
    memset(user_rates, 0, sizeof user_rates);
    memset(rate_secret, 0x4a, sizeof rate_secret);
    rate_seeded = true;
    rate_current_window = 0;
}
static atomic_uint accepted;
static void *concurrent_attempt(void *unused) {
    (void)unused;
    Request r = {0}; snprintf(r.peer, sizeof r.peer, "192.0.2.1");
    if (rate_allowed_at(&r, "login", "admin", 100)) atomic_fetch_add(&accepted, 1);
    return NULL;
}
int main(void) {
    /* Partial collisions do not block a distinct key; a complete collision
     * rejects conservatively. All rows expire together, never one at a time. */
    RateCounter counters[8] = {0};
    size_t indices[RATE_ROWS] = {0, 2, 4, 6};
    for (size_t i = 0; i < RATE_ROWS; i++) counters[indices[i]] = (RateCounter){100, i < 3 ? 60 : 0};
    assert(rate_available(counters, indices, 60, 100));
    for (unsigned i = 0; i < 60; i++) {
        assert(rate_available(counters, indices, 60, 100));
        rate_reserve(counters, indices);
    }
    assert(!rate_available(counters, indices, 60, 100));
    assert(rate_available(counters, indices, 60, 101));
    for (size_t i = 0; i < RATE_ROWS; i++) assert(counters[indices[i]].attempts == 0);
    for (size_t i = 0; i < RATE_ROWS; i++) counters[indices[i]].attempts = UINT_MAX;
    rate_reserve(counters, indices);
    assert(!rate_available(counters, indices, 60, 101));
    for (size_t i = 0; i < RATE_ROWS; i++) assert(counters[indices[i]].attempts == UINT_MAX);

    reset_rates();
    Request r = {0}; snprintf(r.peer, sizeof r.peer, "192.0.2.1");
    size_t first[RATE_ROWS], second[RATE_ROWS];
    assert(rate_indices("peer:192.0.2.1", RATE_PEER_SLOTS, first));
    assert(rate_indices("peer:192.0.2.1", RATE_PEER_SLOTS, second));
    assert(!memcmp(first, second, sizeof first));
    rate_secret[0] ^= 0xff;
    assert(rate_indices("peer:192.0.2.1", RATE_PEER_SLOTS, second));
    assert(memcmp(first, second, sizeof first));
    reset_rates();
    for (unsigned i = 0; i < 10; i++) assert(rate_allowed_at(&r, "login", "admin", 100));
    assert(!rate_allowed_at(&r, "login", "admin", 100));
    snprintf(r.peer, sizeof r.peer, "192.0.2.2");
    assert(rate_allowed_at(&r, "login", "admin", 100));
    snprintf(r.peer, sizeof r.peer, "192.0.2.1");
    assert(rate_allowed_at(&r, "password", "admin", 100));
    assert(rate_allowed_at(&r, "login", "admin", 101));
    for (unsigned i = 1; i < 10; i++) assert(rate_allowed_at(&r, "login", "admin", 101));
    assert(!rate_allowed_at(&r, "login", "admin", 100));
    assert(!rate_allowed_at(&r, "login", "admin", 101));
    assert(rate_allowed_at(&r, "login", "admin", 102));

    reset_rates();
    /* Rotating names cannot reset an IP's budget. A rejected username does
     * not consume expensive-verification capacity from a different user. */
    char username[64];
    for (unsigned i = 0; i < 60; i++) {
        snprintf(username, sizeof username, "unknown-%u", i);
        assert(rate_allowed_at(&r, "login", username, 100));
    }
    assert(!rate_allowed_at(&r, "login", "another-unknown", 100));
    snprintf(r.peer, sizeof r.peer, "192.0.2.2");
    assert(rate_allowed_at(&r, "login", "admin", 100));

    reset_rates();
    /* More than the old global 80 attempts and old 256 account slots cannot
     * deny a new client. This does not require expensive password hashing. */
    for (unsigned client = 0; client < 1024; client++) {
        snprintf(r.peer, sizeof r.peer, "198.18.%u.%u", client / 256, client % 256);
        snprintf(username, sizeof username, "nonexistent-%u", client);
        assert(rate_allowed_at(&r, "login", username, 100));
    }
    snprintf(r.peer, sizeof r.peer, "203.0.113.1");
    assert(rate_allowed_at(&r, "login", "admin", 100));

    reset_rates();
    atomic_store(&accepted, 0);
    pthread_t threads[32];
    for (size_t i = 0; i < 32; i++) assert(pthread_create(&threads[i], NULL, concurrent_attempt, NULL) == 0);
    for (size_t i = 0; i < 32; i++) assert(pthread_join(threads[i], NULL) == 0);
    assert(atomic_load(&accepted) == 10);
    puts("auth limiter: collisions, expiry, saturation, isolation, capacity and atomic reservations OK");
    return 0;
}
