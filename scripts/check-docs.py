#!/usr/bin/env python3
"""Check publishable Markdown links and fences locally, without fetching URLs."""

from __future__ import annotations

import html
from pathlib import Path
import re
import subprocess
import sys
import unicodedata
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_SUFFIXES = {".md", ".markdown"}
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
ATX_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$")
REFERENCE = re.compile(r"^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s]+))", re.MULTILINE)
HTML_ID = re.compile(r"<[^>]+\b(?:id|name)\s*=\s*['\"]([^'\"]+)['\"][^>]*>", re.IGNORECASE)


def mask(value: str) -> str:
    """Keep offsets and line numbers while hiding code contents."""
    return "".join("\n" if char == "\n" else " " for char in value)


def without_fences(text: str) -> tuple[str, int | None]:
    lines = []
    opened = None
    for number, line in enumerate(text.splitlines(keepends=True), 1):
        candidate = FENCE.match(line.rstrip("\r\n"))
        if opened is not None:
            lines.append(mask(line))
            if candidate:
                run, tail = candidate.groups()
                if run[0] == opened[0] and len(run) >= opened[1] and not tail.strip():
                    opened = None
        elif candidate and not (candidate[1].startswith("`") and "`" in candidate[2]):
            opened = (candidate[1][0], len(candidate[1]), number)
            lines.append(mask(line))
        else:
            lines.append(line)
    return "".join(lines), opened[2] if opened else None


def without_inline_code(text: str) -> str:
    # An inline delimiter closes only on an equally long backtick run. Inline
    # spans may cross a line; unmatched delimiters remain ordinary Markdown.
    runs = list(re.finditer(r"`+", text))
    output = list(text)
    index = 0
    while index < len(runs):
        start = runs[index]
        if start.start() and text[start.start() - 1] == "\\":
            index += 1
            continue
        end = index + 1
        while end < len(runs) and len(runs[end][0]) != len(start[0]):
            end += 1
        if end == len(runs):
            index += 1
            continue
        stop = runs[end].end()
        output[start.start():stop] = mask(text[start.start():stop])
        index = end + 1
    return "".join(output)


def heading_slug(text: str) -> str:
    text = re.sub(r"<[^>]*>", "", html.unescape(text))
    text = re.sub(r"!?\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = text.strip().lower()
    # GitHub-style headings retain Unicode letters/marks/numbers, underscore
    # and hyphen, remove punctuation, and turn whitespace into hyphens.
    return "".join(
        "-" if char.isspace() else char
        for char in text
        if char.isspace() or char in "_-" or unicodedata.category(char)[0] in "LMN"
    )


def heading_anchors(text: str) -> set[str]:
    anchors = set()
    generated = set()
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = ATX_HEADING.match(line)
        if match:
            title = re.sub(r"[ \t]+#+[ \t]*$", "", match[2])
        elif re.fullmatch(r" {0,3}(?:=+|-+)[ \t]*", line) and index and lines[index - 1].strip():
            title = lines[index - 1]
        else:
            continue
        base = heading_slug(title)
        slug = base
        suffix = 0
        while slug in generated:
            suffix += 1
            slug = f"{base}-{suffix}"
        generated.add(slug)
        anchors.add(slug)
    anchors.update(html.unescape(match[1]) for match in HTML_ID.finditer(text))
    return anchors


def destinations(text: str):
    """Yield ordinary inline/image and reference-definition destinations."""
    for match in re.finditer(r"(?<!\\)\]\([ \t\n]*", text):
        start = index = match.end()
        if index >= len(text):
            continue
        if text[index] == "<":
            end = text.find(">", index + 1)
            if end != -1:
                yield match.start(), text[index + 1:end]
            continue
        depth = 0
        target = []
        while index < len(text):
            char = text[index]
            if char == "\\" and index + 1 < len(text):
                index += 1
                target.append(text[index])
            elif char == "(":
                depth += 1
                target.append(char)
            elif char == ")":
                if depth == 0:
                    break
                depth -= 1
                target.append(char)
            elif char.isspace() and depth == 0:
                break
            else:
                target.append(char)
            index += 1
        if index < len(text) and (index > start or text[index] == ")"):
            yield match.start(), "".join(target)
    for match in REFERENCE.finditer(text):
        yield match.start(), match[2] if match[2] is not None else match[3]


def publishable_files(root: Path) -> set[Path]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return {root / name.decode("utf-8") for name in result.stdout.split(b"\0") if name}


def check(root: Path) -> list[str]:
    root = root.resolve()
    files = publishable_files(root)
    markdown = sorted(path for path in files if path.suffix.lower() in MARKDOWN_SUFFIXES)
    public_targets = {path.resolve() for path in files}
    errors = []
    documents = {}
    for path in markdown:
        label = path.relative_to(root).as_posix()
        # Never open a Markdown symlink: even an in-repository target could be
        # an ignored environment file or private artifact.
        if path.is_symlink():
            errors.append(f"{label}: Markdown symlinks are not supported")
            continue
        if not path.resolve().is_relative_to(root):
            errors.append(f"{label}: Markdown resolves outside the repository")
            continue
        if not path.is_file():
            errors.append(f"{label}: publishable Markdown file is missing")
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            errors.append(f"{label}: Markdown is not readable UTF-8")
            continue
        visible, unclosed = without_fences(text)
        if unclosed:
            errors.append(f"{label}:{unclosed}: unclosed fenced code block")
        documents[path.resolve()] = (without_inline_code(visible), heading_anchors(visible))

    for path, (visible, _) in documents.items():
        label = path.relative_to(root).as_posix()
        for offset, raw in destinations(visible):
            line = visible.count("\n", 0, offset) + 1
            prefix = f"{label}:{line}"
            raw = html.unescape(raw)
            try:
                url = urlsplit(raw)
            except ValueError:
                errors.append(f"{prefix}: malformed link destination")
                continue
            # No URL is fetched: external, mailto, app and data links are outside
            # this local check. Root-absolute filesystem links are never portable.
            if url.scheme or url.netloc:
                continue
            destination = unquote(url.path)
            if "\0" in destination:
                errors.append(f"{prefix}: NUL in local link destination")
                continue
            target = (path.parent / destination).resolve() if destination else path
            if not target.is_relative_to(root):
                errors.append(f"{prefix}: local link resolves outside the repository")
                continue
            if not target.exists():
                errors.append(f"{prefix}: missing local target {destination}")
                continue
            if target.is_file() and target not in public_targets:
                errors.append(f"{prefix}: local target is excluded from the publishable inventory")
                continue
            # Fragments in source files/images have renderer-specific meaning.
            # Check Markdown headings only in files from the publishable inventory;
            # ignored or private target contents are never opened for validation.
            if url.fragment and target.suffix.lower() in MARKDOWN_SUFFIXES:
                document = documents.get(target)
                if document is None:
                    errors.append(f"{prefix}: linked Markdown is not a publishable document")
                elif unquote(url.fragment) not in document[1]:
                    errors.append(f"{prefix}: missing Markdown anchor #{url.fragment}")
    return errors


def main() -> int:
    if len(sys.argv) != 1:
        print("Usage: python3 scripts/check-docs.py", file=sys.stderr)
        return 2
    try:
        errors = check(ROOT)
    except (OSError, subprocess.CalledProcessError, UnicodeError):
        print("Cannot read the Git publishable-file inventory.", file=sys.stderr)
        return 2
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("Publishable Markdown: local links, heading anchors and code fences passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
