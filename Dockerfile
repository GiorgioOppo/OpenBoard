FROM debian:trixie-slim AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential pkg-config libsqlite3-dev libssl-dev libpq-dev libmongoc-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Makefile ./
COPY src/ src/
RUN make EXTERNAL_STORAGE=1

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libsqlite3-0 libssl3t64 libpq5 libmongoc-1.0-0t64 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 openboard \
    && useradd --system --uid 10001 --gid openboard --home-dir /tmp/openboard openboard
COPY --from=builder /src/build/openboard /usr/local/bin/openboard
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
