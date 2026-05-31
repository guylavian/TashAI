"""Parse PCAP files into infrastructure diagnostics for NOC/network engineering.

Extracts Layer 3-4 health signals:
  - TCP retransmissions (packet loss)
  - TCP Zero Window (server-side backpressure / overload)
  - Incomplete TCP handshakes (firewall drops, unreachable hosts)
  - RST storms (firewall policy hits, port unreachable)
  - DNS latency (slow AD/BIND resolution)
  - ICMP Destination Unreachable / TTL Exceeded (routing issues, loops)
  - Top talkers and flow summary
"""

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

    # ── Per-flow tracking ──────────────────────────────────────────────────────
    flow_bytes:   dict[tuple, int] = defaultdict(int)
    flow_packets: dict[tuple, int] = defaultdict(int)

    # TCP health tracking — one counter per concern (no overloading)
    seen_seqs: dict[tuple, set] = defaultdict(set)  # data seqs per flow → retrans detection
    retrans:   Counter          = Counter()          # "src:sport→dst:dport" -> count
    zero_win:  Counter          = Counter()          # "dst:dport"           -> count
    rst:       Counter          = Counter()          # "src:sport→dst:dport" -> count

    # Handshake tracking: server-side flow -> SYN timestamp
    syn_pending:   dict[tuple, float] = {}
    incomplete_hs: list[tuple]        = []  # (client, server, service_port, wait_s)

    # DNS latency: txid -> {src, server, query, ts}
    dns_pending:   dict[int, dict] = {}
    dns_latencies: list[dict]      = []  # {query, server, client, latency_ms}

    # ICMP issues
    icmp_issues:     list[str] = []
    protocol_counts: Counter   = Counter()

    for pkt in packets:
        if not pkt.haslayer(IP):
            continue

        src = pkt[IP].src
        dst = pkt[IP].dst
        ts  = float(pkt.time)

        # ── TCP ───────────────────────────────────────────────────────────────
        if pkt.haslayer(TCP):
            tcp   = pkt[TCP]
            sport = tcp.sport
            dport = tcp.dport
            flags = str(tcp.flags)
            seq   = tcp.seq
            win   = tcp.window
            flow  = (src, dst, sport, dport)
            rflow = (dst, src, dport, sport)
            payload_len = len(tcp.payload)

            protocol_counts["TCP"] += 1
            flow_bytes[flow]   += len(pkt)
            flow_packets[flow] += 1

            # Retransmission: a *data-bearing* segment whose seq we've already
            # seen on this flow. ACK-only segments keep the same seq, so we must
            # gate on payload_len > 0 to avoid counting every ACK as a retrans.
            if payload_len > 0:
                if seq in seen_seqs[flow]:
                    retrans[f"{src}:{sport}→{dst}:{dport}"] += 1
                else:
                    seen_seqs[flow].add(seq)

            # Zero Window (server telling client to stop sending)
            if win == 0 and "R" not in flags and "F" not in flags:
                zero_win[f"{dst}:{dport}"] += 1

            # RST
            if "R" in flags:
                rst[f"{src}:{sport}→{dst}:{dport}"] += 1

            # Handshake tracking
            if "S" in flags and "A" not in flags:
                syn_pending[rflow] = ts
            elif "S" in flags and "A" in flags:
                syn_pending.pop(flow, None)
                syn_pending.pop(rflow, None)

        # ── UDP / DNS ─────────────────────────────────────────────────────────
        elif pkt.haslayer(UDP):
            protocol_counts["UDP"] += 1
            sport = pkt[UDP].sport
            dport = pkt[UDP].dport
            flow_bytes[(src, dst, sport, dport)]   += len(pkt)
            flow_packets[(src, dst, sport, dport)] += 1

            if pkt.haslayer(DNS):
                dns  = pkt[DNS]
                txid = dns.id
                if dns.qr == 0 and pkt.haslayer(DNSQR):
                    try:
                        qname = pkt[DNSQR].qname.decode(errors="replace").rstrip(".")
                    except Exception:
                        qname = "?"
                    dns_pending[txid] = {"src": src, "server": dst, "query": qname, "ts": ts}
                elif dns.qr == 1 and txid in dns_pending:
                    q = dns_pending.pop(txid)
                    latency_ms = (ts - q["ts"]) * 1000
                    dns_latencies.append({
                        "query":      q["query"],
                        "server":     q["server"],
                        "client":     q["src"],
                        "latency_ms": round(latency_ms, 2),
                    })

        # ── ICMP ──────────────────────────────────────────────────────────────
        elif pkt.haslayer(ICMP):
            protocol_counts["ICMP"] += 1
            itype = pkt[ICMP].type
            icode = pkt[ICMP].code
            if itype == 3:
                reasons = {
                    0: "Network Unreachable",    1: "Host Unreachable",
                    3: "Port Unreachable",        9: "Network Admin Prohibited",
                    10: "Host Admin Prohibited", 13: "Comm Admin Prohibited",
                }
                reason = reasons.get(icode, f"Unreachable code={icode}")
                icmp_issues.append(f"ICMP Destination Unreachable ({reason}): {src} → {dst}")
            elif itype == 11:
                icmp_issues.append(f"ICMP TTL Exceeded (routing loop?): {src} → {dst}")
            elif itype == 5:
                icmp_issues.append(f"ICMP Redirect (suboptimal routing): {src} → {dst}")

    # ── Post-loop: flag unfinished handshakes ──────────────────────────────────
    last_ts = float(packets[-1].time) if total else 0.0
    for flow, syn_ts in list(syn_pending.items()):
        server, client, service_port, _ = flow
        wait = last_ts - syn_ts
        if wait > 0.1:
            incomplete_hs.append((client, server, service_port, round(wait, 2)))

    # ── Top flows by bytes ─────────────────────────────────────────────────────
    top_flows = sorted(flow_bytes.items(), key=lambda x: -x[1])[:20]

    # ── DNS summary ────────────────────────────────────────────────────────────
    slow_dns = sorted(dns_latencies, key=lambda x: -x["latency_ms"])
    avg_dns  = (sum(d["latency_ms"] for d in dns_latencies) / len(dns_latencies)) if dns_latencies else 0

    # ── Format output ──────────────────────────────────────────────────────────
    lines: list[str] = []

    lines.append("=== PCAP INFRASTRUCTURE DIAGNOSTICS ===")
    lines.append(f"Total packets: {total}  |  Protocols: {dict(protocol_counts)}")
    lines.append("")

    lines.append("=== TOP 20 FLOWS (by bytes) ===")
    for (s, d, sp, dp), b in top_flows:
        pkts = flow_packets[(s, d, sp, dp)]
        lines.append(f"  {s}:{sp} → {d}:{dp}  {b} bytes  {pkts} pkts")
    lines.append("")

    lines.append("=== TCP HEALTH ===")
    if retrans:
        lines.append(f"Retransmissions detected on {len(retrans)} flows:")
        for flow, count in retrans.most_common(10):
            lines.append(f"  {flow}  ×{count}")
    else:
        lines.append("  No retransmissions detected.")

    if zero_win:
        lines.append(f"TCP Zero Window (server overload) — {len(zero_win)} endpoints:")
        for ep, count in zero_win.most_common(10):
            lines.append(f"  {ep}  ×{count}")
    else:
        lines.append("  No Zero Window events.")

    if rst:
        lines.append("RST events (firewall hits / port unreachable):")
        for flow, count in rst.most_common(10):
            lines.append(f"  {flow}  ×{count}")
    else:
        lines.append("  No RST storms.")

    if incomplete_hs:
        lines.append(f"Incomplete TCP handshakes (firewall drop candidates) — {len(incomplete_hs)} flows:")
        for (client, server, dport, wait) in incomplete_hs[:10]:
            lines.append(f"  {client} → {server}:{dport}  SYN unanswered for {wait}s")
    else:
        lines.append("  All observed handshakes completed.")
    lines.append("")

    lines.append("=== DNS LATENCY ===")
    if dns_latencies:
        lines.append(f"Queries: {len(dns_latencies)}  |  Avg latency: {avg_dns:.1f}ms")
        lines.append("Slowest queries:")
        for d in slow_dns[:10]:
            flag = "  ⚠ SLOW" if d["latency_ms"] > 200 else ""
            lines.append(f"  {d['query']}  via {d['server']}  {d['latency_ms']}ms{flag}")
    else:
        lines.append("  No DNS transactions captured.")
    lines.append("")

    lines.append("=== ICMP / ROUTING ISSUES ===")
    if icmp_issues:
        for issue in icmp_issues[:20]:
            lines.append(f"  {issue}")
    else:
        lines.append("  No ICMP routing issues detected.")

    return ["\n".join(lines)]
