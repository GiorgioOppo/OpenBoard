FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential pkg-config python3 libsqlite3-dev libssl-dev libpq-dev libmongoc-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Makefile ./
COPY src/ src/
COPY vendor/ vendor/
RUN make EXTERNAL_STORAGE=1 \
    CFLAGS="-O2 -g -std=c11 -Wall -Wextra -Wpedantic -Wformat -Werror=format-security -fstack-protector-strong -fPIE -D_FORTIFY_SOURCE=3" \
    LDFLAGS="-pie -Wl,-z,relro,-z,now,-z,noexecstack"

FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libsqlite3-0 libssl3t64 libpq5 libmongoc-1.0-0t64 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 openboard \
    && useradd --system --uid 10001 --gid openboard --home-dir /tmp/openboard openboard
COPY --from=builder /src/build/openboard /usr/local/bin/openboard
COPY LICENSE /usr/local/share/licenses/openboard/LICENSE
COPY vendor/utf8proc/LICENSE.md /usr/local/share/licenses/openboard/utf8proc-LICENSE.md
COPY scripts/container-healthcheck.sh /usr/local/bin/openboard-healthcheck
RUN chmod 755 /usr/local/bin/openboard-healthcheck
USER 10001:10001
ENV OPENBOARD_DB=/tmp/openboard/cache.db \
    OPENBOARD_BIND=0.0.0.0 \
    OPENBOARD_AUTH=true \
    OPENBOARD_NO_DEMO=true
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=5 \
    CMD ["/usr/local/bin/openboard-healthcheck"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/openboard"]
