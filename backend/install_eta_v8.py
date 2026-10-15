#!/usr/bin/env python3
from pathlib import Path
from datetime import datetime
import re
import shutil
import subprocess
import sys

ROOT = Path.cwd()
BUNDLE = Path(__file__).resolve().parent
SERVER = ROOT / "server.js"
ENGINE = ROOT / "tdxEtaEngine.js"
CLIENT = ROOT / "tdxClient.js"
EVIDENCE = ROOT / "etaEvidenceV6.js"
TEST = ROOT / "testEtaV8.js"
README = ROOT / "ETA_V8_README.txt"

for path in (SERVER, ENGINE, CLIENT, EVIDENCE):
    if not path.exists():
        raise SystemExit(f"PATCH FAILED: missing required file: {path}")

server = SERVER.read_text(encoding="utf-8")
engine = ENGINE.read_text(encoding="utf-8")
client = CLIENT.read_text(encoding="utf-8")
evidence = EVIDENCE.read_text(encoding="utf-8")

checks = [
    (server, 'from "./routeJurisdictionV7.js"', "V7 jurisdiction architecture is missing"),
    (engine, "classifyUncoveredCandidateV7_2", "V7.2 coverage diagnostics are missing"),
    (evidence, "ETA_EVIDENCE_V6_2_DEFAULT_THRESHOLD_FIX", "V6.2 evidence guard is missing"),
    (client, "getFreewayLiveTraffic", "TDX client does not contain freeway live traffic"),
]
for text, marker, message in checks:
    if marker not in text:
        raise SystemExit(f"PATCH FAILED: {message}")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backups = {}
for path in (SERVER, ENGINE, CLIENT):
    backup = path.with_name(f"{path.stem}.before-eta-v8-{stamp}{path.suffix}")
    shutil.copy2(path, backup)
    backups[path] = backup
    print("Backup:", backup)


def restore_all():
    for target, backup in backups.items():
        if backup.exists():
            shutil.copy2(backup, target)


def copy_if_needed(src, dst):
    src = Path(src).resolve()
    dst = Path(dst).resolve()
    if src != dst:
        shutil.copy2(src, dst)


def node_check(path):
    r = subprocess.run(["node", "--check", str(path)], text=True, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"node --check failed for {path.name}:\n{r.stderr}")

try:
    # --------------------------------------------------------------
    # 1) Canonical freeway/highway geometry engine.
    # --------------------------------------------------------------
    copy_if_needed(BUNDLE / "tdxEtaEngine.v8.js", ENGINE)

    # --------------------------------------------------------------
    # 2) Add cached official Traffic static-section endpoints.
    # TDX Traffic documents Section + SectionShape for both Freeway
    # and Highway. These are static/cached and do not replace live data.
    # --------------------------------------------------------------
    client = CLIENT.read_text(encoding="utf-8")
    if "TDX_V8_CANONICAL_ROAD_STATIC" not in client:
        client += r'''

// =========================================================
// ETA V8 — canonical Freeway/Highway published-section geometry
// =========================================================
export const TDX_V8_CANONICAL_ROAD_STATIC = true;
const ROAD_SECTION_STATIC_CACHE_MS_V8 = 6 * 60 * 60 * 1000;

async function getRoadTrafficStaticV8(application, scope) {
  const url =
    `https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/${application}/${scope}` +
    `?%24format=JSON`;
  console.log(`[TDX] ${application}/${scope}:`, url);
  return await fetchTdxJson(url, {
    timeoutMs: 25000,
    cacheMs: ROAD_SECTION_STATIC_CACHE_MS_V8,
  });
}

export async function getFreewaySectionShapes() {
  return await getRoadTrafficStaticV8("SectionShape", "Freeway");
}

export async function getHighwaySectionShapes() {
  return await getRoadTrafficStaticV8("SectionShape", "Highway");
}

export async function getFreewaySections() {
  return await getRoadTrafficStaticV8("Section", "Freeway");
}

export async function getHighwaySections() {
  return await getRoadTrafficStaticV8("Section", "Highway");
}
'''
        CLIENT.write_text(client, encoding="utf-8")

    # --------------------------------------------------------------
    # 3) Server: import the four static loaders.
    # --------------------------------------------------------------
    server = SERVER.read_text(encoding="utf-8")
    wanted = [
        "getFreewaySectionShapes",
        "getHighwaySectionShapes",
        "getFreewaySections",
        "getHighwaySections",
    ]
    if not all(name in server for name in wanted):
        rx = re.compile(
            r'import\s*\{(?P<body>[^}]*\bgetFreewayLiveTraffic\b[^}]*)\}\s*from\s*["\']\./tdxClient\.js["\'];',
            re.S,
        )
        matches = list(rx.finditer(server))
        if len(matches) != 1:
            raise RuntimeError(
                f"TDX import block expected exactly 1 match, found {len(matches)}"
            )
        m = matches[0]
        body = m.group("body").rstrip()
        if body and not body.rstrip().endswith(","):
            body += ","
        addition = "\n" + "\n".join(f"  {name}," for name in wanted) + "\n"
        replacement = f'import {{{body}{addition}}} from "./tdxClient.js";'
        server = server[:m.start()] + replacement + server[m.end():]

    # --------------------------------------------------------------
    # 4) Load static road geometry once per route request. The client
    # cache makes subsequent requests local for six hours. Any endpoint
    # failure is non-fatal; V8 falls back to the existing OpenLR path.
    # --------------------------------------------------------------
    if "[TDX canonical road geometry]" not in server:
        road_index_rx = re.compile(
            r'(?P<indent>^[ \t]*)const\s+roadIndex\s*=\s*\n?[ \t]*buildTdxRoadIndex\(\{',
            re.M,
        )
        matches = list(road_index_rx.finditer(server))
        if len(matches) != 1:
            raise RuntimeError(
                f"roadIndex construction expected exactly 1 match, found {len(matches)}"
            )
        m = matches[0]
        indent = m.group("indent")
        block = f'''{indent}// ETA V8: official published SectionShape/Section metadata is the\n{indent}// canonical freeway/highway geometry. OpenLR remains a safe fallback.\n{indent}const roadStaticResults = await Promise.allSettled([\n{indent}  getFreewaySectionShapes(),\n{indent}  getHighwaySectionShapes(),\n{indent}  getFreewaySections(),\n{indent}  getHighwaySections(),\n{indent}]);\n\n{indent}const freewaySectionShapeData =\n{indent}  roadStaticResults[0].status === "fulfilled" ? roadStaticResults[0].value : null;\n{indent}const highwaySectionShapeData =\n{indent}  roadStaticResults[1].status === "fulfilled" ? roadStaticResults[1].value : null;\n{indent}const freewaySectionData =\n{indent}  roadStaticResults[2].status === "fulfilled" ? roadStaticResults[2].value : null;\n{indent}const highwaySectionData =\n{indent}  roadStaticResults[3].status === "fulfilled" ? roadStaticResults[3].value : null;\n\n'''
        server = server[:m.start()] + block + server[m.start():]

        call_rx = re.compile(
            r'(const\s+roadIndex\s*=\s*\n?[ \t]*buildTdxRoadIndex\(\{(?:(?!\}\);).)*?highwayData\s*:\s*highwayLiveTrafficData\s*,)(?P<middle>(?:(?!\}\);).)*?)(\bopenLrToPolyline\b)',
            re.S,
        )
        matches = list(call_rx.finditer(server))
        if len(matches) != 1:
            raise RuntimeError(
                f"buildTdxRoadIndex argument block expected exactly 1 match, found {len(matches)}"
            )
        m = matches[0]
        insertion = '''\n\n        freewaySectionShapeData,\n        highwaySectionShapeData,\n        freewaySectionData,\n        highwaySectionData,\n\n        '''
        server = server[:m.start(3)] + insertion + server[m.start(3):]

        # Add a direct diagnostic immediately after the roadIndex call.
        call_end_rx = re.compile(
            r'(const\s+roadIndex\s*=\s*\n?[ \t]*buildTdxRoadIndex\(\{(?:(?!\}\);).)*?\}\);)',
            re.S,
        )
        matches = list(call_end_rx.finditer(server))
        if len(matches) != 1:
            raise RuntimeError(
                f"roadIndex complete call expected exactly 1 match, found {len(matches)}"
            )
        m = matches[0]
        # Preserve the indentation of the const statement.
        first_line = m.group(1).splitlines()[0]
        indent = first_line[: len(first_line) - len(first_line.lstrip())]
        diagnostic = f'''\n\n{indent}console.log("[TDX canonical road geometry]",\n{indent}  roadIndex?.geometryDiagnostics || null\n{indent});'''
        server = server[:m.end()] + diagnostic + server[m.end():]

    SERVER.write_text(server, encoding="utf-8")

    copy_if_needed(BUNDLE / "testEtaV8.js", TEST)
    copy_if_needed(BUNDLE / "ETA_V8_README.txt", README)

    node_check(ENGINE)
    node_check(CLIENT)
    node_check(SERVER)

    test_run = subprocess.run(
        ["node", "--test", str(TEST)],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
    )
    if test_run.returncode != 0:
        raise RuntimeError("V8 tests failed:\n" + test_run.stdout + "\n" + test_run.stderr)
    print(test_run.stdout.rstrip())

except Exception as exc:
    restore_all()
    print(f"PATCH FAILED: {exc}", file=sys.stderr)
    raise SystemExit(1)

print("ETA V8 CANONICAL COVERAGE INSTALLED")
print("- Freeway/Highway SectionShape is now canonical geometry")
print("- RoadDirection metadata can orient canonical geometry")
print("- OpenLR remains fallback only when static SectionShape is unavailable")
print("- no traffic multiplier, no relaxed direction threshold, no fabricated delay")
