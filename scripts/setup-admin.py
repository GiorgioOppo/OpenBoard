#!/usr/bin/env python3
"""Create the first OpenBoard administrator before publishing its NPM proxy host."""
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def public_url():
    value = os.environ.get("OPENBOARD_PUBLIC_URL")
    if value is None:
        try:
            for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
                if line.startswith("OPENBOARD_PUBLIC_URL="):
                    value = line.split("=", 1)[1].strip().strip("\"'")
                    break
        except OSError:
            pass
    value = value or "http://openboard.localhost"
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("OPENBOARD_PUBLIC_URL non è un'origine http(s) valida.")
    return value, parsed.netloc


def api(method, path, payload=None):
    origin, authority = public_url()
    command = ["docker", "compose", "exec", "-T", "app", "curl", "--silent", "--show-error", "--max-time", "30",
               "--request", method, "--header", f"Host: {authority}", "--header", f"Origin: {origin}",
               "--header", "Content-Type: application/json", "--write-out", "\n%{http_code}"]
    if payload is not None:
        command += ["--data-binary", "@-"]
    command += ["http://127.0.0.1:8080" + path]
    result = subprocess.run(command, cwd=ROOT, input=None if payload is None else json.dumps(payload).encode(), capture_output=True, timeout=40)
    if result.returncode:
        raise RuntimeError("Connessione all'app non riuscita. Verifica docker compose ps e lo stato del servizio app.")
    try:
        body, status = result.stdout.rsplit(b"\n", 1)
        return int(status), json.loads(body)
    except (ValueError, UnicodeError):
        raise RuntimeError("Risposta inattesa dall'app. Nessun dato di sessione mostrato.") from None


def main():
    if not sys.stdin.isatty():
        print("Esegui questo script da un terminale interattivo: la password viene richiesta senza mostrarla.", file=sys.stderr)
        return 1
    try:
        status, session = api("GET", "/api/auth/session")
        if status != 200 or not session.get("enabled"):
            raise RuntimeError("L'app non è pronta con autenticazione attiva.")
        if not session.get("setup_required"):
            print("Amministratore già configurato. Nessun account modificato.")
            return 0
        name = input("Nome amministratore: ").strip()
        username = input("Username (3–64 caratteri ASCII): ").strip()
        password = getpass.getpass("Password nuova (12–256 byte): ")
        repeated = getpass.getpass("Ripeti password: ")
        if not name or len(name) > 100 or not re.fullmatch(r"[A-Za-z0-9_.-]{3,64}", username):
            raise ValueError("Nome o username non validi.")
        if password != repeated or not 12 <= len(password.encode("utf-8")) <= 256:
            raise ValueError("Le password devono coincidere e contenere da 12 a 256 byte.")
        status, body = api("POST", "/api/auth/setup", {"name": name, "username": username, "password": password})
        if status != 201:
            raise RuntimeError(body.get("error", "Creazione amministratore non riuscita."))
        print("Amministratore OpenBoard creato. Ora configura il Proxy Host in Nginx Proxy Manager e accedi con queste credenziali.")
        return 0
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("\nConfigurazione interrotta.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
