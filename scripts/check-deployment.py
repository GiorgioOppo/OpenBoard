#!/usr/bin/env python3
"""Check deployment boundaries and local readiness without changing the stack.

Compose output may contain passwords. It is captured, parsed and never printed.
The probes only GET public endpoints over loopback and inspect local containers;
they do not log in, create accounts, request certificates or contact a remote host.
"""
import argparse
import fnmatch
import http.client
import ipaddress
import json
from pathlib import Path
import posixpath
import re
import socket
import ssl
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MAX_RESPONSE = 2 * 1024 * 1024


class DeploymentError(RuntimeError):
    """An actionable error whose text never includes command output or secrets."""


def local_host(host):
    host = host.lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def public_origin(value):
    """Return a strict origin; an HTTP origin must be local to the browser."""
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not value.startswith(parsed.scheme + "://") or not parsed.hostname or parsed.username or parsed.password or len(value) > 300:
            raise ValueError
        if parsed.path or "?" in value or "#" in value or "\\" in value or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError
        value.encode("ascii")
        # The current C origin validator accepts DNS names and IPv4, not IPv6.
        if ":" in parsed.hostname or not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                                            for label in parsed.hostname.rstrip(".").split(".")):
            raise ValueError
        if re.fullmatch(r"[0-9.]+", parsed.hostname):
            ipaddress.IPv4Address(parsed.hostname)
        # Reject ambiguous authorities, including an empty trailing port.
        expected_host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
        expected = expected_host + (f":{parsed.port}" if parsed.port is not None else "")
        if parsed.netloc.lower() != expected.lower():
            raise ValueError
    except (ValueError, UnicodeError, AttributeError):
        raise ValueError("L'origine deve essere http(s), senza percorso, credenziali o caratteri ambigui.") from None
    if parsed.scheme == "http" and not local_host(parsed.hostname):
        raise ValueError("HTTP è consentito solo per localhost, domini .localhost o indirizzi IP loopback; usa HTTPS per un dominio esterno.")
    return value


def publication(origin, publish_ip, http_port, https_port):
    parsed = urlsplit(public_origin(origin))
    if (parsed.port or (443 if parsed.scheme == "https" else 80)) != (https_port if parsed.scheme == "https" else http_port):
        raise ValueError("La porta dell'origine non coincide con la porta HTTP/HTTPS pubblicata.")
    try:
        private = ipaddress.ip_address(publish_ip).is_loopback
    except ValueError:
        private = False
    if not private and (parsed.scheme != "https" or local_host(parsed.hostname)):
        raise ValueError("La pubblicazione di rete richiede un'origine HTTPS con dominio o indirizzo esterno; mantieni loopback per le prove locali.")


def boolean(value):
    return value is True or isinstance(value, str) and value.lower() in ("1", "true", "yes")


def ports(service):
    result = {}
    for item in service.get("ports", []):
        if not isinstance(item, dict):
            raise DeploymentError("Formato porte Compose non riconosciuto; aggiorna Docker Compose.")
        try:
            target, published = int(item["target"]), int(item["published"])
            if target in result or not 1 <= published <= 65535 or item.get("protocol", "tcp") != "tcp":
                raise ValueError
            result[target] = (item.get("host_ip") or "0.0.0.0", published)
        except (KeyError, ValueError, TypeError):
            raise DeploymentError("Porte pubblicate mancanti, duplicate o non valide.") from None
    return result


def configuration(config):
    """Validate resolved Compose data, returning only public connection settings."""
    try:
        services = config["services"]
        app, npm = services["app"], services["npm"]
        try:
            origin = public_origin(app["environment"]["OPENBOARD_PUBLIC_URL"])
        except ValueError as error:
            raise DeploymentError(str(error)) from None
        npm_ports = ports(npm)
        if set(npm_ports) != {80, 81, 443}:
            raise DeploymentError("Il proxy deve pubblicare soltanto HTTP, HTTPS e la console amministrativa.")
        admin_ip, admin_port = npm_ports[81]
        if not ipaddress.ip_address(admin_ip).is_loopback:
            raise DeploymentError("La console NPM deve essere pubblicata soltanto su loopback.")
        for target in (80, 443):
            try:
                publication(origin, npm_ports[target][0], npm_ports[80][1], npm_ports[443][1])
            except ValueError as error:
                raise DeploymentError(str(error)) from None
        if not boolean(app["environment"].get("OPENBOARD_AUTH")) or not boolean(app["environment"].get("OPENBOARD_NO_DEMO")):
            raise DeploymentError("Il deployment richiede autenticazione attiva e dati dimostrativi disabilitati.")
        for name in ("app", "frontend", "postgres", "mongo"):
            if services[name].get("ports") or services[name].get("network_mode") == "host":
                raise DeploymentError("Backend, frontend e database non devono pubblicare porte direttamente.")
        if not config.get("networks", {}).get("backend", {}).get("internal"):
            raise DeploymentError("La rete dei database deve essere interna.")
        if npm.get("network_mode") == "host":
            raise DeploymentError("Il proxy non deve usare la rete host.")
        allocation = config["networks"]["frontend"]["ipam"]["config"][0]
        subnet = ipaddress.ip_network(allocation["subnet"])
        dynamic = ipaddress.ip_network(allocation["ip_range"])
        proxy_ip = ipaddress.ip_address(npm["networks"]["frontend"]["ipv4_address"])
        if proxy_ip.version != 4 or proxy_ip not in subnet or proxy_ip in (subnet.network_address, subnet.network_address + 1, subnet.broadcast_address):
            raise DeploymentError("L'indirizzo statico del proxy deve essere IPv4 e appartenere alla rete frontend.")
        if dynamic.version != 4 or not dynamic.subnet_of(subnet) or proxy_ip in dynamic:
            raise DeploymentError("Il pool dinamico frontend deve appartenere alla subnet ed escludere l'indirizzo statico del proxy.")
        if app["environment"].get("OPENBOARD_TRUSTED_PROXY") != str(proxy_ip):
            raise DeploymentError("L'indirizzo del proxy fidato nel backend deve corrispondere all'IPv4 statico di NPM.")
        return {"origin": origin, "authority": urlsplit(origin).netloc, "ports": npm_ports,
                "admin_port": admin_port, "https": urlsplit(origin).scheme == "https", "trusted_proxy": str(proxy_ip)}
    except DeploymentError:
        raise
    except (KeyError, IndexError, ValueError, TypeError, AttributeError):
        raise DeploymentError("Configurazione Compose incompleta o non riconosciuta.") from None


def json_response(status, body, label):
    if status != 200:
        raise DeploymentError(f"{label}: risposta HTTP inattesa; verifica origine e instradamento.")
    try:
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, UnicodeError):
        raise DeploymentError(f"{label}: risposta JSON non valida.") from None


def ready_auth(status, body, label):
    value = json_response(status, body, label)
    if value.get("enabled") is not True:
        raise DeploymentError(f"{label}: autenticazione disattivata.")
    if value.get("setup_required") is not False:
        raise DeploymentError(f"{label}: crea prima l'amministratore OpenBoard con scripts/setup-admin.py.")
    if value.get("user") is not None or value.get("csrf") not in (None, ""):
        raise DeploymentError(f"{label}: risposta anonima inattesa; verifica cache e cookie del proxy.")


def live_ports(settings, bindings):
    """Compare the running bindings, so a pending Compose edit cannot pass."""
    try:
        for name in ("app", "frontend", "postgres", "mongo"):
            if any(value for value in bindings[name].values()):
                raise DeploymentError("Un servizio interno attivo pubblica ancora porte; ricrea il deployment con la configurazione privata.")
        expected = {f"{target}/tcp": [{"HostIp": ip, "HostPort": str(port)}]
                    for target, (ip, port) in settings["ports"].items()}
        actual = {key: value for key, value in bindings["npm"].items() if value}
        if actual != expected:
            raise DeploymentError("Le porte del proxy attivo non corrispondono alla configurazione verificata; ricrea il proxy prima della pubblicazione.")
    except (KeyError, TypeError, AttributeError):
        raise DeploymentError("Impossibile verificare le porte dei container attivi.") from None


def nginx_tokens(source):
    """Lex nginx syntax, preserving quoted values and excluding comments."""
    result, index = [], 0
    while index < len(source):
        char = source[index]
        if char.isspace():
            index += 1
            continue
        if char == "#":
            end = source.find("\n", index)
            index = len(source) if end < 0 else end + 1
            continue
        if char in "{};":
            result.append(char)
            index += 1
            continue
        value, quote, quoted = [], None, False
        while index < len(source):
            char = source[index]
            if char == "\\" and index + 1 < len(source):
                value.append(source[index + 1])
                index += 2
                continue
            if quote:
                if char == quote:
                    quote = None
                else:
                    value.append(char)
                index += 1
                continue
            if char in "\"'":
                quote = char
                quoted = True
                index += 1
                continue
            if char.isspace() or char in "{};#":
                break
            value.append(char)
            index += 1
        if quote or not value and not quoted:
            raise DeploymentError("Configurazione Nginx non riconosciuta; impossibile verificare il virtual host.")
        result.append("".join(value))
    return result


def nginx_tree(tokens):
    index = 0
    def block(depth=0):
        nonlocal index
        if depth > 64:
            raise DeploymentError("Configurazione Nginx troppo annidata.")
        nodes = []
        while index < len(tokens):
            if tokens[index] == "}":
                if not depth:
                    raise DeploymentError("Configurazione Nginx non valida.")
                index += 1
                return nodes
            words = []
            while index < len(tokens) and tokens[index] not in (";", "{", "}"):
                words.append(tokens[index])
                index += 1
            if not words or index == len(tokens) or tokens[index] == "}":
                raise DeploymentError("Configurazione Nginx incompleta.")
            delimiter = tokens[index]
            index += 1
            nodes.append((tuple(words), block(depth + 1) if delimiter == "{" else None))
        if depth:
            raise DeploymentError("Configurazione Nginx incompleta.")
        return nodes
    return block()


def nginx_configuration(source):
    """Parse nginx -T, expanding only files that nginx actually reported loading."""
    chunks = re.split(r"(?m)^# configuration file ([^\n]+):\s*\n", source)
    files = {}
    for index in range(1, len(chunks), 2):
        name = posixpath.normpath(chunks[index])
        if name in files:
            raise DeploymentError("Inventario Nginx ambiguo.")
        files[name] = nginx_tree(nginx_tokens(chunks[index + 1]))
    root = "/etc/nginx/nginx.conf"
    if root not in files:
        raise DeploymentError("Nginx non ha fornito la configurazione principale prevista.")
    def expand(nodes, stack):
        result = []
        for words, children in nodes:
            if words[0] == "include" and children is None:
                if len(words) != 2:
                    raise DeploymentError("Direttiva include Nginx non riconosciuta.")
                pattern = words[1] if words[1].startswith("/") else "/etc/nginx/" + words[1]
                names = sorted(name for name in files if fnmatch.fnmatchcase(name, posixpath.normpath(pattern)))
                if not names and not any(char in pattern for char in "*?["):
                    raise DeploymentError("File incluso da Nginx assente dall'inventario.")
                for name in names:
                    if name in stack or len(stack) > 32:
                        raise DeploymentError("Inclusioni Nginx cicliche o troppo annidate.")
                    result += expand(files[name], stack + [name])
            else:
                result.append((words, expand(children, stack) if children is not None else None))
        return result
    return expand(files[root], [root])


def nginx_preflight(settings, source):
    """Require effective perimeter controls on the origin's API virtual host."""
    tree = nginx_configuration(source)
    host = urlsplit(settings["origin"]).hostname.lower().rstrip(".")
    servers, zones = [], {}
    def collect(nodes, parents=()):
        for words, children in nodes:
            if words[0] == "set_real_ip_from":
                raise DeploymentError("Nginx si fida ancora di indirizzi per gli header IP inoltrati; usa l'immagine proxy OpenBoard corretta.")
            if words[0] == "server" and children is not None:
                names = [value.lower().rstrip(".") for item, _ in children if item[0] == "server_name" for value in item[1:]]
                if host in names:
                    servers.append((children, parents + (nodes,)))
            if words[0] in ("limit_req_zone", "limit_conn_zone"):
                for value in words[1:]:
                    if value.startswith("zone="):
                        zones[value[5:].split(":")[0]] = words
            if children is not None:
                collect(children, parents + (nodes,))
    collect(tree)
    if not servers:
        raise DeploymentError("NPM non ha caricato un virtual host esatto per l'origine configurata.")
    required_zones = {"openboard_auth", "openboard_api_clients", "openboard_api_total"}
    if not required_zones <= zones.keys():
        raise DeploymentError("Nginx non ha caricato tutte le zone dei limiti OpenBoard.")
    for name in ("openboard_auth", "openboard_api_clients"):
        if zones[name][1] != "$binary_remote_addr":
            raise DeploymentError("I limiti per client devono usare l'indirizzo della connessione, senza header inoltrati.")
    if zones["openboard_api_total"][1] != "$server_name":
        raise DeploymentError("Il limite globale API deve essere condiviso dal virtual host OpenBoard.")
    if zones["openboard_auth"][0] != "limit_req_zone" or "rate=5r/m" not in zones["openboard_auth"]:
        raise DeploymentError("La zona di autenticazione deve limitare ogni client a cinque richieste al minuto.")
    target = "443" if settings["https"] else "80"
    selected = [(server, parents) for server, parents in servers if any(words[0] == "listen" and words[1].split(":")[-1] == target for words, _ in server)]
    if len(selected) != 1:
        raise DeploymentError("Il virtual host dell'origine deve avere un unico server Nginx per la porta prevista.")
    server, parents = selected[0]
    locations = [(words[1:], children) for words, children in server if words[0] == "location" and children is not None]
    api = [children for args, children in locations if args in (("^~", "/api/"), ("/api/",))]
    if len(api) != 1:
        raise DeploymentError("Il virtual host deve avere un unico blocco API OpenBoard riconoscibile.")
    permitted = {("^~", "/api/"), ("/api/",), *( ("=", "/api/auth/" + name) for name in ("login", "setup", "password") )}
    for args, children in locations:
        if args not in permitted and any(value.startswith("/api/") for value in args):
            raise DeploymentError("Una location API aggiuntiva può aggirare i limiti; usa i blocchi OpenBoard previsti.")
    if any(words[0] == "location" for words, _ in api[0]):
        raise DeploymentError("Location annidate nelle API non supportate dal controllo di sicurezza.")
    def effective(location, name):
        for scope in (location, server, *reversed(parents)):
            own = [words for words, children in scope if words[0] == name and children is None]
            if own:
                return own
        return []
    def api_controls(location):
        headers = effective(location, "proxy_set_header")
        for name, expected in (("Host", "$http_host"), ("X-Real-IP", "$remote_addr"), ("X-Forwarded-For", "$remote_addr")):
            values = [words[2:] for words in headers if len(words) > 2 and words[1].lower() == name.lower()]
            if values != [(expected,)]:
                raise DeploymentError("Gli upstream API devono conservare Host e sovrascrivere gli header IP con l'indirizzo della connessione.")
        conn = effective(location, "limit_conn")
        if not {("limit_conn", "openboard_api_clients", "8"), ("limit_conn", "openboard_api_total", "32")} <= set(conn):
            raise DeploymentError("Gli upstream API non applicano entrambi i limiti di connessione OpenBoard.")
        if effective(location, "limit_conn_status") != [("limit_conn_status", "429")]:
            raise DeploymentError("Il proxy deve rispondere 429 quando supera i limiti di connessione API.")
    api_controls(api[0])
    auth_routes = ("/api/auth/login", "/api/auth/setup", "/api/auth/password")
    for route in auth_routes:
        exact = [children for args, children in locations if args == ("=", route)]
        if len(exact) != 1:
            raise DeploymentError("Login e setup devono avere location esatte con limiti di autenticazione.")
        api_controls(exact[0])
        req = effective(exact[0], "limit_req")
        if not any("zone=openboard_auth" in words and "burst=10" in words and "nodelay" in words for words in req):
            raise DeploymentError("Login e setup non applicano il limite di autenticazione OpenBoard previsto.")
        if effective(exact[0], "limit_req_status") != [("limit_req_status", "429")]:
            raise DeploymentError("Il proxy deve rispondere 429 quando supera il limite di autenticazione.")


def readiness(settings, backend_get, proxy_get, npm_get, runtime_origin, bindings, nginx_source, diagnostics):
    """Only GET operations; injectable transports make the same checks testable."""
    live_ports(settings, bindings)
    if runtime_origin != settings["origin"]:
        raise DeploymentError("L'origine del backend attivo differisce da Compose; ricrea l'app prima della pubblicazione.")
    if not isinstance(diagnostics, dict) or diagnostics.get("trusted_proxy") != settings["trusted_proxy"] or diagnostics.get("auth_enabled") is not True:
        raise DeploymentError("Il backend installato non conferma autenticazione e proxy fidato; ricostruisci e ricrea l'app.")
    nginx_preflight(settings, nginx_source)
    if json_response(*backend_get("/api/ready"), "Storage backend").get("status") != "ready":
        raise DeploymentError("Lo storage del backend attivo non è pronto; verifica i database prima della pubblicazione.")
    ready_auth(*backend_get("/api/auth/session"), "Backend")
    npm = json_response(*npm_get("/api/"), "Console NPM")
    if npm.get("setup") is not True:
        raise DeploymentError("Completa il primo amministratore NPM sulla console loopback prima della pubblicazione.")
    status, body, headers = proxy_get("/", settings["https"])
    if status != 200 or "text/html" not in headers.get("content-type", "").lower() or b"OpenBoard" not in body:
        raise DeploymentError("Il proxy non serve il frontend previsto per l'origine configurata.")
    status, body, _ = proxy_get("/api/auth/session", settings["https"])
    ready_auth(status, body, "API attraverso il proxy")
    if settings["https"]:
        status, _, headers = proxy_get("/api/auth/session", False)
        expected = settings["origin"] + "/api/auth/session"
        if status not in (301, 308) or headers.get("location") != expected:
            raise DeploymentError("Il proxy deve forzare HTTP verso l'origine HTTPS esatta anche per le API.")


class Compose:
    def __init__(self, compose_file, env_file=None):
        self.command = ["docker", "compose", "--project-directory", str(ROOT), "--file", str(compose_file)]
        if env_file is not None:
            self.command += ["--env-file", str(env_file)]

    def run(self, arguments):
        try:
            result = subprocess.run(self.command + arguments, cwd=ROOT, capture_output=True, timeout=40)
            if result.returncode or len(result.stdout) > MAX_RESPONSE:
                raise DeploymentError("Verifica Docker Compose non riuscita; controlla disponibilità, file ambiente e stato dei servizi. Nessun output privato mostrato.")
            return result.stdout
        except (OSError, subprocess.SubprocessError):
            raise DeploymentError("Docker Compose non disponibile o richiesta locale scaduta.") from None

    def json(self, arguments):
        try:
            return json.loads(self.run(arguments))
        except (ValueError, UnicodeError):
            raise DeploymentError("Risposta Docker Compose non valida.") from None

    def backend_get(self, authority, path):
        raw = self.run(["exec", "-T", "app", "curl", "--silent", "--show-error", "--max-time", "15",
                        "--header", "Host: " + authority, "--write-out", "\n%{http_code}", "http://127.0.0.1:8080" + path])
        try:
            body, status = raw.rsplit(b"\n", 1)
            return int(status), body
        except ValueError:
            raise DeploymentError("Risposta locale del backend non valida.") from None

    def diagnostics(self):
        # This child process checks transport/auth configuration and the cache
        # read-only. Maintenance diagnostics do not support external storage;
        # its live readiness is checked separately through GET /api/ready.
        # Only these two child environment variables are removed. The running
        # application's environment and every other setting remain untouched.
        return self.json(["exec", "-T", "app", "env", "-u", "OPENBOARD_POSTGRES_URL",
                          "-u", "OPENBOARD_MONGODB_URI", "/usr/local/bin/openboard", "--diagnostics"])

    def running_ports(self):
        bindings = {}
        for name in ("app", "frontend", "postgres", "mongo", "npm"):
            identifier = self.run(["ps", "--quiet", name]).strip().decode("ascii")
            if not identifier or "\n" in identifier:
                raise DeploymentError("Un servizio richiesto non è attivo o ha più repliche non supportate dal controllo.")
            try:
                result = subprocess.run(["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", identifier],
                                        cwd=ROOT, capture_output=True, timeout=20)
                if result.returncode or len(result.stdout) > MAX_RESPONSE:
                    raise ValueError
                value = json.loads(result.stdout)
                if not isinstance(value, dict):
                    raise ValueError
                bindings[name] = value
            except (OSError, subprocess.SubprocessError, ValueError, UnicodeError):
                raise DeploymentError("Impossibile leggere i binding dei container attivi.") from None
        return bindings


def loopback_get(port, path, authority, tls_host=None):
    """Connect only to this host. TLS still verifies the public hostname and CA."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        if tls_host is not None:
            stream = socket.create_connection(("127.0.0.1", port), timeout=15)
            try:
                connection.sock = ssl.create_default_context().wrap_socket(stream, server_hostname=tls_host)
            except BaseException:
                stream.close()
                raise
        connection.request("GET", path, headers={"Host": authority, "Connection": "close"})
        response = connection.getresponse()
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE:
            raise DeploymentError("Risposta locale troppo grande.")
        return response.status, body, {key.lower(): value for key, value in response.getheaders()}
    except ssl.SSLError:
        raise DeploymentError("TLS non valido: verifica certificato, dominio, scadenza e catena attendibile del proxy.") from None
    except (OSError, http.client.HTTPException):
        raise DeploymentError("Il proxy locale non è raggiungibile o ha restituito una risposta incompleta.") from None
    finally:
        connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose-file", type=Path, default=ROOT / "compose.yaml")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--config-only", action="store_true", help="Check resolved configuration only; does not establish running readiness.")
    args = parser.parse_args(argv)
    try:
        compose = Compose(args.compose_file, args.env_file)
        settings = configuration(compose.json(["config", "--format", "json"]))
        if args.config_only:
            print("Configurazione privata/TLS coerente. Readiness dei servizi attivi non verificata (--config-only).")
            return 0
        origin = compose.run(["exec", "-T", "app", "printenv", "OPENBOARD_PUBLIC_URL"]).decode("ascii").strip()
        parsed = urlsplit(settings["origin"])
        def proxy_get(path, tls):
            return loopback_get(settings["ports"][443 if tls else 80][1], path, settings["authority"], parsed.hostname if tls else None)
        def npm_get(path):
            status, body, _ = loopback_get(settings["admin_port"], path, "127.0.0.1")
            return status, body
        readiness(settings, lambda path: compose.backend_get(settings["authority"], path), proxy_get,
                  npm_get, origin, compose.running_ports(), compose.run(["exec", "-T", "npm", "nginx", "-T"]).decode("utf-8"),
                  compose.diagnostics())
        print("Configurazione e readiness locale verificate: amministratori configurati, porte private e origine/proxy coerenti" +
              (", TLS valido e redirect HTTPS attivo." if settings["https"] else ". HTTP consentito soltanto per uso locale."))
        print("Questo controllo non sostituisce la scansione delle immagini e la verifica dei limiti di traffico.")
        return 0
    except (DeploymentError, UnicodeError) as error:
        print(str(error) if isinstance(error, DeploymentError) else "Configurazione runtime non valida.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
