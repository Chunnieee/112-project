#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import re, shutil, subprocess, sys

ROOT = Path.cwd()
BUNDLE = Path(__file__).resolve().parent
SERVER = ROOT / "server.js"
MODULE = ROOT / "cityCoverageV8_1.js"
TEST = ROOT / "testEtaV8_1.js"
README = ROOT / "ETA_V8_1_README.txt"

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
backup = SERVER.with_name(f"server.before-eta-v8-1-{stamp}.js")
shutil.copy2(SERVER, backup)
print("Backup:", backup)

def node_check(path):
    r = subprocess.run(["node", "--check", str(path)], text=True, capture_output=True)
    if r.returncode:
        raise RuntimeError(f"node --check failed for {path.name}:\n{r.stderr}")

try:
    for src, dst in [
        (BUNDLE / "cityCoverageV8_1.js", MODULE),
        (BUNDLE / "testEtaV8_1.js", TEST),
        (BUNDLE / "ETA_V8_1_README.txt", README),
    ]:
        if src.resolve() == dst.resolve():
            print(f"Already in place: {dst}")
        else:
            shutil.copy2(src, dst)

    server = SERVER.read_text(encoding="utf-8")
    if 'from "./cityCoverageV8_1.js"' not in server and "from './cityCoverageV8_1.js'" not in server:
        # Insert after the import section, before dotenv.config() when available.
        marker = "dotenv.config();"
        pos = server.find(marker)
        if pos < 0:
            raise RuntimeError("dotenv.config() marker not found for V8.1 import insertion")
        server = server[:pos] + 'import { loadCityPackagesResilient } from "./cityCoverageV8_1.js";\n\n' + server[pos:]

    # Replace the old all-or-nothing city loader. SectionLink stays optional.
    rx = re.compile(
        r'async\s+function\s+loadCityLivePackages\s*\(cities\)\s*\{.*?\n\}\n\n(?=function\s+roundNumber)',
        re.S,
    )
    matches = list(rx.finditer(server))
    if len(matches) != 1:
        raise RuntimeError(f"loadCityLivePackages expected exactly 1 match, found {len(matches)}")

    replacement = r'''async function loadCityLivePackages(cities) {
  const { packages } = await loadCityPackagesResilient({
    cities,
    getShape: getCitySectionShapes,
    getLink: getCitySectionLinks,
    getLive: getCityLiveTraffic,
    buildPackage: buildCityObservedSections,
    // Network-resilience timeout only. This never changes ETA values.
    // It guarantees that one unsupported/slow jurisdiction cannot erase
    // already-usable city traffic from other jurisdictions on the route.
    perScopeTimeoutMs: 5500,
    logger: console,
  });

  return packages;
}

'''
    server = server[:matches[0].start()] + replacement + server[matches[0].end():]

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

print("ETA V8.1 PARTIAL CITY COVERAGE INSTALLED")
print("- one slow/unsupported city can no longer zero out all city packages")
print("- successful jurisdictions are preserved independently")
print("- SectionLink remains optional")
print("- no ETA multiplier or guessed delay added")
