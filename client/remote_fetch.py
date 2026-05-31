#!/usr/bin/env python3
"""Fetch a log/command output from a remote host over SSH or WinRM.

Config arrives as JSON on STDIN (never argv) so credentials never appear in the
process list. Emits {"text": ...} or {"error": ...} on stdout.

  {"protocol":"ssh","host":"10.0.0.5","port":22,"username":"ops",
   "password":"...", "key_path":"/path/id_rsa", "key_text":"-----BEGIN...",
   "command":"tail -n 500 /var/log/auth.log"}
"""

import json
import sys


def fetch_ssh(cfg: dict) -> str:
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    password = cfg.get("password") or None
    key_text = cfg.get("key_text") or None
    key_path = cfg.get("key_path") or None

    kwargs: dict = {
        "hostname": cfg["host"],
        "port": int(cfg.get("port") or 22),
        "username": cfg["username"],
        "timeout": 15,
        "banner_timeout": 15,
        "auth_timeout": 15,
    }

    pkey = None
    if key_text:
        from io import StringIO
        for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
            try:
                pkey = key_cls.from_private_key(StringIO(key_text), password=password)
                break
            except Exception:
                continue

    if pkey is not None:
        kwargs["pkey"] = pkey
    elif key_path:
        kwargs["key_filename"] = key_path
        if password:
            kwargs["passphrase"] = password
    else:
        kwargs["password"] = password
        kwargs["look_for_keys"] = False
        kwargs["allow_agent"] = False

    client.connect(**kwargs)
    try:
        _stdin, stdout, stderr = client.exec_command(cfg["command"], timeout=60)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
    finally:
        client.close()

    return out if out.strip() else (err or "(no output)")


def fetch_winrm(cfg: dict) -> str:
    import winrm

    port = int(cfg.get("port") or 5985)
    scheme = "https" if port == 5986 else "http"
    session = winrm.Session(
        f"{scheme}://{cfg['host']}:{port}/wsman",
        auth=(cfg["username"], cfg.get("password") or ""),
        transport="ntlm",
        server_cert_validation="ignore",
    )
    result = session.run_ps(cfg["command"])
    out = result.std_out.decode("utf-8", "replace")
    err = result.std_err.decode("utf-8", "replace")
    return out if out.strip() else (err or "(no output)")


def main() -> None:
    try:
        cfg = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"bad config: {e}"}))
        sys.exit(1)

    try:
        proto = cfg.get("protocol", "ssh")
        text = fetch_ssh(cfg) if proto == "ssh" else fetch_winrm(cfg)
        print(json.dumps({"text": text}))
    except ImportError as e:
        dep = "paramiko" if cfg.get("protocol") != "winrm" else "pywinrm requests-ntlm"
        print(json.dumps({"error": f"missing dependency ({e}). Install: pip install {dep}"}))
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 — surface connection/auth/command errors
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
