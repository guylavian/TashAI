#!/usr/bin/env python3
"""Live interactive chat against the LLM relay with streaming and auto-routing."""

import json
import os
import re
from pathlib import Path

import httpx
from dotenv import load_dotenv
from prompt_toolkit import PromptSession
from prompt_toolkit.completion import PathCompleter, WordCompleter, merge_completers
from prompt_toolkit.history import FileHistory
from prompt_toolkit.styles import Style
from rich.console import Console
from rich.live import Live
from rich.markdown import Markdown
from rich.panel import Panel
from rich.rule import Rule
from rich.spinner import Spinner

load_dotenv()

RELAY_URL = os.getenv("RELAY_URL", "http://localhost:3100").rstrip("/").removesuffix("/v1")
console = Console()

PROMPT_STYLE = Style.from_dict({"prompt": "bold cyan"})

# Max bytes to inline from a single file before truncating
FILE_SIZE_LIMIT = 80_000

HELP_TEXT = """
[bold cyan]Commands[/bold cyan]
  [cyan]/clear[/cyan]    — clear conversation history (start fresh)
  [cyan]/history[/cyan]  — show messages in current session
  [cyan]/models[/cyan]   — list models loaded in LM Studio
  [cyan]/help[/cyan]     — show this message
  [cyan]/exit[/cyan]     — quit  (or Ctrl-D / Ctrl-C)

[bold cyan]File references[/bold cyan]
  Type [cyan]@[/cyan] followed by a path to inline a file into your query:
    >> analyze [cyan]@/var/log/auth.log[/cyan] for brute force indicators
    >> what issues do you see in [cyan]@~/switch-backup.txt[/cyan]
    >> diff these two: [cyan]@/etc/nginx/nginx.conf[/cyan] [cyan]@/tmp/nginx.new.conf[/cyan]

  Tab-completes after [cyan]@[/cyan]. Supports text files up to 80 KB.
"""


def _category_color(cat: str) -> str:
    return {
        "network":    "blue",
        "openshift":  "red",
        "windows":    "yellow",
        "security":   "magenta",
        "monitoring": "green",
        "automation": "cyan",
    }.get(cat, "white")


def _list_models() -> None:
    try:
        r = httpx.get(f"{RELAY_URL}/models", timeout=5)
        r.raise_for_status()
        for m in r.json().get("data", []):
            console.print(f"  [cyan]•[/cyan] {m['id']}")
    except Exception as e:
        console.print(f"[red]Could not reach relay: {e}[/red]")


# ─── File reference resolution ────────────────────────────────────────────────

_FILE_REF = re.compile(r"@([\S]+)")


_PARSED_EXTENSIONS = {
    ".pcap":   ("pcap",  None),
    ".pcapng": ("pcap",  None),
    ".evtx":   ("log",   "windows"),
}


def _load_file(raw_path: str) -> tuple[str, str | None]:
    """
    Reads a file and returns (formatted_block, error_message).
    formatted_block is empty string on error.
    Uses domain parsers for .pcap/.pcapng/.evtx; plain text for everything else.
    """
    path = Path(os.path.expanduser(raw_path)).resolve()

    if not path.exists():
        return "", f"File not found: {path}"
    if not path.is_file():
        return "", f"Not a file: {path}"

    ext = path.suffix.lower()

    # ── Structured binary formats — route through existing parsers ────────────
    if ext in _PARSED_EXTENSIONS:
        parser_type, os_type = _PARSED_EXTENSIONS[ext]
        try:
            if parser_type == "pcap":
                from parsers.pcap import parse
                chunks = parse(str(path))
            else:
                from parsers.logs import parse
                chunks = parse(str(path), os_type)
            text = "\n".join(chunks)
            block = f"\n\n--- File: {path} (parsed) ---\n{text}\n--- End of file ---\n"
            return block, None
        except Exception as e:
            return "", f"Failed to parse {path.name}: {e}"

    # ── Plain text files ───────────────────────────────────────────────────────
    try:
        raw = path.read_bytes()
    except PermissionError:
        return "", f"Permission denied: {path}"

    if b"\x00" in raw[:8192]:
        return "", f"Binary file not supported: {path.name}"

    text = raw[:FILE_SIZE_LIMIT].decode("utf-8", errors="replace")
    truncated = len(raw) > FILE_SIZE_LIMIT
    suffix = f"\n... [truncated — showing first {FILE_SIZE_LIMIT // 1000} KB of {len(raw) // 1000} KB]" if truncated else ""

    block = f"\n\n--- File: {path} ---\n{text}{suffix}\n--- End of file ---\n"
    return block, None


def _resolve_file_refs(user_input: str) -> tuple[str, list[str]]:
    """
    Replaces @/path/... tokens in user_input with the file contents.
    Returns (enriched_content, list_of_loaded_paths).
    """
    loaded = []
    errors = []

    def replace(match: re.Match) -> str:
        raw_path = match.group(1)
        block, err = _load_file(raw_path)
        if err:
            errors.append(err)
            return match.group(0)  # leave token as-is so model sees the reference
        loaded.append(str(Path(os.path.expanduser(raw_path)).resolve()))
        return block

    enriched = _FILE_REF.sub(replace, user_input)

    for err in errors:
        console.print(f"[red]⚠ {err}[/red]")

    return enriched, loaded


# ─── Command handler ──────────────────────────────────────────────────────────

def _handle_command(cmd: str, history: list) -> bool:
    """Returns True if the main loop should continue."""
    cmd_lower = cmd.strip().lower()
    if cmd_lower in ("/exit", "/quit"):
        return False
    if cmd_lower == "/clear":
        history.clear()
        console.print("[dim]History cleared.[/dim]")
    elif cmd_lower == "/history":
        if not history:
            console.print("[dim]No messages yet.[/dim]")
        for msg in history:
            role = "[bold cyan]you[/bold cyan]" if msg["role"] == "user" else "[bold green]assistant[/bold green]"
            preview = msg["content"][:120]
            ellipsis = "…" if len(msg["content"]) > 120 else ""
            console.print(f"{role}: {preview}{ellipsis}")
    elif cmd_lower == "/models":
        _list_models()
    elif cmd_lower == "/help":
        console.print(HELP_TEXT)
    else:
        console.print("[dim]Unknown command. Type /help.[/dim]")
    return True


# ─── Streaming query ──────────────────────────────────────────────────────────

def _stream_query(messages: list) -> tuple[str, dict | None]:
    """POST to /compute/auto with streaming. Returns (full_text, classification)."""
    classification = None
    response_text = ""

    with Live(
        Spinner("dots", text="[dim]routing…[/dim]"),
        console=console,
        refresh_per_second=12,
        transient=True,
    ) as live:
        with httpx.Client(timeout=180) as client:
            with client.stream(
                "POST",
                f"{RELAY_URL}/compute/auto",
                json={"messages": messages, "stream": True, "max_tokens": 4096, "temperature": 0.2},
            ) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    try:
                        data = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue

                    if data.get("type") == "classification":
                        classification = data["classification"]
                        cat = classification.get("category", "?")
                        model = (classification.get("recommended_model") or "?").split("/")[-1]
                        conf = classification.get("confidence", 0)
                        color = _category_color(cat)
                        live.update(Spinner("dots", text=f"[dim]▸ [{color}]{cat}[/{color}]  {model}  conf:{conf:.2f}[/dim]"))

                    elif data.get("type") == "chunk":
                        response_text += data.get("content", "")
                        words = len(response_text.split())
                        live.update(Spinner("dots", text=f"[dim]generating… {words} words[/dim]"))

                    elif data.get("type") == "done":
                        break

    return response_text, classification


# ─── Main loop ────────────────────────────────────────────────────────────────

def main() -> None:
    console.print(Panel(
        "[bold cyan]Infrastructure AI — Live Chat[/bold cyan]\n"
        "[dim]Auto-routes to best model · [cyan]@/path[/cyan] to attach files · [cyan]/help[/cyan] for commands[/dim]",
        border_style="cyan",
        padding=(0, 2),
    ))

    # Tab completion: slash commands + @ path completion
    cmd_completer = WordCompleter(
        ["/clear", "/history", "/models", "/help", "/exit"],
        pattern=re.compile(r"(/\w*)"),
    )
    path_completer = PathCompleter(only_directories=False, expanduser=True)

    session = PromptSession(
        history=FileHistory(os.path.expanduser("~/.llm_chat_history")),
        style=PROMPT_STYLE,
        completer=merge_completers([cmd_completer, path_completer]),
        complete_while_typing=False,
    )
    history: list[dict] = []

    while True:
        try:
            user_input = session.prompt([("class:prompt", "\n>> ")]).strip()
        except KeyboardInterrupt:
            console.print()
            continue
        except EOFError:
            console.print("\n[dim]Bye.[/dim]")
            break

        if not user_input:
            continue

        if user_input.startswith("/"):
            if not _handle_command(user_input, history):
                console.print("[dim]Bye.[/dim]")
                break
            continue

        # Resolve @file references before sending
        enriched_input, loaded_files = _resolve_file_refs(user_input)
        if loaded_files:
            for f in loaded_files:
                console.print(f"[dim]📎 loaded {f}[/dim]")

        history.append({"role": "user", "content": enriched_input})

        try:
            response_text, classification = _stream_query(history)
        except httpx.ConnectError:
            console.print("[red]Cannot reach relay — is it running on port 3100?[/red]")
            history.pop()
            continue
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            history.pop()
            continue

        if response_text:
            subtitle = ""
            if classification:
                cat = classification.get("category", "?")
                model = (classification.get("recommended_model") or "?").split("/")[-1]
                conf = classification.get("confidence", 0)
                color = _category_color(cat)
                subtitle = f"[dim][{color}]{cat}[/{color}] · {model} · conf {conf:.2f}[/dim]"

            console.print(Panel(
                Markdown(response_text),
                subtitle=subtitle,
                border_style="green",
                padding=(1, 2),
            ))
            history.append({"role": "assistant", "content": response_text})


if __name__ == "__main__":
    main()
