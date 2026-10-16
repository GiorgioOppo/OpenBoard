#!/usr/bin/env python3
"""Local bootstrap refuses unknown installations and preserves existing objects."""
import contextlib
import copy
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("openboard_bootstrap_local", ROOT/"scripts/bootstrap-local.py")
bootstrap_local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap_local)


class FakeStack:
    def __init__(self):
        self.npm_setup = False
        self.app_setup = False
        self.calls = []
        self.hosts = []
        self.npm_secret = None
        self.app_secret = None

    def npm(self, method, path, payload=None, token=None):
        self.calls.append(("npm", method, path))
        if method == "GET" and path == "/api/":
            return 200, {"setup":self.npm_setup,"version":{"major":2,"minor":16,"revision":0}}
        if method == "POST" and path == "/api/users":
            assert self.app_setup, "OpenBoard must be configured before publishing a proxy"
            self.npm_setup = True
            self.npm_secret = payload["auth"]["secret"]
            return 201, {"id":1}
        if method == "POST" and path == "/api/tokens":
            return (200, {"token":"PRIVATE_TOKEN_NOT_PERSISTED"}) if payload["secret"] == self.npm_secret else (401,{})
        assert token == "PRIVATE_TOKEN_NOT_PERSISTED"
        if method == "GET" and path == "/api/nginx/proxy-hosts":
            return 200, copy.deepcopy(self.hosts)
        if method == "POST" and path == "/api/nginx/proxy-hosts":
            assert self.app_setup
            host = {**copy.deepcopy(payload), "id":len(self.hosts)+1}
            self.hosts.append(host)
            return 201, {**host,"meta":{"nginx_online":True}}
        if method == "PUT" and path.startswith("/api/nginx/proxy-hosts/"):
            identifier = int(path.rsplit("/",1)[1])
            for index, host in enumerate(self.hosts):
                if host["id"] == identifier:
                    updated = {**copy.deepcopy(payload), "id":identifier}
                    self.hosts[index] = updated
                    return 200, {**updated,"meta":{"nginx_online":True}}
            return 404, {}
        raise AssertionError((method,path))

    def app(self, method, path, payload=None):
        self.calls.append(("app",method,path))
        if method == "GET" and path == "/api/auth/session":
            return 200,{"enabled":True,"setup_required":not self.app_setup}
        if method == "POST" and path == "/api/auth/setup":
            self.app_setup = True
            self.app_secret = payload["password"]
            return 201,{"user":{"id":1,"role":"admin"}}
        if method == "POST" and path == "/api/auth/login":
            return (200,{"user":{"id":1,"role":"admin"}}) if payload["password"] == self.app_secret else (401,{})
        raise AssertionError((method,path))


class LocalBootstrap(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openboard-bootstrap-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/".env.local-admin"
        self.stack = FakeStack()

    def test_fresh_stack_private_credentials_and_safe_rerun(self):
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            values = bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.assertEqual(capture.getvalue(),"")
        self.assertEqual(self.path.stat().st_mode&0o777,0o600)
        self.assertNotEqual(values["NPM_ADMIN_PASSWORD"],values["OPENBOARD_ADMIN_PASSWORD"])
        self.assertEqual(len(values["NPM_ADMIN_PASSWORD"]),64)
        original = self.path.read_bytes()
        self.assertNotIn(b"PRIVATE_TOKEN_NOT_PERSISTED",original)
        self.stack.calls.clear()
        bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.assertEqual(self.path.read_bytes(),original)
        self.assertEqual(len(self.stack.hosts),1)
        self.assertNotIn(("npm","POST","/api/users"),self.stack.calls)
        self.assertNotIn(("app","POST","/api/auth/setup"),self.stack.calls)
        self.assertNotIn(("npm","POST","/api/nginx/proxy-hosts"),self.stack.calls)

    def test_unknown_existing_installation_fails_before_writes(self):
        self.stack.npm_setup = True
        with self.assertRaises(bootstrap_local.BootstrapError):
            bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.assertFalse(self.path.exists())
        self.assertTrue(all(method=="GET" for _,method,_ in self.stack.calls))

    def test_conflicting_host_is_preserved(self):
        bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.stack.hosts[0]["forward_host"] = "existing-service"
        original = copy.deepcopy(self.stack.hosts)
        self.stack.calls.clear()
        with self.assertRaises(bootstrap_local.BootstrapError):
            bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.assertEqual(self.stack.hosts,original)
        self.assertFalse(any(method in ("PUT","DELETE") for _,method,_ in self.stack.calls))
        self.assertNotIn(("npm","POST","/api/nginx/proxy-hosts"),self.stack.calls)

    def test_bad_permissions_and_unknown_password_are_not_reset(self):
        bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.path.chmod(0o644)
        self.stack.calls.clear()
        with self.assertRaises(bootstrap_local.BootstrapError):
            bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.assertTrue(all(method=="GET" for _,method,_ in self.stack.calls))
        self.path.chmod(0o600)
        self.stack.npm_secret = "changed-by-owner"
        self.stack.calls.clear()
        with self.assertRaises(bootstrap_local.BootstrapError):
            bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.assertNotIn(("npm","POST","/api/users"),self.stack.calls)
        self.assertNotIn(("app","POST","/api/auth/setup"),self.stack.calls)

    def test_legacy_proxy_upgrade_is_explicit_and_preserves_id_accounts_and_secrets(self):
        bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        original_credentials = self.path.read_bytes()
        self.stack.hosts[0] = {**bootstrap_local.proxy_configuration(legacy=True), "id":7}
        legacy = copy.deepcopy(self.stack.hosts)
        self.stack.calls.clear()
        with self.assertRaises(bootstrap_local.BootstrapError):
            bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.assertEqual(self.stack.hosts, legacy)
        self.assertFalse(any(method == "PUT" for _,method,_ in self.stack.calls))
        self.stack.calls.clear()
        bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path,upgrade_proxy=True)
        self.assertEqual(self.path.read_bytes(), original_credentials)
        self.assertEqual(self.stack.hosts, [{**bootstrap_local.proxy_configuration(), "id":7}])
        self.assertEqual([call for call in self.stack.calls if call[1] == "PUT"], [("npm","PUT","/api/nginx/proxy-hosts/7")])
        self.assertNotIn(("npm","POST","/api/users"),self.stack.calls)
        self.assertNotIn(("app","POST","/api/auth/setup"),self.stack.calls)
        self.assertNotIn(("npm","POST","/api/nginx/proxy-hosts"),self.stack.calls)
        self.stack.calls.clear()
        bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path,upgrade_proxy=True)
        self.assertFalse(any(method == "PUT" for _,method,_ in self.stack.calls))

    def test_upgrade_refuses_modified_legacy_hosts_and_ambiguous_ids(self):
        bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        original_credentials = self.path.read_bytes()
        variations = ({"forward_host":"other-service"}, {"ssl_forced":True},
                      {"advanced_config":bootstrap_local.LEGACY_API_LOCATION+"\n# custom"},
                      {"locations":[{"path":"/private"}]}, {"id":None}, {"id":True})
        for change in variations:
            with self.subTest(change=change):
                self.stack.hosts = [{**bootstrap_local.proxy_configuration(legacy=True), "id":7, **change}]
                original = copy.deepcopy(self.stack.hosts)
                self.stack.calls.clear()
                with self.assertRaises(bootstrap_local.BootstrapError):
                    bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path,upgrade_proxy=True)
                self.assertEqual(self.stack.hosts, original)
                self.assertEqual(self.path.read_bytes(), original_credentials)
                self.assertFalse(any(method in ("PUT","DELETE") for _,method,_ in self.stack.calls))

    def test_upgrade_requires_confirmed_response_from_npm(self):
        bootstrap_local.bootstrap(self.stack.npm,self.stack.app,self.path)
        self.stack.hosts = [{**bootstrap_local.proxy_configuration(legacy=True), "id":7}]
        original = copy.deepcopy(self.stack.hosts)
        def unavailable(method, path, payload=None, token=None):
            if method == "PUT":
                return 500, {"error":"private response that must not be printed"}
            return self.stack.npm(method,path,payload,token)
        with self.assertRaises(bootstrap_local.BootstrapError) as error:
            bootstrap_local.bootstrap(unavailable,self.stack.app,self.path,upgrade_proxy=True)
        self.assertNotIn("private response", str(error.exception))
        self.assertEqual(self.stack.hosts, original)

    def test_proxy_network_parameters_reject_gateway_and_outside_addresses(self):
        spec = importlib.util.spec_from_file_location("init_environment", ROOT/"scripts/init-env.py")
        init = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(init)
        self.assertEqual(init.proxy_network("172.30.240.0/24","172.30.240.2"), ("172.30.240.0/24","172.30.240.2"))
        self.assertEqual(init.proxy_network("10.80.0.0/24","10.80.0.7"), ("10.80.0.0/24","10.80.0.7"))
        for subnet, proxy in (("172.30.240.0/24","172.30.241.2"), ("172.30.240.0/24","172.30.240.1"),
                              ("172.30.240.0/24","172.30.240.0"), ("172.30.240.0/24","172.30.240.255"),
                              ("172.30.240.0/24","172.30.240.128"), ("172.30.240.0/24","172.30.240.200"),
                              ("172.30.240.0/31","172.30.240.2"), ("192.0.2.0/24","192.0.2.2"),
                              ("172.30.240.2/24","172.30.240.3"), ("::1/128","::1")):
            with self.subTest(subnet=subnet,proxy=proxy):
                with self.assertRaises(ValueError):
                    init.proxy_network(subnet,proxy)

    def test_remote_origins_and_wrong_ports_are_rejected(self):
        env=Path(self.temp.name)/".env"
        for origin in ("http://example.com","https://openboard.localhost","http://openboard.localhost/path","http://user:secret@openboard.localhost","http://openboard.localhost:8088"):
            env.write_text("OPENBOARD_PUBLIC_URL="+origin+"\nOPENBOARD_HTTP_PORT=80\n")
            with self.assertRaises(bootstrap_local.BootstrapError):
                bootstrap_local.settings(Path(self.temp.name),{})
        env.write_text("OPENBOARD_PUBLIC_URL=http://openboard.localhost:8088\nOPENBOARD_HTTP_PORT=8088\nOPENBOARD_NPM_ADMIN_PORT=8181\n")
        self.assertEqual(bootstrap_local.settings(Path(self.temp.name),{}),("http://openboard.localhost:8088","openboard.localhost:8088",8088,8181))

if __name__=="__main__":unittest.main()
