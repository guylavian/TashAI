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
    # Split at top-level section boundaries (non-indented lines start a new section).
    # This prevents cutting an interface or policy-map block in the middle.
    sections: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if line and not line[0].isspace() and current:
            sections.append("\n".join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        sections.append("\n".join(current))

    # Pack sections into chunks up to CHUNK_CHARS
    chunks: list[str] = []
    buf: list[str] = []
    buf_len = 0
    for section in sections:
        if buf and buf_len + len(section) > CHUNK_CHARS:
            chunks.append("\n".join(buf))
            buf = [section]
            buf_len = len(section)
        else:
            buf.append(section)
            buf_len += len(section)
    if buf:
        chunks.append("\n".join(buf))

    return chunks or ["(empty config)"]
