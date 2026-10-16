#!/usr/bin/env python3
"""Apply narrowly checked defensive changes to the pinned NPM 2.16.0 base."""
from pathlib import Path
import re
import shutil


def once(source, old, new, label):
    if source.count(old) != 1:
        raise RuntimeError(f'Unexpected upstream {label}; refusing an unchecked patch')
    return source.replace(old, new, 1)


def harden(root=Path('/'), module=None):
    app = root/'app/app.js'
    source = app.read_text()
    source = once(source, 'const app = express();',
                  'const app = express();\napp.use(createAuthRateLimiter());', 'Express initialization')
    source = once(source, 'app.enable("trust proxy", ["loopback", "linklocal", "uniquelocal"]);',
                  'app.set("trust proxy", "loopback");', 'proxy trust')
    source = 'import createAuthRateLimiter from "./lib/express/openboard-auth-rate-limit.mjs";\n'+source

    nginx = root/'etc/nginx/nginx.conf'
    configuration = nginx.read_text()
    start, end = '\t# Real IP Determination', '\t# Custom\n\tinclude /data/nginx/custom/http_top[.]conf;'
    if configuration.count(start) != 1 or configuration.count(end) != 1:
        raise RuntimeError('Unexpected upstream real-IP configuration')
    first, last = configuration.index(start), configuration.index(end)
    if first >= last:
        raise RuntimeError('Unexpected upstream real-IP configuration order')
    configuration = configuration[:first]+'\t# Client identity is the TCP peer; forwarded headers are untrusted.\n\treal_ip_recursive off;\n\n'+configuration[last:]
    configuration = once(configuration, end,
                         '\t# OpenBoard security limits are part of the image.\n\tinclude /etc/nginx/openboard-http.conf;\n\n'+end,
                         'HTTP security include')
    configuration = once(configuration, 'client_max_body_size          2000m;',
                         'client_max_body_size          2m;', 'request body limit')
    configuration = once(configuration, '$proxy_add_x_forwarded_for;', '$remote_addr;', 'global forwarding')
    for header, variable in (('proto','proto'), ('scheme','scheme')):
        pattern = rf'map \$http_x_forwarded_{header} \$x_forwarded_{variable} \{{[^}}]*\}}'
        configuration, changed = re.subn(pattern, f'map $http_x_forwarded_{header} $x_forwarded_{variable} {{\n\t\tdefault $scheme;\n\t}}', configuration)
        if changed != 1:
            raise RuntimeError('Unexpected upstream forwarded scheme map')
    if re.search(r'^\s*set_real_ip_from\b',configuration,re.M):
        raise RuntimeError('Upstream still trusts a client-supplied IP header')
    proxy = root/'etc/nginx/conf.d/include/proxy.conf'
    forwarding = once(proxy.read_text(), '$proxy_add_x_forwarded_for;', '$remote_addr;', 'proxy forwarding')
    # Validate all inputs before changing the image filesystem.
    target = root/'app/lib/express/openboard-auth-rate-limit.mjs'
    module = module or Path(__file__).with_name('auth-rate-limit.mjs')
    shutil.copyfile(module,target)
    app.write_text(source)
    nginx.write_text(configuration)
    proxy.write_text(forwarding)


if __name__ == '__main__':
    harden()
