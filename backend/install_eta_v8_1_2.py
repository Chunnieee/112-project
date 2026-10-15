#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import re, shutil, subprocess, sys

ROOT = Path.cwd()
BUNDLE = Path(__file__).resolve().parent
SERVER = ROOT / "server.js"
MODULE = ROOT / "cityCoverageV8_1.js"
TEST = ROOT / "testEtaV8_1.js"
README = ROOT / "ETA_V8_1_2_README.txt"

for p in (SERVER, ROOT / "tdxEtaEngine.js", ROOT / "tdxClient.js"):
    if not p.exists():
        raise SystemExit(f"PATCH FAILED: missing required file: {p}")

server = SERVER.read_text(encoding="utf-8")
engine = (ROOT / "tdxEtaEngine.js").read_text(encoding="utf-8")
client = (ROOT / "tdxClient.js").read_text(encoding="utf-8")

if "ETA_ENGINE_V8_CANONICAL_SECTION_GEOMETRY" not in engine:
    raise SystemExit("PATCH FAILED: V8 canonical geometry is not installed")
if "getFreewaySectionShapes" not in client:
    raise SystemExit("PATCH FAILED: V8 TDX canonical static loaders are missing")
if "loadCityLivePackages" not in server:
    raise SystemExit("PATCH FAILED: server city traffic loader not found")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = SERVER.with_name(f"server.before-eta-v8-1-2-{stamp}.js")
shutil.copy2(SERVER, backup)
print("Backup:", backup)

def safe_copy(src, dst):
    src = Path(src)
    dst = Path(dst)
    try:
        if src.resolve() == dst.resolve():
            print(f"Already in place: {dst}")
            return
    except FileNotFoundError:
        pass
    shutil.copy2(src, dst)

def node_check(path):
    r = subprocess.run(["node", "--check", str(path)], text=True, capture_output=True)
    if r.returncode:
        raise RuntimeError(f"node --check failed for {path.name}:\n{r.stderr}")

def insert_import_after_last_import(text, import_line):
    if 'from "./cityCoverageV8_1.js"' in text or "from './cityCoverageV8_1.js'" in text:
        return text

    # Robust against dotenv.config();, dotenv.config({...});, or no dotenv at all.
    # ESM import declarations can be separated by top-level statements, so locate
    # the final static import declaration rather than depending on dotenv syntax.
    matches = list(re.finditer(r'(?ms)^import\b.*?;[ \t]*(?:\r?\n)?', text))
    if not matches:
        raise RuntimeError("no static import declaration found for V8.1.2 import insertion")
    pos = matches[-1].end()
    return text[:pos] + import_line + text[pos:]

def find_matching_brace_js(text, open_index):
    if open_index < 0 or open_index >= len(text) or text[open_index] != '{':
        raise RuntimeError("invalid opening brace")
    depth = 0
    i = open_index
    mode = "code"
    quote = None
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""

        if mode == "line_comment":
            if ch == "\n": mode = "code"
            i += 1
            continue
        if mode == "block_comment":
            if ch == "*" and nxt == "/":
                mode = "code"; i += 2; continue
            i += 1
            continue
        if mode == "string":
            if ch == "\\":
                i += 2; continue
            if ch == quote:
                mode = "code"; quote = None
            i += 1
            continue
        if mode == "template":
            if ch == "\\":
                i += 2; continue
            if ch == "`":
                mode = "code"
            i += 1
            continue

        if ch == "/" and nxt == "/":
            mode = "line_comment"; i += 2; continue
        if ch == "/" and nxt == "*":
            mode = "block_comment"; i += 2; continue
        if ch in ('"', "'"):
            mode = "string"; quote = ch; i += 1; continue
        if ch == "`":
            mode = "template"; i += 1; continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise RuntimeError("unterminated loadCityLivePackages function")

def replace_named_async_function(text, name, replacement):
    rx = re.compile(rf'async\s+function\s+{re.escape(name)}\s*\(\s*cities\s*\)\s*\{{')
    matches = list(rx.finditer(text))
    if len(matches) != 1:
        raise RuntimeError(f"{name} expected exactly 1 match, found {len(matches)}")
    m = matches[0]
    open_brace = text.find('{', m.start(), m.end())
    close_brace = find_matching_brace_js(text, open_brace)
    end = close_brace + 1
    # Consume trailing horizontal whitespace and at most two newlines so reruns
    # do not progressively add blank lines.
    while end < len(text) and text[end] in ' \t':
        end += 1
    newline_count = 0
    while end < len(text) and text[end] in '\r\n' and newline_count < 2:
        if text[end] == '\n': newline_count += 1
        end += 1
    return text[:m.start()] + replacement + text[end:]

try:
    safe_copy(BUNDLE / "cityCoverageV8_1.js", MODULE)
    safe_copy(BUNDLE / "testEtaV8_1.js", TEST)
    safe_copy(BUNDLE / "ETA_V8_1_2_README.txt", README)

    server = SERVER.read_text(encoding="utf-8")
    server = insert_import_after_last_import(
        server,
        'import { loadCityPackagesResilient } from "./cityCoverageV8_1.js";\n'
    )

    replacement = '''async function loadCityLivePackages(cities) {
  const { packages } = await loadCityPackagesResilient({
    cities,
    getShape: getCitySectionShapes,
    getLink: getCitySectionLinks,
    getLive: getCityLiveTraffic,
    buildPackage: buildCityObservedSections,
    // Network-resilience timeout only. This never changes ETA values.
    // One unsupported/slow jurisdiction cannot erase already-usable
    // city traffic from the other jurisdictions on the route.
    perScopeTimeoutMs: 5500,
    logger: console,
  });

  return packages;
}

'''
    server = replace_named_async_function(server, "loadCityLivePackages", replacement)
    SERVER.write_text(server, encoding="utf-8")

    node_check(MODULE)
    node_check(SERVER)

    r = subprocess.run(["node", "--test", str(TEST)], cwd=str(ROOT), text=True, capture_output=True)
    if r.returncode:
        raise RuntimeError("V8.1 tests failed:\n" + r.stdout + "\n" + r.stderr)
    print(r.stdout.rstrip())

except Exception as exc:
    shutil.copy2(backup, SERVER)
    print(f"PATCH FAILED: {exc}", file=sys.stderr)
    raise SystemExit(1)

print("ETA V8.1.2 PARTIAL CITY COVERAGE INSTALLED")
print("- import insertion no longer depends on exact dotenv.config() syntax")
print("- one slow/unsupported city cannot zero out successful city packages")
print("- SectionLink remains optional")
print("- no ETA multiplier or guessed delay added")
