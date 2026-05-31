#!/usr/bin/env python3
"""Parse one uploaded artifact and emit {source, text} JSON on stdout.

Invoked by the relay's POST /parse route (run with cwd=client/ so the
`parsers.*` imports resolve). Routes by extension to the existing parsers and
returns the relay provenance `source` so the gateway can Tier-0 route it.
"""

import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: parse_file.py <path>"}))
        sys.exit(1)

    path = sys.argv[1]
    ext = Path(path).suffix.lower()
    source = None

    try:
        if ext in (".pcap", ".pcapng"):
            from parsers.pcap import parse
            chunks = parse(path)
            source = "pcap"
        elif ext == ".evtx":
            from parsers.logs import parse
            chunks = parse(path, "windows")
            source = "evtx"
        elif ext in (".conf", ".cfg"):
            from parsers.switch import from_file
            chunks = from_file(path)
            source = "switch"
        else:
            # Generic text/log (.log, .txt, .csv, .out, ...) — linux text path.
            from parsers.logs import parse
            chunks = parse(path, "linux")
            source = None  # let the classifier read the content; logs vary too much

        text = "\n".join(chunks)
        print(json.dumps({"source": source, "text": text}))
    except Exception as e:  # noqa: BLE001 — surface any parser error to the caller
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
