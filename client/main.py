#!/usr/bin/env python3
"""LLM Relay POC client — analyze logs, PCAPs, and switch configs."""

import json
import sys
from datetime import datetime
from pathlib import Path

import click
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn

console = Console()


def _save(output: str, results: list[dict], label: str) -> None:
    if not output:
        return
    data = {
        "label": label,
        "timestamp": datetime.utcnow().isoformat(),
        "results": results,
    }
    Path(output).write_text(json.dumps(data, indent=2))
    console.print(f"\n[dim]Results saved → {output}[/dim]")


def _print_results(results: list[dict], title: str) -> None:
    for i, result in enumerate(results, 1):
        header = title if len(results) == 1 else f"{title} — chunk {i}/{len(results)}"
        model = result.get("model", "unknown")
        usage = result.get("usage", {})
        tokens = usage.get("total_tokens", 0)
        subtitle = f"[dim]model: [bold yellow]{model}[/bold yellow]  |  tokens: {tokens}[/dim]"
        console.print(Panel(
            Markdown(result["content"]),
            title=f"[bold cyan]{header}[/bold cyan]",
            subtitle=subtitle,
            border_style="cyan",
        ))


# ─── logs ─────────────────────────────────────────────────────────────────────

@click.group()
def cli():
    """LLM relay security analysis client."""
    pass


@cli.command()
@click.argument("file", type=click.Path(exists=True))
@click.option("--os", "os_type", type=click.Choice(["linux", "windows"]), default="linux", show_default=True)
@click.option("--model", default=None, help="Pin a specific relay model (default: auto-route)")
@click.option("--output", "-o", default=None, help="Save results to JSON file")
def logs(file: str, os_type: str, model: str | None, output: str | None):
    """Analyze a Linux or Windows log file."""
    from parsers.logs import parse
    from prompts.logs import SYSTEM
    import relay

    console.print(f"\n[bold]Parsing[/bold] {file} ({os_type})")

    with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as prog:
        task = prog.add_task("Parsing log file...", total=None)
        chunks = parse(file, os_type)
        prog.update(task, description=f"Parsed → {len(chunks)} chunk(s)")

    console.print(f"[green]✓[/green] {len(chunks)} chunk(s) — sending to relay\n")

    results = []
    for i, chunk in enumerate(chunks, 1):
        console.print(f"[dim]Analyzing chunk {i}/{len(chunks)}...[/dim]")
        result = relay.analyze(SYSTEM, chunk, model)
        results.append(result)

    _print_results(results, f"Log Analysis — {Path(file).name}")
    _save(output, results, file)


# ─── pcap ─────────────────────────────────────────────────────────────────────

@cli.command()
@click.argument("file", type=click.Path(exists=True))
@click.option("--model", default=None, help="Pin a specific relay model")
@click.option("--output", "-o", default=None, help="Save results to JSON file")
def pcap(file: str, model: str | None, output: str | None):
    """Analyze a PCAP packet capture file."""
    from parsers.pcap import parse
    from prompts.pcap import SYSTEM
    import relay

    console.print(f"\n[bold]Parsing[/bold] {file}")

    with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as prog:
        task = prog.add_task("Reading packets...", total=None)
        chunks = parse(file)
        prog.update(task, description="Done parsing")

    console.print(f"[green]✓[/green] Summary ready — sending to relay\n")

    results = []
    for i, chunk in enumerate(chunks, 1):
        console.print(f"[dim]Analyzing chunk {i}/{len(chunks)}...[/dim]")
        result = relay.analyze(SYSTEM, chunk, model)
        results.append(result)

    _print_results(results, f"PCAP Analysis — {Path(file).name}")
    _save(output, results, file)


# ─── switch ───────────────────────────────────────────────────────────────────

@cli.command()
@click.option("--host", default=None, help="Switch IP/hostname (SSH)")
@click.option("--vendor", default="cisco_ios", show_default=True,
              help="Device type: cisco_ios, cisco_nxos, juniper_junos, arista_eos, etc.")
@click.option("--username", default=None, help="SSH username")
@click.option("--password", default=None, help="SSH password")
@click.option("--port", default=22, show_default=True, help="SSH port")
@click.option("--file", "config_file", default=None, type=click.Path(),
              help="Analyze a local config file instead of connecting via SSH")
@click.option("--model", default=None, help="Pin a specific relay model")
@click.option("--output", "-o", default=None, help="Save results to JSON file")
def switch(host: str | None, vendor: str, username: str | None, password: str | None,
           port: int, config_file: str | None, model: str | None, output: str | None):
    """Review switch/router configuration for security issues."""
    from parsers.switch import from_device, from_file
    from prompts.switch import SYSTEM
    import relay

    if config_file:
        console.print(f"\n[bold]Reading config file[/bold] {config_file}")
        chunks = from_file(config_file)
        label = config_file
    elif host:
        if not username or not password:
            console.print("[red]--username and --password are required for SSH connection[/red]")
            sys.exit(1)
        console.print(f"\n[bold]Connecting to[/bold] {host} ({vendor}) via SSH")
        with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as prog:
            task = prog.add_task("Pulling running-config...", total=None)
            chunks = from_device(host, vendor, username, password, port)
            prog.update(task, description="Config pulled")
        label = host
    else:
        console.print("[red]Provide either --host (SSH) or --file (local config)[/red]")
        sys.exit(1)

    console.print(f"[green]✓[/green] {len(chunks)} chunk(s) — sending to relay\n")

    results = []
    for i, chunk in enumerate(chunks, 1):
        console.print(f"[dim]Analyzing chunk {i}/{len(chunks)}...[/dim]")
        result = relay.analyze(SYSTEM, chunk, model)
        results.append(result)

    _print_results(results, f"Switch Config Review — {label}")
    _save(output, results, label)


# ─── models ───────────────────────────────────────────────────────────────────

@cli.command()
def models():
    """List available models from the relay."""
    import os
    import httpx
    from dotenv import load_dotenv

    load_dotenv()
    relay_url = os.getenv("RELAY_URL", "http://localhost:3100/v1").rstrip("/v1").rstrip("/")

    try:
        resp = httpx.get(f"{relay_url}/models", timeout=5)
        resp.raise_for_status()
        data = resp.json()
        console.print("\n[bold]Available models:[/bold]")
        for m in data.get("data", []):
            console.print(f"  [cyan]•[/cyan] {m['id']}")
    except Exception as e:
        console.print(f"[red]Could not reach relay: {e}[/red]")


if __name__ == "__main__":
    cli()
