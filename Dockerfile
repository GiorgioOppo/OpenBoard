FROM debian:trixie-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libsqlite3-dev libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Makefile ./
COPY src/ src/
RUN make

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-0 libssl3t64 curl ca-certificates && rm -rf /var/lib/apt/lists/* && groupadd --system --gid 10001 openboard && useradd --system --uid 10001 --gid openboard --home-dir /var/lib/openboard openboard && mkdir -p /var/lib/openboard /opt/openboard/web && chown openboard:openboard /var/lib/openboard
COPY --from=builder /src/build/openboard /usr/local/bin/openboard
COPY web/ /opt/openboard/web/
USER 10001:10001
ENV OPENBOARD_DB=/var/lib/openboard/openboard.db OPENBOARD_WEB_ROOT=/opt/openboard/web OPENBOARD_AUTH=true OPENBOARD_NO_DEMO=true
VOLUME ["/var/lib/openboard"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD curl --fail --silent "http://127.0.0.1:${OPENBOARD_PORT:-8080}/api/ready" || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/openboard"]
