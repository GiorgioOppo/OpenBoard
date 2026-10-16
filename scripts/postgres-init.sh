#!/bin/sh
# The official entrypoint executes this only for a newly initialized volume.
set -eu
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  <<'SQL'
\getenv app_password POSTGRES_APP_PASSWORD
CREATE ROLE openboard LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE openboard TO openboard;
GRANT USAGE, CREATE ON SCHEMA public TO openboard;
SQL
