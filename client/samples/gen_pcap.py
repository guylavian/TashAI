"""Generate a realistic suspicious PCAP for testing."""
from scapy.all import (
    IP, TCP, UDP, ICMP, DNS, DNSQR, DNSRR,
    Raw, wrpcap, Ether
)

pkts = []

def tcp(src, dst, sport, dport, payload=b""):
    return (
        IP(src=src, dst=dst) /
        TCP(sport=sport, dport=dport, flags="PA") /
        Raw(load=payload)
    )

def udp(src, dst, sport, dport, payload=b""):
    return IP(src=src, dst=dst) / UDP(sport=sport, dport=dport) / Raw(load=payload)

# Normal web traffic
for i in range(40):
    pkts.append(tcp("10.0.1.5", "93.184.216.34", 50000 + i, 80, b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"))
    pkts.append(tcp("93.184.216.34", "10.0.1.5", 80, 50000 + i, b"HTTP/1.1 200 OK\r\n\r\n"))

# Port scan from attacker (185.220.101.42 scanning 10.0.1.10)
for port in [21, 22, 23, 25, 80, 135, 139, 443, 445, 1433, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 9200, 27017, 50070]:
    pkts.append(IP(src="185.220.101.42", dst="10.0.1.10") / TCP(sport=49000, dport=port, flags="S"))

# SSH brute-force (attacker → server)
for i in range(25):
    pkts.append(tcp("185.220.101.42", "10.0.1.10", 49900 + i, 22, b"SSH-2.0-OpenSSH_7.4\r\n"))

# Large data exfil (internal host → external)
for i in range(20):
    pkts.append(tcp("10.0.1.10", "185.220.101.99", 4444, 4444, b"A" * 1400))

# Suspicious DNS queries
dns_domains = [
    "xn--e1afmkfd.xn--80akhbyknj4f.com",   # punycode / IDN homograph
    "aabbccdd1122.duckdns.org",              # DGA-like
    "update.totallylegit.xyz",
    "185-220-101-99.sslip.io",
]
for domain in dns_domains:
    pkts.append(
        IP(src="10.0.1.10", dst="8.8.8.8") /
        UDP(sport=54321, dport=53) /
        DNS(rd=1, qd=DNSQR(qname=domain))
    )

# Normal internal traffic
for i in range(30):
    pkts.append(tcp("10.0.1.5", "10.0.1.20", 60000 + i, 5432, b"SELECT 1"))

# ICMP sweep
for i in range(20):
    pkts.append(IP(src="185.220.101.42", dst=f"10.0.1.{i+1}") / ICMP())

wrpcap("samples/suspicious.pcap", pkts)
print(f"Written {len(pkts)} packets to samples/suspicious.pcap")
