#!/usr/bin/env python3
"""Loopback development frontend with an opaque, same-origin API relay.

Production uses the static frontend container and Nginx Proxy Manager routing.
This helper contains no database connections, credentials, or API business rules.
"""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import socketserver
import threading
from urllib.parse import urlsplit

BODY_LIMIT = 2 * 1024 * 1024
UPSTREAM_TIMEOUT = 10
ASSETS = {'/': ('index.html', 'text/html; charset=utf-8'),
          '/index.html': ('index.html', 'text/html; charset=utf-8'),
          '/i18n.js': ('i18n.js', 'application/javascript; charset=utf-8'),
          '/locales.js': ('locales.js', 'application/javascript; charset=utf-8'),
          '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
          '/planning.js': ('planning.js', 'application/javascript; charset=utf-8'),
          '/enterprise.js': ('enterprise.js', 'application/javascript; charset=utf-8'),
          '/enterprise.css': ('enterprise.css', 'text/css; charset=utf-8'),
          '/workflows.js': ('workflows.js', 'application/javascript; charset=utf-8'),
          '/workflows.css': ('workflows.css', 'text/css; charset=utf-8'),
          '/productivity.js': ('productivity.js', 'application/javascript; charset=utf-8'),
          '/importers.js': ('importers.js', 'application/javascript; charset=utf-8'),
          '/conflicts.js': ('conflicts.js', 'application/javascript; charset=utf-8'),
          '/timeline.js': ('timeline.js', 'application/javascript; charset=utf-8'),
          '/styles.css': ('styles.css', 'text/css; charset=utf-8'),
          '/favicon.svg': ('favicon.svg', 'image/svg+xml')}
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
               'te', 'trailer', 'transfer-encoding', 'upgrade'}


def port_number(value):
    number = int(value)
    if not 1 <= number <= 65535:
        raise argparse.ArgumentTypeError('La porta deve essere tra 1 e 65535.')
    return number


def backend_address(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port or 8080
        valid = (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'
                 and not parsed.username and not parsed.password
                 and parsed.path in ('', '/') and not parsed.query and not parsed.fragment
                 and 1 <= port <= 65535)
    except ValueError:
        valid = False
    if not valid:
        raise argparse.ArgumentTypeError('Il backend deve essere http://127.0.0.1:PORTA.')
    return ('127.0.0.1', port)


class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer normally reverse-resolves the bind address with getfqdn().
        # This loopback-only helper has no use for DNS or a canonical hostname.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


class Frontend(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'OpenBoardDevFrontend'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(UPSTREAM_TIMEOUT)

    def log_message(self, *_):
        pass  # Do not log request queries, cookies, or payloads.

    def respond(self, status, body=b'', content_type='application/json; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', CSP)
        self.end_headers()
        self.close_connection = True
        if self.command != 'HEAD':
            self.wfile.write(body)

    def handle_expect_100(self):
        self.respond(417, b'{"error":"Expect non supportato."}')
        return False

    def dispatch(self):
        if not self.path.startswith('/'):
            self.respond(400, b'{"error":"Percorso non valido."}')
            return
        path = urlsplit(self.path).path
        if path == '/api' or path.startswith('/api/'):
            self.proxy_api()
            return
        if self.command not in ('GET', 'HEAD'):
            self.respond(405, b'{"error":"Metodo non consentito."}')
            return
        if path == '/health':
            self.respond(200, b'ok\n', 'text/plain; charset=utf-8')
            return
        asset = ASSETS.get(path)
        if not asset:
            self.respond(404, b'{"error":"File non trovato."}')
            return
        try:
            data = (self.server.web_root / asset[0]).read_bytes()
        except OSError:
            self.respond(404, b'{"error":"File non trovato."}')
            return
        self.respond(200, data, asset[1])

    def proxy_api(self):
        lengths = self.headers.get_all('Content-Length') or []
        if self.headers.get_all('Transfer-Encoding') or len(lengths) > 1:
            self.respond(400, b'{"error":"Framing della richiesta non valido."}')
            return
        try:
            if lengths and (not lengths[0].isascii() or not lengths[0].isdigit()):
                raise ValueError()
            length = int(lengths[0]) if lengths else 0
            if length > BODY_LIMIT:
                self.respond(413, b'{"error":"Richiesta oltre 2 MiB."}')
                return
            body = self.rfile.read(length) if length else None
            if body is not None and len(body) != length:
                self.respond(400, b'{"error":"Corpo incompleto."}')
                return
        except (ValueError, OSError):
            self.respond(400, b'{"error":"Corpo della richiesta non valido."}')
            return
        upstream = http.client.HTTPConnection(*self.server.backend, timeout=UPSTREAM_TIMEOUT)
        started = False
        deadline_socket = [None]

        def stop_upstream():
            connection = deadline_socket[0] or upstream.sock
            if connection:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                connection.close()

        timer = threading.Timer(UPSTREAM_TIMEOUT, stop_upstream)
        timer.daemon = True
        timer.start()
        try:
            connection_tokens = {part.strip().lower() for part in self.headers.get('Connection', '').split(',')}
            blocked = HOP_HEADERS | connection_tokens
            upstream.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            for name, value in self.headers.raw_items():
                if name.lower() not in blocked:
                    upstream.putheader(name, value)
            upstream.putheader('Connection', 'close')
            upstream.endheaders(body)
            if upstream.sock:
                deadline_socket[0] = upstream.sock.dup()
            response = upstream.getresponse()
            self.send_response(response.status, response.reason)
            response_blocked = HOP_HEADERS | {part.strip().lower() for part in response.getheader('Connection', '').split(',')}
            for name, value in response.getheaders():
                if name.lower() not in response_blocked:
                    self.send_header(name, value)  # Preserve all Set-Cookie headers.
            self.send_header('Connection', 'close')
            self.end_headers()
            started = True
            self.close_connection = True
            if self.command != 'HEAD':
                while True:
                    chunk = response.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (OSError, http.client.HTTPException):
            if not started:
                self.respond(502, b'{"error":"API locale non disponibile."}')
            self.close_connection = True
        finally:
            timer.cancel()
            upstream.close()
            if deadline_socket[0]:
                deadline_socket[0].close()

    do_GET = dispatch
    do_HEAD = dispatch
    do_POST = dispatch
    do_PATCH = dispatch
    do_DELETE = dispatch
    do_PUT = dispatch
    do_OPTIONS = dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=port_number, default=8090)
    parser.add_argument('--backend', type=backend_address, default=('127.0.0.1', 8080))
    parser.add_argument('--web-root', type=Path, default=Path(__file__).resolve().parents[1]/'web')
    arguments = parser.parse_args()
    root = arguments.web_root.resolve()
    if not (root/'index.html').is_file():
        parser.error('La cartella frontend deve contenere index.html.')
    server = LoopbackServer(('127.0.0.1', arguments.port), Frontend)
    server.daemon_threads = True
    server.backend = arguments.backend
    server.web_root = root
    print(f'Frontend locale: http://127.0.0.1:{arguments.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
