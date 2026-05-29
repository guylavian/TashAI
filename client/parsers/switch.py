"""Pull running config from a network switch/router via SSH using netmiko."""

from pathlib import Path


SUPPORTED_VENDORS = [
    "cisco_ios",
    "cisco_nxos",
    "cisco_xr",
    "juniper_junos",
    "arista_eos",
    "hp_comware",
    "huawei",
    "mikrotik_routeros",
    "linux",  # for config file fallback
]

CHUNK_CHARS = 8000  # chars per LLM call


def from_device(host: str, vendor: str, username: str, password: str, port: int = 22) -> list[str]:
    try:
        from netmiko import ConnectHandler
    except ImportError:
        raise ImportError("netmiko is required: pip install netmiko")

    if vendor not in SUPPORTED_VENDORS:
        raise ValueError(f"Unsupported vendor: {vendor}. Choose from: {', '.join(SUPPORTED_VENDORS)}")

    device = {
        "device_type": vendor,
        "host": host,
        "username": username,
        "password": password,
        "port": port,
    }

    with ConnectHandler(**device) as conn:
        config = conn.send_command("show running-config")

    return _chunk(f"# Device: {host} ({vendor})\n\n{config}")


def from_file(file_path: str) -> list[str]:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {file_path}")
    content = path.read_text(errors="replace")
    return _chunk(f"# Config file: {path.name}\n\n{content}")


def _chunk(text: str) -> list[str]:
    chunks = []
    for i in range(0, len(text), CHUNK_CHARS):
        chunks.append(text[i : i + CHUNK_CHARS])
    return chunks or ["(empty config)"]
