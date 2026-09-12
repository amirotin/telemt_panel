"""Exercise a release container without host services, secrets or Docker socket mounts."""
import argparse
import http.cookiejar
import json
import pathlib
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--image", required=True)
parser.add_argument("--platform", required=True)
parser.add_argument("--version", required=True)
args = parser.parse_args()
name = "telemt-container-test-" + uuid.uuid4().hex[:12]
volume = name + "-data"

def docker(*command, **kwargs):
    return subprocess.check_output(["docker", *command], text=True, **kwargs).strip()

def request(opener, url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"})
    return opener.open(req, timeout=10)

with tempfile.TemporaryDirectory(prefix="telemt-container-smoke-") as temporary:
    root = pathlib.Path(temporary)
    config_dir = root / "config"
    config_dir.mkdir()
    config = config_dir / "config.toml"
    config.write_text('''listen = "0.0.0.0:8080"
base_path = "/admin-test"
data_dir = "/var/lib/telemt-panel"
[telemt]
url = "http://127.0.0.1:1"
[auth]
username = "operator"
password_hash = "$2a$10$B3SjWRaNJIFXbjlVwXjbh.btIkjJi5qtMzwyKYC1pHl7aXehfcv1K"
[store]
driver = "sqlite"
path = "/var/lib/telemt-panel/panel.db"
[host]
service_manager = "none"
[privileges]
mode = "manual"
[subpage]
enabled = true
listen = "0.0.0.0:8081"
base_path = "/clients-test"
secret = "container-fixture-signing-secret"
''')
    config.chmod(0o600)
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    try:
        version = docker("run", "--rm", "--platform", args.platform, args.image, "version")
        assert version.startswith("telemt-panel " + args.version + " (full:"), version
        assert "sqlite" in version, version
        docker("run", "--rm", "--platform", args.platform, "--entrypoint", "/bin/sh", args.image,
               "-c", "test -s /etc/ssl/certs/ca-certificates.crt")
        docker("volume", "create", volume)
        for iteration in range(2):
            docker("run", "-d", "--name", name, "--platform", args.platform,
                   "--read-only", "--tmpfs", "/tmp", "--security-opt", "no-new-privileges:true",
                   "--mount", f"type=bind,src={config_dir},dst=/etc/telemt-panel",
                   "--mount", f"type=volume,src={volume},dst=/var/lib/telemt-panel",
                   "-p", "127.0.0.1::8080", "-p", "127.0.0.1::8081", args.image)
            address = docker("port", name, "8080/tcp").splitlines()[0]
            public = docker("port", name, "8081/tcp").splitlines()[0]
            url = "http://" + address + "/admin-test"
            for _ in range(60):
                try:
                    with request(opener, url + "/api/health") as response:
                        assert json.load(response)["version"] == args.version
                    break
                except OSError:
                    time.sleep(0.5)
            else:
                raise AssertionError("container never became healthy")
            with request(opener, url + "/login") as response:
                assert b'<html' in response.read().lower()
            if iteration == 0:
                with request(opener, url + "/api/auth/login", {"username": "operator", "password": "s3cr3t-password"}) as response:
                    assert response.status == 204
                assert list(jar), "no session cookie"
            # The second container has only the previous volume and config.
            with request(opener, url + "/api/auth/me") as response:
                assert response.status == 200
            for bad in ["http://" + address + "/api/health", "http://" + public + "/api/health", "http://" + public + "/login"]:
                try:
                    with request(opener, bad) as response:
                        raise AssertionError(f"unexpected route: {bad}: {response.status}")
                except urllib.error.HTTPError as error:
                    assert error.code == 404
            docker("stop", "--time", "15", name)
            snapshot = root / f"snapshot-{iteration}"
            docker("cp", name + ":/var/lib/telemt-panel", str(snapshot))
            assert (snapshot / "panel-state.json").is_file()
            with sqlite3.connect(snapshot / "panel.db") as db:
                assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                assert db.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0] > 0
            docker("rm", name)
        print(json.dumps({"platform": args.platform, "version": args.version, "sqlite": "ok", "session_survives_recreation": True, "isolated_subscription_port": True}))
    except Exception:
        subprocess.run(["docker", "logs", "--tail", "30", name], check=False)
        raise
    finally:
        # Targets are unique fixtures created above; never touch user containers/volumes.
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
