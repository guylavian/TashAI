"""Parse Windows (.evtx) and Linux (plain text) log files into text chunks."""

from pathlib import Path

CHUNK_LINES = 300  # lines per LLM call


def parse(file_path: str, os_type: str) -> list[str]:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Log file not found: {file_path}")

    suffix = path.suffix.lower()
    if suffix == ".evtx" or os_type == "windows":
        return _parse_evtx(path)
    else:
        return _parse_text(path)


def _parse_text(path: Path) -> list[str]:
    lines = path.read_text(errors="replace").splitlines()
    # Filter blank lines
    lines = [l for l in lines if l.strip()]
    return _chunk(lines)


def _parse_evtx(path: Path) -> list[str]:
    try:
        from Evtx.Evtx import Evtx
        import xml.etree.ElementTree as ET

        records: list[str] = []
        with Evtx(str(path)) as log:
            for record in log.records():
                try:
                    root = ET.fromstring(record.xml())
                    ns = {"e": "http://schemas.microsoft.com/win/2004/08/events/event"}
                    sys_el = root.find("e:System", ns)
                    if sys_el is None:
                        continue

                    def txt(tag: str) -> str:
                        el = sys_el.find(f"e:{tag}", ns)
                        return el.text.strip() if el is not None and el.text else ""

                    event_data = root.find("e:EventData", ns)
                    data_parts = []
                    if event_data is not None:
                        for data in event_data.findall("e:Data", ns):
                            name = data.get("Name", "")
                            val = data.text or ""
                            if val.strip():
                                data_parts.append(f"{name}={val.strip()}")

                    line = (
                        f"[{txt('TimeCreated')}] "
                        f"EventID={txt('EventID')} "
                        f"Level={txt('Level')} "
                        f"Channel={txt('Channel')} "
                        f"Computer={txt('Computer')} "
                        + (" | " + " ".join(data_parts) if data_parts else "")
                    )
                    records.append(line)
                except Exception:
                    continue
        return _chunk(records)
    except ImportError:
        raise ImportError("python-evtx is required for .evtx files: pip install python-evtx")


def _chunk(lines: list[str]) -> list[str]:
    chunks = []
    for i in range(0, len(lines), CHUNK_LINES):
        chunks.append("\n".join(lines[i : i + CHUNK_LINES]))
    return chunks or ["(empty log file)"]
