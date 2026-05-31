"""Thin wrapper around the LLM relay's OpenAI-compatible API."""

import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(
            base_url=os.getenv("RELAY_URL", "http://localhost:3100/v1"),
            api_key=os.getenv("RELAY_API_KEY", "lm-studio"),
        )
    return _client


def analyze(system_prompt: str, user_content: str, model: str | None = None,
            source: str | None = None) -> dict:
    """Send content to the relay and return {content, model, usage}.

    `source` (e.g. "pcap", "evtx", "switch") lets the relay's classifier
    skip the LLM round-trip via Tier-0 provenance routing.
    """
    client = _get_client()
    pinned_model = model or os.getenv("RELAY_MODEL") or "auto"

    extra_body = {"metadata": {"source": source}} if source else {}
    response = client.chat.completions.create(
        model=pinned_model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        temperature=0.2,
        max_tokens=4096,
        extra_body=extra_body,
    )
    return {
        "content": response.choices[0].message.content or "",
        "model": response.model,
        "usage": {
            "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
            "completion_tokens": response.usage.completion_tokens if response.usage else 0,
            "total_tokens": response.usage.total_tokens if response.usage else 0,
        },
    }


def analyze_chunks(system_prompt: str, chunks: list[str], label: str, model: str | None = None,
                   source: str | None = None) -> list[str]:
    """Analyze multiple chunks and return one result per chunk."""
    results = []
    for i, chunk in enumerate(chunks, 1):
        print(f"  [{i}/{len(chunks)}] analyzing {label} chunk {i}...")
        result = analyze(system_prompt, chunk, model, source)
        results.append(result)
    return results
