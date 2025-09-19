#!/usr/bin/env python3
"""Normalize AI review suggestions for automatic patch application."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

try:  # Prefer the richer implementations from interactive_review when available.
    from interactive_review import (  # type: ignore
        Finding,
        extract_patch,
        parse_bad_findings,
    )
except Exception:  # pragma: no cover - fallback when helper is unavailable.

    @dataclass
    class Finding:  # type: ignore[no-redef]
        """Minimal representation of a BAD review finding."""

        identifier: str
        title: str
        file: str
        lines: str
        suggestion: str
        raw_block: str
        details: str = ""
        reasoning: str = ""
        function: str = ""

    def canonicalize_label(label: str) -> Optional[str]:
        normalized = label.lower().strip()
        normalized = normalized.replace("(if 'bad')", "")
        normalized = normalized.replace('(if "bad")', "")
        normalized = normalized.replace("(if bad)", "")
        normalized = normalized.rstrip(":").strip()
        aliases = {
            "title": "title",
            "file": "file",
            "function": "function",
            "lines": "lines",
            "line": "lines",
            "details": "details",
            "suggestion": "suggestion",
            "reasoning": "reasoning",
        }
        return aliases.get(normalized)

    def clean_value(text: str) -> str:
        cleaned = text.rstrip()
        if cleaned.endswith("\\"):
            cleaned = cleaned[:-1].rstrip()
        return cleaned

    def parse_fields(block_body: str) -> Dict[str, str]:
        fields: Dict[str, List[str]] = {}
        current_field: Optional[str] = None
        for raw_line in block_body.splitlines():
            stripped = raw_line.strip()
            if not stripped:
                if current_field:
                    fields.setdefault(current_field, []).append("")
                continue
            if stripped.startswith("---") or stripped.startswith("### "):
                current_field = None
                continue
            if stripped.startswith("**"):
                closing = stripped.find("**", 2)
                if closing != -1:
                    label = stripped[2:closing].strip()
                    remainder = stripped[closing + 2 :].lstrip(": ")
                    field_name = canonicalize_label(label)
                    if field_name:
                        current_field = field_name
                        fields.setdefault(current_field, [])
                        if remainder:
                            fields[current_field].append(clean_value(remainder))
                        continue
            if current_field:
                fields.setdefault(current_field, []).append(clean_value(raw_line))
        return {name: "\n".join(value).strip("\n") for name, value in fields.items()}

    def parse_bad_findings(review_text: str) -> List[Finding]:
        normalized = review_text.replace("\r\n", "\n")
        section_match = re.search(
            r"## Change-by-Change Review(?P<section>.*?)(?:\n## |\Z)",
            normalized,
            flags=re.S,
        )
        if not section_match:
            return []
        section = section_match.group("section")
        pattern = re.compile(
            r"### Assessment of the change:\s*(?P<grade>[A-Z]+).*?\n(?P<body>.*?)(?=\n### Assessment|\n## |\Z)",
            re.S,
        )
        findings: List[Finding] = []
        for match in pattern.finditer(section):
            grade = match.group("grade").strip().upper()
            if grade != "BAD":
                continue
            body = match.group("body")
            fields = parse_fields(body)
            raw_block = match.group(0).strip()
            identifier = sha256(raw_block.encode("utf-8")).hexdigest()[:16]
            findings.append(
                Finding(
                    identifier=identifier,
                    title=fields.get("title", ""),
                    file=fields.get("file", ""),
                    lines=fields.get("lines", ""),
                    suggestion=fields.get("suggestion", ""),
                    raw_block=raw_block,
                    details=fields.get("details", ""),
                    reasoning=fields.get("reasoning", ""),
                    function=fields.get("function", ""),
                )
            )
        return findings

    def extract_patch(ai_output: str) -> Optional[str]:
        pattern = re.compile(r"```(?:diff|patch|suggestion)?\n(.*?)```", re.S)
        match = pattern.search(ai_output)
        if not match:
            return None
        patch = match.group(1).strip()
        if not patch.endswith("\n"):
            patch += "\n"
        return patch


SUGGESTION_PATTERN = re.compile(
    r"(\*\*Suggestion[^*]*\*\*:)(?P<content>.*?)(?=\n\*\*Reasoning|\n---|\Z)",
    re.S,
)


def sanitize_path(path: str) -> str:
    """Normalize file path hints for diff headers."""

    cleaned = path.strip().replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned


def prepare_patch_for_application(patch: str, file_path: Optional[str]) -> Optional[str]:
    """Adjust a diff so it is acceptable to git apply."""

    normalized = patch.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    if not normalized:
        return None

    lines = normalized.split("\n")
    if not any(line.startswith("@@") for line in lines):
        return None

    path_hint = sanitize_path(file_path) if file_path else ""
    prepared = list(lines)

    diff_line = f"diff --git a/{path_hint} b/{path_hint}" if path_hint else ""
    diff_present = False
    for idx, line in enumerate(prepared):
        if line.startswith("diff --git "):
            diff_present = True
            if path_hint:
                prepared[idx] = diff_line
            break
    if not diff_present and path_hint:
        prepared.insert(0, diff_line)

    has_old = False
    has_new = False
    for idx, line in enumerate(prepared):
        if line.startswith("--- "):
            has_old = True
            if path_hint and "/dev/null" not in line:
                prepared[idx] = f"--- a/{path_hint}"
        elif line.startswith("+++ "):
            has_new = True
            if path_hint and "/dev/null" not in line:
                prepared[idx] = f"+++ b/{path_hint}"

    if (has_old and not has_new) or (has_new and not has_old):
        return None

    if not has_old and not has_new:
        if not path_hint:
            return None
        try:
            first_hunk = next(idx for idx, line in enumerate(prepared) if line.startswith("@@"))
        except StopIteration:
            return None
        header = [f"--- a/{path_hint}", f"+++ b/{path_hint}"]
        prepared[first_hunk:first_hunk] = header
        has_old = has_new = True

    if path_hint and not any(line.startswith("diff --git ") for line in prepared):
        prepared.insert(0, diff_line)

    # Ensure there is a trailing newline.
    result = "\n".join(prepared).rstrip("\n") + "\n"
    return result


def run_git_apply_check(repo_root: Path, patch: str) -> Tuple[bool, str]:
    """Verify that git apply --check accepts the patch."""

    try:
        process = subprocess.run(
            ["git", "apply", "--check", "-"],
            input=patch,
            text=True,
            capture_output=True,
            cwd=repo_root,
            check=False,
        )
    except FileNotFoundError as exc:
        return False, f"git executable not found: {exc}"
    except OSError as exc:  # pragma: no cover - defensive
        return False, f"Failed to execute git apply --check: {exc}"

    message = "".join(part for part in [process.stdout, process.stderr] if part)
    return process.returncode == 0, message.strip()


def update_suggestion_block(raw_block: str, replacement: str) -> str:
    """Return the block with the suggestion content substituted."""

    match = SUGGESTION_PATTERN.search(raw_block)
    if not match:
        return raw_block

    start = match.start("content")
    end = match.end("content")
    return raw_block[:start] + replacement + raw_block[end:]


def format_diff_suggestion(patch: str) -> str:
    body = patch.rstrip("\n")
    return f"\n```diff\n{body}\n```"


def format_no_patch() -> str:
    return " (no auto-applicable patch)"


def find_repo_root(explicit: Optional[str]) -> Path:
    if explicit:
        return Path(explicit).resolve()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path.cwd()
    return Path(result.stdout.strip() or ".").resolve()


def parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--review",
        default="auto_code_review.md",
        help="Path to the auto_code_review.md file to normalise.",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help="Explicit repository root (defaults to git rev-parse).",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = parse_args(argv)
    repo_root = find_repo_root(args.repo)
    review_path = Path(args.review)
    if not review_path.is_absolute():
        review_path = (Path.cwd() / review_path).resolve()

    try:
        review_text = review_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"[postprocess] Failed to read {review_path}: {exc}", file=sys.stderr)
        return 1

    findings = parse_bad_findings(review_text)
    if not findings:
        print("[postprocess] No BAD findings found; nothing to normalise.", file=sys.stderr)
        return 0

    updated_text = review_text
    replacements: List[Tuple[str, str]] = []
    success = 0
    skipped = 0
    failures: List[str] = []

    for finding in findings:
        suggestion = finding.suggestion.strip()
        if suggestion == "(no auto-applicable patch)":
            continue

        patch = extract_patch(suggestion)
        if not patch:
            skipped += 1
            failures.append(
                f"No diff block detected for '{finding.title or finding.file or finding.identifier}'."
            )
            new_block = update_suggestion_block(finding.raw_block, format_no_patch())
            replacements.append((finding.raw_block, new_block))
            continue

        prepared = prepare_patch_for_application(patch, finding.file)
        if not prepared:
            skipped += 1
            failures.append(
                f"Unable to normalise patch for '{finding.title or finding.file or finding.identifier}'."
            )
            new_block = update_suggestion_block(finding.raw_block, format_no_patch())
            replacements.append((finding.raw_block, new_block))
            continue

        ok, message = run_git_apply_check(repo_root, prepared)
        if not ok:
            skipped += 1
            detail = message or "git apply --check rejected the patch"
            failures.append(
                f"Patch rejected for '{finding.title or finding.file or finding.identifier}': {detail}"
            )
            new_block = update_suggestion_block(finding.raw_block, format_no_patch())
            replacements.append((finding.raw_block, new_block))
            continue

        success += 1
        replacement = format_diff_suggestion(prepared)
        new_block = update_suggestion_block(finding.raw_block, replacement)
        replacements.append((finding.raw_block, new_block))

    for old, new in replacements:
        if old == new:
            continue
        updated_text = updated_text.replace(old, new, 1)

    if updated_text != review_text:
        try:
            review_path.write_text(updated_text, encoding="utf-8")
        except OSError as exc:
            print(f"[postprocess] Failed to update {review_path}: {exc}", file=sys.stderr)
            return 1

    print(
        f"[postprocess] Normalised {success} suggestion(s); marked {skipped} as non-applicable.",
        file=sys.stderr,
    )
    for message in failures:
        print(f"[postprocess] {message}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
