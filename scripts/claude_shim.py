#!/usr/bin/env python3
"""
Claude CLI Approximation Shim for local AI workflows.
Allows workflows, scripts, and agents that expect `claude` CLI
to execute transparently using local LM Studio (e.g. Qwen 2.5 / 3.8, Gemma)
or Gemini API.
"""

import sys
import os
import json
import argparse
import urllib.request
import urllib.error
from pathlib import Path

LM_STUDIO_URL = os.environ.get("LM_STUDIO_URL", "http://127.0.0.1:1234/v1")
DEFAULT_MODEL = os.environ.get("LOCAL_MODEL", "qwen3.8-27b")


def find_project_context(start_dir: Path):
    """Search upwards for CLAUDE.md or AGENTS.md to inject system context."""
    current = start_dir.resolve()
    for parent in [current] + list(current.parents):
        claude_md = parent / "CLAUDE.md"
        if claude_md.is_file():
            try:
                return claude_md.read_text(encoding="utf-8")
            except Exception:
                pass
        agents_md = parent / "AGENTS.md"
        if agents_md.is_file():
            try:
                return agents_md.read_text(encoding="utf-8")
            except Exception:
                pass
    return None


def find_command_spec(start_dir: Path, command_name: str):
    """Search upwards for .claude/commands/<command_name>.md."""
    current = start_dir.resolve()
    for parent in [current] + list(current.parents):
        cmd_file = parent / ".claude" / "commands" / f"{command_name}.md"
        if cmd_file.is_file():
            try:
                return cmd_file.read_text(encoding="utf-8")
            except Exception:
                pass
    return None


def call_llm(messages, model=DEFAULT_MODEL, max_tokens=4096, temperature=0.3):
    """Call LM Studio chat completions endpoint."""
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens
    }
    
    req = urllib.request.Request(
        f"{LM_STUDIO_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            msg = data.get("choices", [{}])[0].get("message", {})
            content = msg.get("content", "")
            if not content and "reasoning_content" in msg:
                content = msg.get("reasoning_content", "")
            return content.strip()
    except urllib.error.URLError as e:
        sys.stderr.write(f"Error connecting to LM Studio at {LM_STUDIO_URL}: {e}\n")
        sys.stderr.write("Make sure LM Studio is running and local server is started.\n")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Claude CLI Approximation Shim")
    parser.add_argument("-p", "--print", dest="print_prompt", help="Print response to stdout (one-shot mode)")
    parser.add_argument("-c", "--continue", action="store_true", help="Continue previous conversation")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help="Model override")
    parser.add_argument("--dangerously-skip-permissions", "-y", action="store_true", help="Auto-approve (compatibility)")
    parser.add_argument("positional_prompt", nargs="*", help="Prompt or slash command")

    args = parser.parse_args()

    # Determine prompt text
    prompt = ""
    if args.print_prompt:
        prompt = args.print_prompt
    elif args.positional_prompt:
        prompt = " ".join(args.positional_prompt)
    elif not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()

    cwd = Path.cwd()
    system_context = find_project_context(cwd)

    # Check for slash commands like /apply, /setup, /rank
    command_instructions = ""
    if prompt.startswith("/"):
        parts = prompt.split(maxsplit=1)
        cmd_name = parts[0][1:]
        cmd_args = parts[1] if len(parts) > 1 else ""
        spec = find_command_spec(cwd, cmd_name)
        if spec:
            command_instructions = f"\n\n--- INSTRUCTIONS FOR COMMAND /{cmd_name} ---\n{spec}\n--- ARGUMENTS ---\n{cmd_args}"

    messages = []
    system_prompt = "You are Claude, an AI career and application assistant executing inside an agentic workspace."
    if system_context:
        system_prompt += f"\n\n--- WORKSPACE CONTEXT ---\n{system_context}"
    if command_instructions:
        system_prompt += command_instructions

    messages.append({"role": "system", "content": system_prompt})

    if prompt:
        messages.append({"role": "user", "content": prompt})
        response = call_llm(messages, model=args.model)
        print(response)
    else:
        # Interactive mode
        print(f"Claude CLI Shim (backed by {args.model} via LM Studio)")
        print("Type your message or /command, or Ctrl+D to exit.\n")
        try:
            while True:
                user_input = input("claude> ").strip()
                if not user_input:
                    continue
                messages.append({"role": "user", "content": user_input})
                print("Thinking...", end="\r", flush=True)
                response = call_llm(messages, model=args.model)
                print(" " * 20, end="\r")  # Clear "Thinking..."
                print(f"{response}\n")
                messages.append({"role": "assistant", "content": response})
        except (EOFError, KeyboardInterrupt):
            print("\nExiting.")


if __name__ == "__main__":
    main()
