#!/usr/bin/env python3
"""Initialize a fresh local stack and its proxy without displaying credentials."""
import http.client
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
CREDENTIAL_KEYS = ("OPENBOARD_ADMIN_USERNAME", "OPENBOARD_ADMIN_PASSWORD", "NPM_ADMIN_EMAIL", "NPM_ADMIN_PASSWORD")
API_LOCATION = """location ^~ /api/ {
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $openboard_api app:8080;
    client_max_body_size 2m;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://$openboard_api;
}
"""


class BootstrapError(RuntimeError):
    pass


def settings(root=ROOT, environ=None):
    environ = os.environ if environ is None else environ
    values = {}
    try:
        for line in (root / ".env").read_text(encoding="utf-8").splitlines():
            if line.startswith(("OPENBOARD_PUBLIC_URL=", "OPENBOARD_HTTP_PORT=", "OPENBOARD_NPM_ADMIN_PORT=")):
                key, value = line.split("=", 1)
                values[key] = value.strip().strip("\"'")
    except OSError:
        raise BootstrapError("File .env assente: esegui prima scripts/init-env.py.") from None
    for key in ("OPENBOARD_PUBLIC_URL", "OPENBOARD_HTTP_PORT", "OPENBOARD_NPM_ADMIN_PORT"):
        if key in environ:
            values[key] = environ[key]
    origin = values.get("OPENBOARD_PUBLIC_URL", "http://openboard.localhost")
    try:
        url = urlsplit(origin)
        public_port = int(values.get("OPENBOARD_HTTP_PORT", "80"))
        admin_port = int(values.get("OPENBOARD_NPM_ADMIN_PORT", "81"))
        if url.scheme != "http" or url.hostname != "openboard.localhost" or url.username or url.password or url.path or url.query or url.fragment:
            raise ValueError
        if not 1 <= public_port <= 65535 or not 1 <= admin_port <= 65535 or (url.port or 80) != public_port:
            raise ValueError
    except ValueError:
        raise BootstrapError("Bootstrap limitato all'origine http://openboard.localhost[:porta] e alla console NPM su loopback.") from None
    return origin, url.netloc, public_port, admin_port


def credentials(path, existing_setup):
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        if existing_setup:
            raise BootstrapError("Istanza già configurata senza credenziali locali note. Nessun account modificato; usa la configurazione manuale.") from None
        values = {"OPENBOARD_ADMIN_USERNAME": "admin", "OPENBOARD_ADMIN_PASSWORD": secrets.token_hex(32),
                  "NPM_ADMIN_EMAIL": "admin@openboard.localhost", "NPM_ADMIN_PASSWORD": secrets.token_hex(32)}
        contents = "# Private local administrator credentials. Do not commit or print.\n" + "".join(f"{key}={values[key]}\n" for key in CREDENTIAL_KEYS)
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(contents)
                output.flush()
                os.fsync(output.fileno())
        except OSError:
            raise BootstrapError("Creazione atomica del file credenziali non riuscita. Nessun account creato.") from None
        return values
    except OSError:
        raise BootstrapError("Impossibile leggere il file credenziali locale in modo sicuro.") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise BootstrapError("Il file credenziali deve essere regolare, appartenere all'utente corrente e avere permessi 0600.")
        with os.fdopen(descriptor, "r", encoding="utf-8") as source:
            descriptor = -1
            lines = source.read(4097)
        if len(lines) > 4096:
            raise BootstrapError("File credenziali locale non valido.")
        values = {}
        for line in lines.splitlines():
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or key not in CREDENTIAL_KEYS or key in values:
                raise BootstrapError("File credenziali locale non valido.")
            values[key] = value
        if set(values) != set(CREDENTIAL_KEYS) or values["OPENBOARD_ADMIN_USERNAME"] != "admin" or values["NPM_ADMIN_EMAIL"] != "admin@openboard.localhost":
            raise BootstrapError("File credenziali locale non valido.")
        for key in ("OPENBOARD_ADMIN_PASSWORD", "NPM_ADMIN_PASSWORD"):
            if len(values[key]) != 64 or any(c not in "0123456789abcdef" for c in values[key]):
                raise BootstrapError("File credenziali locale non valido.")
        return values
    except (OSError, UnicodeError):
        raise BootstrapError("File credenziali locale non leggibile.") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def loopback_request(port, method, path, payload=None, token=None, authority=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if authority:
        headers["Host"] = authority
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        connection.request(method, path, None if payload is None else json.dumps(payload).encode(), headers)
        response = connection.getresponse()
        body = response.read(2097153)
        if len(body) > 2097152:
            raise BootstrapError("Risposta locale troppo grande.")
        return response.status, body, dict(response.getheaders())
    except (OSError, http.client.HTTPException):
        raise BootstrapError("Servizio locale non raggiungibile. Verifica docker compose ps.") from None
    finally:
        connection.close()


def npm_transport(port):
    def request(method, path, payload=None, token=None):
        status, body, _ = loopback_request(port, method, path, payload, token)
        try:
            return status, json.loads(body)
        except (ValueError, UnicodeError):
            raise BootstrapError("Risposta NPM locale non valida.") from None
    return request


def app_transport(origin, authority):
    def request(method, path, payload=None):
        command = ["docker", "compose", "exec", "-T", "app", "curl", "--silent", "--show-error", "--max-time", "30",
                   "--request", method, "--header", "Content-Type: application/json", "--header", "Host: " + authority,
                   "--header", "Origin: " + origin, "--write-out", "\n%{http_code}"]
        if payload is not None:
            command += ["--data-binary", "@-"]
        command += ["http://127.0.0.1:8080" + path]
        try:
            result = subprocess.run(command, cwd=ROOT, input=None if payload is None else json.dumps(payload).encode(), capture_output=True, timeout=40)
            if result.returncode:
                raise BootstrapError("Backend locale non raggiungibile. Verifica lo stato del servizio app.")
            body, status = result.stdout.rsplit(b"\n", 1)
            return int(status), json.loads(body)
        except (OSError, subprocess.SubprocessError, ValueError, UnicodeError):
            raise BootstrapError("Risposta del backend locale non valida.") from None
    return request


def require(status, expected, label):
    if status != expected:
        raise BootstrapError(f"{label} non riuscito (HTTP {status}); nessuna credenziale mostrata.")


def proxy_configuration():
    return {"domain_names": ["openboard.localhost"], "forward_scheme": "http", "forward_host": "frontend", "forward_port": 8080,
            "certificate_id": 0, "ssl_forced": False, "hsts_enabled": False, "hsts_subdomains": False, "http2_support": False,
            "block_exploits": False, "caching_enabled": False, "allow_websocket_upgrade": False, "access_list_id": 0,
            "advanced_config": API_LOCATION, "enabled": True, "locations": [], "meta": {}}


def bootstrap(npm, app, credential_path):
    status, health = npm("GET", "/api/")
    require(status, 200, "Verifica NPM")
    if not isinstance(health, dict) or not isinstance(health.get("setup"), bool) or health.get("version") != {"major": 2, "minor": 16, "revision": 0}:
        raise BootstrapError("Il bootstrap richiede NPM 2.16.0 con API di setup riconosciuta.")
    status, session = app("GET", "/api/auth/session")
    require(status, 200, "Verifica autenticazione OpenBoard")
    if not isinstance(session, dict) or session.get("enabled") is not True or not isinstance(session.get("setup_required"), bool):
        raise BootstrapError("Backend pronto con autenticazione attiva richiesto.")
    values = credentials(credential_path, health["setup"] or not session["setup_required"])
    token = None
    if health["setup"]:
        status, login = npm("POST", "/api/tokens", {"identity": values["NPM_ADMIN_EMAIL"], "secret": values["NPM_ADMIN_PASSWORD"]})
        require(status, 200, "Accesso all'amministratore NPM locale noto")
        token = login.get("token") if isinstance(login, dict) else None
        if not isinstance(token, str) or not token:
            raise BootstrapError("Token NPM locale non valido.")
    if not session["setup_required"]:
        status, login = app("POST", "/api/auth/login", {"username": values["OPENBOARD_ADMIN_USERNAME"], "password": values["OPENBOARD_ADMIN_PASSWORD"]})
        require(status, 200, "Accesso all'amministratore OpenBoard locale noto")
        if not isinstance(login, dict) or login.get("user", {}).get("role") != "admin":
            raise BootstrapError("L'account OpenBoard locale noto deve essere amministratore.")
    else:
        status, created = app("POST", "/api/auth/setup", {"name": "Amministratore OpenBoard", "username": values["OPENBOARD_ADMIN_USERNAME"], "password": values["OPENBOARD_ADMIN_PASSWORD"]})
        require(status, 201, "Primo setup OpenBoard")
        if not isinstance(created, dict) or created.get("user", {}).get("role") != "admin":
            raise BootstrapError("Il primo setup OpenBoard non ha confermato l'amministratore.")
    status, session = app("GET", "/api/auth/session")
    require(status, 200, "Conferma setup OpenBoard")
    if session.get("setup_required") is not False or session.get("enabled") is not True:
        raise BootstrapError("Setup OpenBoard incompleto: il proxy non viene pubblicato.")
    if not health["setup"]:
        status, _ = npm("POST", "/api/users", {"name": "Amministratore NPM locale", "nickname": "Admin", "email": values["NPM_ADMIN_EMAIL"], "roles": ["admin"], "auth": {"type": "password", "secret": values["NPM_ADMIN_PASSWORD"]}})
        require(status, 201, "Primo setup NPM")
        status, login = npm("POST", "/api/tokens", {"identity": values["NPM_ADMIN_EMAIL"], "secret": values["NPM_ADMIN_PASSWORD"]})
        require(status, 200, "Accesso NPM locale")
        token = login.get("token") if isinstance(login, dict) else None
        if not isinstance(token, str) or not token:
            raise BootstrapError("Token NPM locale non valido.")
    status, hosts = npm("GET", "/api/nginx/proxy-hosts", token=token)
    require(status, 200, "Verifica proxy locali")
    if not isinstance(hosts, list):
        raise BootstrapError("Elenco proxy NPM non valido.")
    matching = [host for host in hosts if isinstance(host, dict) and "openboard.localhost" in host.get("domain_names", [])]
    expected = proxy_configuration()
    if matching:
        if len(matching) != 1 or any(matching[0].get(key) != value for key, value in expected.items() if key != "meta"):
            raise BootstrapError("Proxy openboard.localhost già presente con configurazione diversa. Nessun host modificato.")
    else:
        status, host = npm("POST", "/api/nginx/proxy-hosts", expected, token=token)
        require(status, 201, "Creazione proxy locale")
        if not isinstance(host, dict) or host.get("meta", {}).get("nginx_online") is False:
            raise BootstrapError("Proxy creato ma Nginx non ne ha confermato la configurazione. Verifica NPM.")
    return values


def main():
    try:
        origin, authority, public_port, admin_port = settings()
        path = ROOT / ".env.local-admin"
        bootstrap(npm_transport(admin_port), app_transport(origin, authority), path)
        for attempt in range(10):
            status, body, headers = loopback_request(public_port, "GET", "/", authority=authority)
            api_status, api_body, _ = loopback_request(public_port, "GET", "/api/auth/session", authority=authority)
            if status == 200 and b"OpenBoard" in body and api_status == 200:
                session = json.loads(api_body)
                if session.get("enabled") is True and session.get("setup_required") is False:
                    break
            if attempt == 9:
                raise BootstrapError("Proxy configurato, ma la verifica frontend/API non è riuscita.")
            time.sleep(0.5)
        print(f"Bootstrap locale completato. OpenBoard: {origin}")
        print(f"Console NPM: http://127.0.0.1:{admin_port}")
        print(f"Credenziali private: {path} (0600). Nessuna password mostrata.")
        return 0
    except (BootstrapError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
