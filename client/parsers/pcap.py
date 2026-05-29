"""Parse PCAP files into a summarized text representation for LLM analysis."""

from pathlib import Path
from collections import defaultdict, Counter


def parse(file_path: str) -> list[str]:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"PCAP file not found: {file_path}")

    try:
        return _parse_with_scapy(path)
    except ImportError:
        raise ImportError("scapy is required: pip install scapy")


def _parse_with_scapy(path: Path) -> list[str]:
    from scapy.all import rdpcap, IP, TCP, UDP, ICMP, DNS, DNSQR

    packets = rdpcap(str(path))
    total = len(packets)

    flows: dict[tuple, dict] = defaultdict(lambda: {"packets": 0, "bytes": 0})
    dns_queries: list[str] = []
    port_scan_candidates: Counter = Counter()
    icmp_counts: Counter = Counter()
    protocol_counts: Counter = Counter()

    for pkt in packets:
        if not pkt.haslayer(IP):
            continue

        src = pkt[IP].src
        dst = pkt[IP].dst
        size = len(pkt)

        if pkt.haslayer(TCP):
            sport, dport = pkt[TCP].sport, pkt[TCP].dport
            proto = "TCP"
            port_scan_candidates[(src, dst)] += 1
        elif pkt.haslayer(UDP):
            sport, dport = pkt[UDP].sport, pkt[UDP].dport
            proto = "UDP"
        elif pkt.haslayer(ICMP):
            sport, dport = 0, 0
            proto = "ICMP"
            icmp_counts[src] += 1
        else:
            continue

        protocol_counts[proto] += 1
        key = (src, dst, sport, dport, proto)
        flows[key]["packets"] += 1
        flows[key]["bytes"] += size

        if pkt.haslayer(DNS) and pkt.haslayer(DNSQR):
            try:
                qname = pkt[DNSQR].qname.decode(errors="replace").rstrip(".")
                dns_queries.append(f"{src} → {qname}")
            except Exception:
                pass

    # Top flows by bytes
    top_flows = sorted(flows.items(), key=lambda x: x[1]["bytes"], reverse=True)[:50]
    flow_lines = []
    for (src, dst, sport, dport, proto), stats in top_flows:
        flow_lines.append(
            f"{proto} {src}:{sport} → {dst}:{dport} | "
            f"pkts={stats['packets']} bytes={stats['bytes']}"
        )

    # Potential port scanners — many unique dst ports from one src
    dst_ports_per_src: dict[str, set] = defaultdict(set)
    for (src, dst, sport, dport, proto), _ in flows.items():
        if proto == "TCP":
            dst_ports_per_src[src].add(dport)
    scanners = [(src, len(ports)) for src, ports in dst_ports_per_src.items() if len(ports) > 20]
    scanners.sort(key=lambda x: -x[1])

    # DNS unique queries (top 30)
    unique_dns = list(dict.fromkeys(dns_queries))[:30]

    summary = f"""=== PCAP SUMMARY ===
Total packets: {total}
Total flows: {len(flows)}
Protocols: {dict(protocol_counts)}

=== TOP 50 FLOWS (by bytes) ===
{chr(10).join(flow_lines) or "(none)"}

=== POTENTIAL PORT SCANNERS (>20 unique dst ports) ===
{chr(10).join(f"{src}: {n} ports" for src, n in scanners) or "(none detected)"}

=== ICMP TOP SOURCES ===
{chr(10).join(f"{src}: {n} packets" for src, n in icmp_counts.most_common(10)) or "(none)"}

=== DNS QUERIES (sample) ===
{chr(10).join(unique_dns) or "(none captured)"}
"""

    # Single chunk — summary is already compact
    return [summary]
