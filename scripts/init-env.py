#!/usr/bin/env python3
"""Create a private Compose environment without shared or printed credentials."""
import argparse
import importlib.util
import ipaddress
import os
from pathlib import Path
import secrets
import sys

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("openboard_deployment", Path(__file__).with_name("check-deployment.py"))
_deployment = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_deployment)


def public_origin(value):
    try:
        return _deployment.public_origin(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from None


def port(value):
    number = int(value)
    if not 1 <= number <= 65535:
        raise argparse.ArgumentTypeError("La porta deve essere compresa fra 1 e 65535.")
    return number


def proxy_network(subnet, address):
    try:
        network = ipaddress.IPv4Network(subnet)
        proxy = ipaddress.IPv4Address(address)
        private_ranges = (ipaddress.IPv4Network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
        if not any(network.subnet_of(private) for private in private_ranges) or network.prefixlen > 29:
            raise ValueError
        if proxy not in network or proxy in (network.network_address, network.network_address + 1, network.broadcast_address):
            raise ValueError
        if proxy in list(network.subnets(prefixlen_diff=1))[1]:
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError("Usa una subnet IPv4 privata /29 o più ampia e un IP proxy nella metà bassa, distinto da rete e gateway iniziale; la metà alta è riservata alle assegnazioni dinamiche.") from None
    return str(network), str(proxy)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", type=Path, default=ROOT / ".env")
    parser.add_argument("--public-url", type=public_origin)
    parser.add_argument("--http-port", type=port, default=80)
    parser.add_argument("--https-port", type=port, default=443)
    parser.add_argument("--admin-port", type=port, default=81)
    parser.add_argument("--frontend-subnet", default="172.30.240.0/24", help="Private Docker frontend subnet; select another range if it overlaps an existing network.")
    parser.add_argument("--proxy-ip", default="172.30.240.2", help="Fixed NPM IPv4 address trusted by the backend.")
    parser.add_argument("--publish-ip", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1",
                        help="Bind proxy ports to loopback by default; use 0.0.0.0 for explicit network exposure.")
    args = parser.parse_args()
    if len({args.http_port, args.https_port, args.admin_port}) != 3:
        parser.error("Le tre porte pubblicate devono essere distinte.")
    if args.public_url is None:
        suffix = f":{args.http_port}" if args.http_port != 80 else ""
        args.public_url = f"http://openboard.localhost{suffix}"
    try:
        _deployment.publication(args.public_url, args.publish_ip, args.http_port, args.https_port)
        args.frontend_subnet, args.proxy_ip = proxy_network(args.frontend_subnet, args.proxy_ip)
    except ValueError as error:
        parser.error(str(error))
    values = {name: secrets.token_hex(32) for name in (
        "POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "MONGO_ROOT_PASSWORD", "MONGO_APP_PASSWORD")}
    values.update(OPENBOARD_PUBLIC_URL=args.public_url, OPENBOARD_PUBLISH_IP=args.publish_ip, OPENBOARD_HTTP_PORT=str(args.http_port),
                  OPENBOARD_HTTPS_PORT=str(args.https_port), OPENBOARD_NPM_ADMIN_PORT=str(args.admin_port),
                  OPENBOARD_FRONTEND_SUBNET=args.frontend_subnet,
                  OPENBOARD_FRONTEND_IP_RANGE=str(list(ipaddress.IPv4Network(args.frontend_subnet).subnets(prefixlen_diff=1))[1]),
                  OPENBOARD_PROXY_IP=args.proxy_ip, TZ="Europe/Rome")
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
