/* Keep HTTP authentication quota tests inside one fixed window, even when
 * password hashing takes a long time. Only auth.c sees this clock override;
 * the HTTP transport and its connection deadlines use the real clock. */
#include <time.h>

static int auth_transport_clock_gettime(clockid_t clock_id,
                                        struct timespec *timestamp) {
    if (clock_id == CLOCK_MONOTONIC) {
        timestamp->tv_sec = 30001;
        timestamp->tv_nsec = 0;
        return 0;
    }
    return clock_gettime(clock_id, timestamp);
}

#define clock_gettime auth_transport_clock_gettime
#include "../../src/auth.c"
#undef clock_gettime
