#!/usr/bin/env python3
"""Static checks for the channel, standing in for a compiler we don't have here.

Catches the mistakes that otherwise only surface as a black screen on the
device: unbalanced blocks, handlers named in XML or observeField that don't
exist, component and script references that point at nothing.

Run from the repo root:  python3 roku/tools/check.py
"""

import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

OPENERS = [
    (re.compile(r"^\s*(?:@[\w.]+\s*)?(?:public\s+|private\s+)?(sub|function)\s+\w+\s*\(", re.I), "routine"),
]
CLOSERS = {
    "routine": re.compile(r"^\s*end\s+(sub|function)\b", re.I),
}

errors = []
warnings = []


def brs_files():
    for base, _, names in os.walk(ROOT):
        if os.sep + "tools" in base:
            continue
        for name in sorted(names):
            if name.endswith(".brs"):
                yield os.path.join(base, name)


def xml_files():
    for base, _, names in os.walk(ROOT):
        for name in sorted(names):
            if name.endswith(".xml"):
                yield os.path.join(base, name)


def rel(path):
    return os.path.relpath(path, ROOT)


def strip_comments(line):
    """Drop trailing comments, leaving quoted apostrophes alone."""
    out = []
    in_string = False
    for ch in line:
        if ch == '"':
            in_string = not in_string
        if ch == "'" and not in_string:
            break
        out.append(ch)
    return "".join(out)


def check_blocks(path):
    """Balance sub/function, if/end if, for/end for, while/end while."""
    depth = {"routine": 0, "if": 0, "for": 0, "while": 0}
    routine_line = 0

    with open(path, encoding="utf-8") as handle:
        lines = handle.readlines()

    for number, raw in enumerate(lines, start=1):
        line = strip_comments(raw).rstrip()
        if not line.strip():
            continue

        for pattern, kind in OPENERS:
            if pattern.match(line):
                if depth["routine"] > 0:
                    errors.append("%s:%d nested sub/function" % (rel(path), number))
                depth["routine"] += 1
                routine_line = number

        if CLOSERS["routine"].match(line):
            depth["routine"] -= 1
            if depth["routine"] < 0:
                errors.append("%s:%d stray 'end sub/function'" % (rel(path), number))
                depth["routine"] = 0
            for kind in ("if", "for", "while"):
                if depth[kind] != 0:
                    errors.append(
                        "%s:%d routine starting line %d closed with %d unbalanced '%s'"
                        % (rel(path), number, routine_line, depth[kind], kind)
                    )
                    depth[kind] = 0
            continue

        # A single-line "if x then y" needs no end if; a block one ends in "then".
        if re.match(r"^\s*if\b", line, re.I) and re.search(r"\bthen\s*$", line, re.I):
            depth["if"] += 1
        elif re.match(r"^\s*end\s*if\b", line, re.I):
            depth["if"] -= 1

        if re.match(r"^\s*for\b", line, re.I) and not re.match(r"^\s*for\s+each\b.*\bin\b.*:", line, re.I):
            depth["for"] += 1
        elif re.match(r"^\s*end\s+for\b", line, re.I):
            depth["for"] -= 1

        if re.match(r"^\s*while\b", line, re.I):
            depth["while"] += 1
        elif re.match(r"^\s*end\s+while\b", line, re.I):
            depth["while"] -= 1

        for kind in ("if", "for", "while"):
            if depth[kind] < 0:
                errors.append("%s:%d stray 'end %s'" % (rel(path), number, kind))
                depth[kind] = 0

    if depth["routine"] != 0:
        errors.append("%s: sub/function starting line %d never closed" % (rel(path), routine_line))


def routines_in(path):
    names = set()
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            match = re.match(r"^\s*(?:sub|function)\s+(\w+)\s*\(", strip_comments(raw), re.I)
            if match:
                names.add(match.group(1).lower())
    return names


def check_handlers():
    """Every observeField target and XML onChange must exist in the same file."""
    for path in xml_files():
        try:
            tree = ET.parse(path)
        except ET.ParseError as err:
            errors.append("%s: malformed XML — %s" % (rel(path), err))
            continue

        root = tree.getroot()
        scripts = []
        for script in root.iter("script"):
            uri = script.get("uri", "")
            if not uri.startswith("pkg:/"):
                continue
            target = os.path.join(ROOT, uri[len("pkg:/"):])
            if not os.path.exists(target):
                errors.append("%s: script uri points at nothing — %s" % (rel(path), uri))
            else:
                scripts.append(target)

        # source/ is compiled into every component's scope.
        defined = set()
        for script in scripts:
            defined |= routines_in(script)
        for base, _, names in os.walk(os.path.join(ROOT, "source")):
            for name in names:
                if name.endswith(".brs"):
                    defined |= routines_in(os.path.join(base, name))

        for element in root.iter():
            handler = element.get("onChange")
            if handler and handler.lower() not in defined:
                errors.append("%s: onChange=\"%s\" has no matching routine" % (rel(path), handler))

        for element in root.iter("function"):
            name = element.get("name", "")
            if name and name.lower() not in defined:
                errors.append("%s: <function name=\"%s\"/> has no matching routine" % (rel(path), name))

        for script in scripts:
            with open(script, encoding="utf-8") as handle:
                body = handle.read()
            for handler in re.findall(r"observeField\(\s*\"[^\"]+\"\s*,\s*\"(\w+)\"", body):
                if handler.lower() not in defined:
                    errors.append(
                        "%s: observeField target \"%s\" is not defined" % (rel(script), handler)
                    )


def check_component_references():
    """itemComponentName and custom node types must resolve to a component."""
    declared = {}
    for path in xml_files():
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError:
            continue
        name = root.get("name")
        if name:
            declared[name] = path

    builtin_prefixes = (
        "Group", "Rectangle", "Label", "Poster", "MarkupList", "MarkupGrid", "LabelList",
        "ButtonGroup", "Button", "Video", "Keyboard", "Scene", "Task", "ContentNode",
        "Timer", "Dialog", "BusySpinner", "LayoutGroup", "Overhang", "Animation",
    )

    for path in xml_files():
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError:
            continue

        for element in root.iter():
            wanted = element.get("itemComponentName")
            if wanted and wanted not in declared:
                errors.append(
                    "%s: itemComponentName=\"%s\" is not a component in this package"
                    % (rel(path), wanted)
                )

        children = root.find("children")
        if children is None:
            continue
        # iter() yields <children> itself first; only its descendants are nodes.
        for element in list(children.iter())[1:]:
            tag = element.tag
            if tag in ("Font",):
                continue
            if tag in declared or tag in builtin_prefixes:
                continue
            warnings.append("%s: <%s> is not a component here — assuming it's built in" % (rel(path), tag))


def check_manifest():
    path = os.path.join(ROOT, "manifest")
    if not os.path.exists(path):
        errors.append("manifest: missing")
        return

    values = {}
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()

    for required in ("title", "major_version", "minor_version", "build_version"):
        if required not in values:
            errors.append("manifest: missing %s" % required)

    for key, value in values.items():
        if value.startswith("pkg:/"):
            target = os.path.join(ROOT, value[len("pkg:/"):])
            if not os.path.exists(target):
                errors.append("manifest: %s points at a missing file — %s" % (key, value))


def main():
    for path in brs_files():
        check_blocks(path)
    check_handlers()
    check_component_references()
    check_manifest()

    for warning in warnings:
        print("warn:  %s" % warning)
    for error in errors:
        print("ERROR: %s" % error)

    if errors:
        print("\n%d problem(s) found." % len(errors))
        return 1

    print("\nAll checks passed (%d warnings)." % len(warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())
