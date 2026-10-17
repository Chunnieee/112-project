"""Download the Taiwan OSM extract and build local Valhalla routing tiles."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

import valhalla

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
URL = "https://download.geofabrik.de/asia/taiwan-latest.osm.pbf"


def native(name, *args):
    package = Path(valhalla.__file__).parent
    env = os.environ.copy()
    env["PATH"] = str(package.parent / "pyvalhalla.libs") + os.pathsep + env["PATH"]
    executable = package / "bin" / (name + (".exe" if os.name == "nt" else ""))
    subprocess.run([str(executable), *map(str, args)], check=True, env=env, cwd=DATA)


def md5_of(path):
    digest = hashlib.md5()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def obtain_pbf(pbf):
    """Return the MD5 of a verified Taiwan extract.

    Works offline when the user downloaded taiwan-latest.osm.pbf (and
    optionally taiwan-latest.osm.pbf.md5) into services/valhalla/data
    with a browser, e.g. when download.geofabrik.de times out from Python.
    """
    local_md5 = pbf.with_name(pbf.name + ".md5")
    if pbf.exists() and local_md5.exists():
        expected = local_md5.read_text(encoding="utf-8").split()[0]
        actual = md5_of(pbf)
        if actual != expected:
            raise RuntimeError(f"{pbf.name} does not match {local_md5.name}; download both again")
        print(f"Using downloaded extract, MD5 verified: {expected}", flush=True)
        return expected

    try:
        with urllib.request.urlopen(URL + ".md5", timeout=60) as response:
            expected = response.read().decode().split()[0]
    except OSError as error:
        if pbf.exists():
            actual = md5_of(pbf)
            print(f"Cannot reach Geofabrik ({error}); using existing {pbf.name} without checksum, MD5 {actual}", flush=True)
            return actual
        raise SystemExit(
            "\nCannot reach download.geofabrik.de from Python.\n"
            "Download these two files with your browser:\n"
            f"  {URL}\n  {URL}.md5\n"
            f"and put them in: {pbf.parent}\n"
            "Then run build_data.py again.\n"
        )

    existing = md5_of(pbf) if pbf.exists() else None
    if existing != expected:
        temp = pbf.with_suffix(".part")
        digest = hashlib.md5()
        with urllib.request.urlopen(URL, timeout=120) as response, temp.open("wb") as output:
            total = int(response.headers.get("Content-Length", 0))
            size = 0
            report_at = 0
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)
                if size >= report_at:
                    print(f"Download: {size // 1048576} / {total // 1048576} MiB", flush=True)
                    report_at += 32 * 1048576
        if digest.hexdigest() != expected:
            raise RuntimeError("Geofabrik checksum mismatch; rerun to download a consistent extract")
        temp.replace(pbf)
    print(f"Taiwan extract verified: MD5 {expected}", flush=True)
    return expected


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    tiles = DATA / "tiles"
    tiles.mkdir(exist_ok=True)
    pbf = DATA / "taiwan-latest.osm.pbf"
    expected = obtain_pbf(pbf)
    config = valhalla.get_config(tile_dir=tiles, tile_extract="", verbose=True)
    config["mjolnir"].update({
        "admin": str(DATA / "admin.sqlite"),
        "timezone": str(DATA / "tz_world.sqlite"),
        "concurrency": min(4, os.cpu_count() or 1),
    })
    config["httpd"]["service"]["listen"] = "tcp://127.0.0.1:8002"
    config["httpd"]["service"]["timeout_seconds"] = 30
    config["logging"]["color"] = False
    config_path = DATA / "valhalla.json"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    print("Building administrative boundaries...", flush=True)
    native("valhalla_build_admins", "-c", config_path, pbf)
    print("Building routing tiles...", flush=True)
    native("valhalla_build_tiles", "-c", config_path, pbf)
    (DATA / "build-info.json").write_text(json.dumps({
        "source": URL, "md5": expected, "valhalla": valhalla.__version__,
        "attribution": "OpenStreetMap contributors, ODbL 1.0; extract by Geofabrik",
    }, indent=2), encoding="utf-8")
    print("Taiwan routing graph is ready.", flush=True)


if __name__ == "__main__":
    main()
