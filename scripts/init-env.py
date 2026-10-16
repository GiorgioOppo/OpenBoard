#!/usr/bin/env python3
"""Create a private Compose environment without shared or printed credentials."""
import argparse
import os
from pathlib import Path
import secrets
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def public_origin(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError
        if parsed.path or parsed.query or parsed.fragment or "\\" in value or any(c.isspace() or ord(c)<32 or ord(c)==127 for c in value):
            raise ValueError
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
        value.encode("ascii")
    except (ValueError, UnicodeError):
        raise argparse.ArgumentTypeError("Usa un'origine http(s) con dominio e porta opzionale, senza percorso o credenziali.") from None
    return value


def port(value):
    number = int(value)
    if not 1 <= number <= 65535:
        raise argparse.ArgumentTypeError("La porta deve essere compresa fra 1 e 65535.")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", type=Path, default=ROOT / ".env")
    parser.add_argument("--public-url", type=public_origin)
    parser.add_argument("--http-port", type=port, default=80)
    parser.add_argument("--https-port", type=port, default=443)
    parser.add_argument("--admin-port", type=port, default=81)
    parser.add_argument("--publish-ip", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1",
                        help="Bind proxy ports to loopback by default; use 0.0.0.0 for explicit network exposure.")
    args = parser.parse_args()
    if len({args.http_port, args.https_port, args.admin_port}) != 3:
        parser.error("Le tre porte pubblicate devono essere distinte.")
    if args.public_url is None:
        suffix = f":{args.http_port}" if args.http_port != 80 else ""
        args.public_url = f"http://openboard.localhost{suffix}"
    values = {name: secrets.token_hex(32) for name in (
        "POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "MONGO_ROOT_PASSWORD", "MONGO_APP_PASSWORD")}
    values.update(OPENBOARD_PUBLIC_URL=args.public_url, OPENBOARD_PUBLISH_IP=args.publish_ip, OPENBOARD_HTTP_PORT=str(args.http_port),
                  OPENBOARD_HTTPS_PORT=str(args.https_port), OPENBOARD_NPM_ADMIN_PORT=str(args.admin_port), TZ="Europe/Rome")
    contents = "# Private deployment credentials. Do not commit or print this file.\n" + "".join(f"{key}={value}\n" for key, value in values.items())
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(args.path, flags, 0o600)
    except FileExistsError:
        print(f"File già presente, lasciato invariato: {args.path}", file=sys.stderr)
        return 1
    except OSError:
        print("Impossibile creare il file ambiente nella destinazione indicata.", file=sys.stderr)
        return 1
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
    except OSError:
        args.path.unlink(missing_ok=True)
        print("Scrittura del file ambiente non riuscita.", file=sys.stderr)
        return 1
    print(f"Creato {args.path} con permessi 0600. Nessuna credenziale mostrata.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
