#!/usr/bin/env python3
"""Live interactive chat against the LLM relay with streaming and auto-routing."""

import json
import os
import re
import subprocess
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

# Max chars to inline from a single file before truncating
FILE_SIZE_LIMIT = 80_000
# XML/HTML are verbose — cap lower so they don't overflow model context
XML_SIZE_LIMIT = 20_000

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

  Supports text files, [cyan].pcap[/cyan], and [cyan].evtx[/cyan] (auto-parsed).

[bold cyan]Command execution[/bold cyan]
  When the model responds with a shell command, the CLI will ask:
    [yellow]▸ Execute? [y/N][/yellow]
  Type [yellow]y[/yellow] to run it. Output is captured and sent back to the model for analysis.
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

# Match @path file references, but NOT the user@host in SSH syntax.
# A leading word char before @ (e.g. "admin@10.0.0.1") means it's a host, not a ref.
_FILE_REF = re.compile(r"(?<![\w@])@(\S+)")


_PARSED_EXTENSIONS = {
    ".pcap":   ("pcap",  None),
    ".pcapng": ("pcap",  None),
    ".evtx":   ("log",   "windows"),
}

# Maps a file extension to the relay's Tier-0 provenance `source`, so an
# attached pcap/evtx routes instantly without a classifier round-trip.
_EXT_TO_SOURCE = {
    ".pcap":   "pcap",
    ".pcapng": "pcap",
    ".evtx":   "evtx",
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

    # UTF-16 files (common from Windows tools) have null bytes — try to decode before rejecting
    if b"\x00" in raw[:8192]:
        enc = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-16-le"
        try:
            text = raw.decode(enc).replace("\x00", "")
        except UnicodeDecodeError:
            return "", f"Binary file not supported: {path.name}"
        if not text.strip():
            return "", f"File appears empty or corrupted (all null bytes): {path.name}"
    else:
        text = raw.decode("utf-8", errors="replace")

    # ── XML/HTML: strip tags, keep structure as condensed text ────────────────
    if ext in (".xml", ".html", ".htm"):
        text = _extract_xml_text(text)
        limit = XML_SIZE_LIMIT
    else:
        limit = FILE_SIZE_LIMIT

    truncated = len(text) > limit
    if truncated:
        text = text[:limit]
    suffix = f"\n... [truncated — showing first {limit // 1000} KB of {len(raw) // 1000} KB]" if truncated else ""

    block = f"\n\n--- File: {path} ---\n{text}{suffix}\n--- End of file ---\n"
    return block, None


def _extract_xml_text(raw_xml: str) -> str:
    """
    Condense XML into a compact readable form the model can process efficiently.
    Strips namespace prefixes, keeps tag names + attributes + text nodes.
    Falls back to regex stripping if the XML is malformed.
    """
    import xml.etree.ElementTree as ET
    import re as _re

    def _strip_ns(tag: str) -> str:
        return tag.split("}")[-1] if "}" in tag else tag

    def _walk(el: ET.Element, depth: int = 0) -> list[str]:
        indent = "  " * depth
        attrs = " ".join(f'{k.split("}")[-1]}="{v}"' for k, v in el.attrib.items())
        header = f"{indent}<{_strip_ns(el.tag)}{' ' + attrs if attrs else ''}>"
        lines = [header]
        if el.text and el.text.strip():
            lines.append(f"{indent}  {el.text.strip()}")
        for child in el:
            lines.extend(_walk(child, depth + 1))
        return lines

    try:
        root = ET.fromstring(raw_xml)
        return "\n".join(_walk(root))
    except ET.ParseError:
        # Malformed XML — strip tags with regex as fallback
        no_tags = _re.sub(r"<[^>]+>", " ", raw_xml)
        return _re.sub(r"\s{2,}", " ", no_tags).strip()


def _resolve_file_refs(user_input: str) -> tuple[str, list[str], str | None]:
    """
    Replaces @/path/... tokens in user_input with the file contents.
    Returns (enriched_content, list_of_loaded_paths, source).

    `source` is the relay provenance hint ("pcap"/"evtx") when exactly one
    parsed file type was attached; None if zero or mixed types (ambiguous).
    """
    loaded = []
    errors = []
    sources: set[str] = set()

    def replace(match: re.Match) -> str:
        raw_path = match.group(1)
        block, err = _load_file(raw_path)
        if err:
            errors.append(err)
            name = Path(raw_path).name
            return f"[file '{name}' could not be loaded: {err}]"
        loaded.append(str(Path(os.path.expanduser(raw_path)).resolve()))
        src = _EXT_TO_SOURCE.get(Path(raw_path).suffix.lower())
        if src:
            sources.add(src)
        return block

    enriched = _FILE_REF.sub(replace, user_input)

    for err in errors:
        console.print(f"[red]⚠ {err}[/red]")

    source = next(iter(sources)) if len(sources) == 1 else None
    return enriched, loaded, source


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


# ─── Command execution ───────────────────────────────────────────────────────

# Only fences EXPLICITLY tagged as a shell are candidates for execution. An
# untagged ``` block (which models use for prose, output samples, YAML, etc.)
# is never run — that was the cause of "Apply it to the namespace:" being
# executed as a command.
_SHELL_FENCE = re.compile(
    r"```(?:bash|sh|shell|zsh|console|shell-session)[^\n]*\n(.*?)```",
    re.DOTALL | re.IGNORECASE,
)


def _looks_like_command(line: str) -> bool:
    """True only for lines that plausibly are shell commands, not prose/markdown."""
    s = line.strip()
    s = re.sub(r"^[$%#>]\s+", "", s)  # strip a prompt/quote marker
    if not s:
        return False
    # markdown / prose artifacts
    if s.startswith(("**", "#", ">", "- ", "* ", "---", "//")) or "**" in s or "###" in s:
        return False
    first = s.split()[0]
    if "=" in first:  # env-var assignment like FOO=bar cmd → fine
        return True
    # Real commands start with a lowercase binary/path. A capitalized first word
    # followed by a space is almost always an English sentence ("Apply it…",
    # "You should…", "If you…", "Check the…").
    if first[:1].isupper() and " " in s:
        return False
    return True


def _extract_commands(text: str) -> list[str]:
    """Extract runnable shell from explicitly shell-tagged fences only.

    Untagged fences and non-shell languages (yaml/json/text/python) are ignored,
    and prose/markdown lines are filtered out, so the model's explanations are
    never executed.
    """
    cmds: list[str] = []
    for match in _SHELL_FENCE.finditer(text):
        block = match.group(1).strip()
        if not block or block.startswith("---"):
            continue
        nonempty = [ln for ln in block.splitlines() if ln.strip()]
        good = [ln for ln in block.splitlines() if _looks_like_command(ln)]
        # Require it to be mostly commands — a block that's >half prose is an
        # explanation the model happened to fence, not something to run.
        if not good or len(good) < max(1, (len(nonempty) + 1) // 2):
            continue
        cmds.append("\n".join(good))
    return cmds


def _run_command(cmd: str, session: PromptSession) -> str | None:
    """
    Show the command, ask for confirmation, execute if approved.
    Returns the output string, or None if the user declined.
    """
    console.print(f"\n[bold yellow]▸ Execute?[/bold yellow]")
    console.print(Panel(cmd, border_style="yellow", padding=(0, 1)))

    try:
        answer = session.prompt([("class:prompt", "  [y/N] ")]).strip().lower()
    except (KeyboardInterrupt, EOFError):
        return None

    if answer != "y":
        return None

    console.print("[dim]Running…[/dim]")
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=60
        )
        output = (result.stdout + result.stderr).strip() or "(no output)"
    except subprocess.TimeoutExpired:
        output = "(timed out after 60s)"
    except Exception as e:
        output = f"(error: {e})"

    console.print(Panel(output, title="[dim]output[/dim]", border_style="dim", padding=(0, 1)))
    return output


# ─── Streaming query ──────────────────────────────────────────────────────────

def _stream_query(messages: list, source: str | None = None) -> tuple[str, dict | None]:
    """POST to /compute/auto with streaming. Returns (full_text, classification).

    `source` sets metadata.source so the relay can Tier-0 route attached
    pcap/evtx files without a classifier round-trip.
    """
    classification = None
    response_text = ""

    payload: dict = {"messages": messages, "stream": True, "max_tokens": 4096, "temperature": 0.2}
    if source:
        payload["metadata"] = {"source": source}

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
                json=payload,
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

                    elif data.get("type") == "error":
                        raise RuntimeError(data.get("message", "stream error from relay"))

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
        enriched_input, loaded_files, source = _resolve_file_refs(user_input)
        if loaded_files:
            for f in loaded_files:
                console.print(f"[dim]📎 loaded {f}[/dim]")

        history.append({"role": "user", "content": enriched_input})

        try:
            response_text, classification = _stream_query(history, source)
        except httpx.ConnectError:
            console.print("[red]Cannot reach relay — is it running on port 3100?[/red]")
            history.pop()
            continue
        except httpx.RemoteProtocolError:
            console.print("[red]LM Studio closed the connection — context likely too large. Try attaching a smaller file or fewer files at once.[/red]")
            history.pop()
            continue
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            history.pop()
            continue

        if not response_text:
            console.print("[yellow]⚠ Model returned empty response — context may be too large or model is overloaded.[/yellow]")
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

            # Offer to execute any shell commands the model suggested
            for cmd in _extract_commands(response_text):
                output = _run_command(cmd, session)
                if output is None:
                    continue
                # Feed output back so the model can analyze it
                feedback = f"Command executed. Output:\n```\n{output}\n```\nAnalyze this output."
                history.append({"role": "user", "content": feedback})
                try:
                    followup, clf2 = _stream_query(history)
                except Exception:
                    continue
                if followup:
                    subtitle2 = ""
                    if clf2:
                        cat2 = clf2.get("category", "?")
                        m2 = (clf2.get("recommended_model") or "?").split("/")[-1]
                        color2 = _category_color(cat2)
                        subtitle2 = f"[dim][{color2}]{cat2}[/{color2}] · {m2}[/dim]"
                    console.print(Panel(
                        Markdown(followup),
                        subtitle=subtitle2,
                        border_style="green",
                        padding=(1, 2),
                    ))
                    history.append({"role": "assistant", "content": followup})


if __name__ == "__main__":
    main()
