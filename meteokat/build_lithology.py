#!/usr/bin/env python3
"""Build the substrate (lithology-family) grid used by the geology filter.

Input : the ICGC "Mapa geològic de Catalunya 1:50.000 v3.0" vector dataset
        (unit polygons, layer `_04_unitats_geologiques_50000`), distributed as
        a GeoPackage:

    https://datacloud.icgc.cat/datacloud/geologia-territorial-50000-geologic/gpkg/geologia-territorial-50000-geologic-v3r0-202412.zip

        Licence: CC BY 4.0 (attribution required in derived products).
        Download it once into meteokat/raw/ (gitignored). A fresh download is
        the only external dependency: everything else runs offline.

Output 1 (the app data file): public/logic/litho_grid.json
        A uniform lon/lat raster of "substrate families" at --res degrees
        (default 0.002, ~200 m). Each cell stores ONE family id (0 = no
        data). Rows run north→south; each row is run-length encoded as
        [[value, runLength], ...] so the client decodes O(cells). The JSON
        also embeds the family legend (id → key / Catalan label / colour) and
        build metadata, so the app's legend can never drift from the grid.

Output 2 (curation audit): meteokat/litho_units_audit.json
        Every distinct geological unit (codi) → assigned family + the reason
        (matched word / override / protolith fallback / unmatched). Use this
        to review and extend LITHO_OVERRIDES; the build is deterministic, so
        the audit doubles as the diffable record of the classification.

Why families instead of the 1055 raw units? The 50k map's legend is far too
detailed for a filter UI, and mushroom-relevant "soil type" is coarser than a
lithostratigraphic unit. Each unit's `Descripcio` (and, failing that, its
`Descripcio_protolit`) is classified into one of ~12 families below. Units
list their dominant lithology first, so the family of the EARLIEST matching
rock word in the description is used. `LITHO_OVERRIDES` pins the codi where
the text heuristic is wrong. This is a DRAFT taxonomy — review the audit and
the family labels/colours before shipping.

Usage:
    # venv with: fiona rasterio shapely  (see requirements-build.txt)
    python3 meteokat/build_lithology.py --map-only        # classify units only (fast)
    python3 meteokat/build_lithology.py                   # classify + rasterize + encode
    python3 meteokat/build_lithology.py --res 0.001       # finer grid (~100 m)
"""

import argparse
import json
import math
import sqlite3
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_GPKG = (
    REPO
    / "meteokat"
    / "raw"
    / "geo50k"
    / "geologia-territorial-50000-geologic-v3r0-202412.gpkg"
)
LAYER = "_04_unitats_geologiques_50000"
DEFAULT_OUT = REPO / "public" / "logic" / "litho_grid.json"
DEFAULT_AUDIT = REPO / "meteokat" / "litho_units_audit.json"
DEFAULT_RES = 0.002  # degrees, ~200 m cell

SOURCE_URL = (
    "https://datacloud.icgc.cat/datacloud/geologia-territorial-50000-geologic/"
    "gpkg/geologia-territorial-50000-geologic-v3r0-202412.zip"
)
PRODUCT = "Mapa geològic de Catalunya 1:50.000 v3.0 (des. 2024)"
PUBLISHER = "Institut Cartogràfic i Geològic de Catalunya (ICGC)"
LICENSE = "CC BY 4.0 (attribution required)"

# ---------------------------------------------------------------------------
# Family taxonomy — DRAFT, pending product sign-off.
# id → { key, label (Catalan), colour (hex, null = never painted) }
# 0 is reserved for "no data / unclassified" and is always transparent.
# ---------------------------------------------------------------------------
FAMILIES = {
    0: {"key": "nodata", "label": "Sense dades", "color": None},
    1: {"key": "quaternary", "label": "Dipòsits no consolidats (graves, sorres, llims, argiles)", "color": "#e3d47f"},
    2: {"key": "lutites", "label": "Lutites, argiles i limolites consolidades", "color": "#cfb678"},
    3: {"key": "gresos", "label": "Gresos i arenites", "color": "#bf8a4e"},
    4: {"key": "conglomerats", "label": "Conglomerats i bretxes", "color": "#9c6b3d"},
    5: {"key": "carbonatades", "label": "Calcàries, dolomies i margues (sòls bàsics)", "color": "#6a93cf"},
    6: {"key": "guixos", "label": "Guixos i evaporites", "color": "#b58bd8"},
    7: {"key": "granitoides", "label": "Granitoides i roques àcides filonianes (granits, pòrfirs)", "color": "#d8766b"},
    8: {"key": "plutoniques_basiques", "label": "Diorites, gabres i roques ultrabàsiques", "color": "#57a384"},
    9: {"key": "volcaniques", "label": "Volcàniques (basalts, andesites, dacites, riolites)", "color": "#8f4fc0"},
    10: {"key": "metamorfiques_baix", "label": "Metamòrfiques de grau baix (pissarres, fil·lites, esquistos)", "color": "#8295ad"},
    11: {"key": "metamorfiques_alt", "label": "Metamòrfiques de grau mitjà-alt (gneis, marbres, cornubianites, quarsites)", "color": "#5d6f8f"},
}
KEY_OF = {v["key"]: k for k, v in FAMILIES.items()}

# Rock-word stems per family. Text and stems are accent-normalised before
# matching; the FIRST rock word appearing in the description decides the
# family (unit names list the dominant lithology first). Stems are plain
# substrings — keep them specific enough not to bleed across families.
FAMILY_STEMS = {
    1: [  # unconsolidated quaternary detrital
        "grava", "graves", "sorra", "sorres", "llim", "llims", "còdol",
        "blocs", "bloc", "terrassa", "ventall", "col·luvial", "col-luvial",
        "al·luvial", "al-luvial", "peu de mont", "glacera", "morrena",
        "fons de vall", "llit actual", "dipòsit", "diposits", "fluvial",
        "dolina", "delta", "estuari", "platja", "duna", "torbera",
        "herbassar", "llacuna",
    ],
    2: ["lutit", "argil", "limolit", "fang", "fangs", "argilos", "llim", "llims"],
    3: ["gres", "arenit", "arenisc", "quarsifeldspàtic", "gresos"],
    4: ["conglomerat", "conglomeràtic", "bretxa", "bretxes", "bretxoid", "bretxiforme", "rudita", "rudites", "breix"],
    5: [
        "calcàr", "calissa", "calisses", "dolomi", "marga", "margu", "margo",
        "carniola", "carnioles", "calitx", "travert", "lumaquel", "carbonat",
        "albarí", "calcari", "calcita",
    ],
    6: ["guix", "salin"],
    7: [
        "granit", "granodiorit", "monzogranit", "tonalit", "leucogranit",
        "aplita", "aplit", "pegmatit", "pòrfir", "porfir", "porfídic",
        "quarsodiorit", "sienit", "adamel·lit", "granofir",
    ],
    8: [
        "gabre", "gabr", "diorit", "norit", "anortosit", "peridotit",
        "ultramàfic", "ultrabàsic", "serpentinit", "ofit", "diabas",
        "lampròfir", "lamprofir",
    ],
    9: [
        "basalt", "basàltic", "andesit", "dacit", "riodacit", "riolit",
        "traquit", "fonolit", "colada", "colades", "piroclast", "lapil",
        "tova", "toves", "vulcanoclas", "vulcanit", "volcàn", "ignimbrit",
        "bomba volcànica", "lava", "laves", "vidre",
    ],
    10: ["pissarr", "fil·lit", "fil-lit", "esquist", "metapelit", "pelit"],
    11: [
        "gneis", "gneiss", "migmatit", "cornubianit", "cornian", "marb",
        "marmor", "quarsit", "amfibolit", "skarn", "granulit", "eclogit",
        "lidit",
    ],
}

# Manual pins: codi → family id, used where the description text heuristic is
# known to misclassify (e.g. altered-rock facies whose description names the
# alteration product instead of the rock). Extend from the audit.
LITHO_OVERRIDES = {
    "Dlva": KEY_OF["volcaniques"],      # fàcies desvitrivicada-argil·lificada (roca volcànica alterada)
    "ff": 0,                            # farina de falla — no lithology of its own
    "bf": 0,                            # cataclasita — fault gouge, no lithology of its own
    "Fq": KEY_OF["granitoides"],       # filons de quars — filons àcids silícics
    "Fbc": KEY_OF["carbonatades"],     # filons de barita, calcita i fluorita
    "To": KEY_OF["plutoniques_basiques"],  # ofites (dolerites triàsiques)
    "Fla": KEY_OF["plutoniques_basiques"], # filons de lampròfirs (màfics)
    "Fd": KEY_OF["plutoniques_basiques"],  # dics de diàbasi
    "EÇOra": KEY_OF["plutoniques_basiques"],  # roques ígnies bàsiques
    "EÇOrvc1": KEY_OF["volcaniques"],    # (cobert pel stem vulcanoclas; mantingut per robustesa)
    "CPd": KEY_OF["volcaniques"],      # roques vulcanoclàstiques i carbons
    "POl": KEY_OF["lutites"],          # lignits (clapes carbonoses dins lutites)
    "CK": KEY_OF["carbonatades"],      # unitat sintètica (Cretaci, majoritàriament carbonatat)
}

CLASSIFIER_VERSION = "draft-1"


def norm(s):
    """Lower-case + strip diacritics (keep the Catalan middle dot)."""
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(ch for ch in s if not unicodedata.combining(ch))


def earliest_word(text, family_ids):
    """(family_id, stem) of the family whose stem appears EARLIEST in `text`,
    or (None, None)."""
    best_i = len(text) + 1
    best = (None, None)
    for fid in family_ids:
        for stem in FAMILY_STEMS[fid]:
            i = text.find(norm(stem))
            if i != -1 and i < best_i:
                best_i = i
                best = (fid, stem)
    return best


def classify(codi, descripcio, protolit):
    """Return (family_id, reason, matched_stem) for one geological unit."""
    if codi in LITHO_OVERRIDES:
        return LITHO_OVERRIDES[codi], "override", codi
    text = norm(descripcio)
    fid, stem = earliest_word(text, list(FAMILY_STEMS))
    if fid is not None:
        return fid, "desc", stem
    # Fallback: metamorphic/igneous units sometimes describe only the
    # overprint; the protolith names the parent rock.
    if protolit:
        pt = norm(protolit)
        fid2, stem2 = earliest_word(pt, list(FAMILY_STEMS))
        if fid2 is not None:
            return fid2, "protolit", stem2
    return 0, "unmatched", None


# ---------------------------------------------------------------------------
# Phase 1 — classify every distinct unit (fast, sqlite-only).
# ---------------------------------------------------------------------------
def read_units(gpkg):
    con = sqlite3.connect(f"file:{gpkg}?mode=ro", uri=True)
    try:
        rows = con.execute(
            f'SELECT DISTINCT Codi, Ordre, Descripcio, Descripcio_protolit '
            f'FROM "{LAYER}"'
        ).fetchall()
    finally:
        con.close()
    units = []
    for codi, ordre, desc, proto in rows:
        fid, reason, term = classify(codi, desc, proto)
        units.append(
            {
                "codi": codi,
                "ordre": ordre,
                "desc": desc,
                "protolit": proto,
                "family": fid,
                "reason": reason,
                "term": term,
            }
        )
    units.sort(key=lambda u: (u["ordre"] if u["ordre"] is not None else 1 << 30, u["codi"]))
    return units


def write_audit(units, path):
    by_codi = {
        u["codi"]: {
            "ordre": u["ordre"],
            "family": u["family"],
            "key": FAMILIES[u["family"]]["key"],
            "reason": u["reason"],
            "term": u["term"],
            "desc": (u["desc"] or "")[:160],
        }
        for u in units
    }
    summary = {}
    for u in units:
        key = FAMILIES[u["family"]]["key"]
        summary[key] = summary.get(key, 0) + 1
    doc = {
        "product": PRODUCT,
        "publisher": PUBLISHER,
        "license": LICENSE,
        "sourceUrl": SOURCE_URL,
        "classifier": CLASSIFIER_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "families": {str(k): v for k, v in FAMILIES.items()},
        "summaryUnits": {k: summary.get(k, 0) for k in (v["key"] for v in FAMILIES.values())},
        "units": by_codi,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return summary


def print_summary(units, label=""):
    total = len(units)
    print(f"  distinct units: {total}{('  (' + label + ')') if label else ''}")
    counts = {}
    for u in units:
        counts[u["family"]] = counts.get(u["family"], 0) + 1
    for fid in sorted(counts):
        f = FAMILIES[fid]
        print(f"    {fid:2d} {f['key']:20s} {counts[fid]:4d} units")
    unm = [u["codi"] for u in units if u["family"] == 0 and u["reason"] == "unmatched"]
    if unm:
        print(f"  UNMATCHED ({len(unm)}): {', '.join(unm)}")


# ---------------------------------------------------------------------------
# Phase 2 — rasterize families onto the lon/lat grid + RLE-encode.
# ---------------------------------------------------------------------------
def reproject_to_4326(geom, xf):
    """Reproject a GeoJSON geometry dict from EPSG:25831 to EPSG:4326 with a
    single pre-built pyproj Transformer (avoids per-feature setup costs)."""
    def walk(node):
        if isinstance(node, (list, tuple)):
            if node and isinstance(node[0], (int, float)):
                return list(xf.transform(node[0], node[1]))
            return [walk(child) for child in node]
        return node
    return {"type": geom["type"], "coordinates": walk(geom["coordinates"])}


def build_grid(gpkg, res, out_path, audit_path, units=None, max_features=None):
    import numpy as np
    import fiona
    from pyproj import Transformer
    from rasterio.features import bounds as geom_bounds, rasterize
    from rasterio.transform import Affine

    if units is None:
        units = read_units(gpkg)
    family_of = {u["codi"]: u["family"] for u in units}

    xf = Transformer.from_crs("EPSG:25831", "EPSG:4326", always_xy=True)
    t0 = time.time()
    shapes = []  # (geometry in EPSG:4326, family_id)
    minx, miny, maxx, maxy = math.inf, math.inf, -math.inf, -math.inf

    with fiona.open(gpkg, layer=LAYER) as src:
        n_total = len(src) if max_features is None else min(len(src), max_features)
        for i, feat in enumerate(src):
            if i >= n_total:
                break
            codi = feat["properties"].get("Codi")
            fid = family_of.get(codi, 0)
            if fid == 0:
                continue  # fault lines / unclassified: nothing to burn
            g = reproject_to_4326(feat["geometry"], xf)
            shapes.append((g, fid))
            x0, y0, x1, y1 = geom_bounds(g)
            minx, miny, maxx, maxy = min(minx, x0), min(miny, y0), max(maxx, x1), max(maxy, y1)
            if i and i % 10000 == 0:
                print(f"    reprojected {i}/{n_total} features "
                      f"({time.time() - t0:.0f}s)", file=sys.stderr, flush=True)
    print(f"  reprojected {n_total} features in {time.time() - t0:.1f}s", file=sys.stderr)

    if not shapes:
        raise SystemExit("No burnable features (all units unmatched?). Aborting.")

    west = math.floor(minx / res) * res
    north = math.ceil(maxy / res) * res
    cols = max(1, int(math.ceil((maxx - west) / res)))
    rows = max(1, int(math.ceil((north - miny) / res)))
    transform = Affine(res, 0.0, west, 0.0, -res, north)
    print(f"  grid: {cols} x {rows} cells @ {res}°  extent "
          f"lon [{minx:.4f}, {maxx:.4f}] lat [{miny:.4f}, {maxy:.4f}]", file=sys.stderr)

    t0 = time.time()
    arr = rasterize(
        shapes,
        out_shape=(rows, cols),
        transform=transform,
        fill=0,
        all_touched=False,
        dtype="uint8",
    )
    print(f"  rasterized in {time.time() - t0:.1f}s", file=sys.stderr)

    cell_counts = {}
    for fid, n in zip(*np.unique(arr, return_counts=True)):
        cell_counts[int(fid)] = int(n)

    # RLE per row: rows run north → south (row 0 = north).
    t0 = time.time()
    rle = []
    for y in range(rows):
        rowv = arr[y]
        idx = np.flatnonzero(np.r_[True, rowv[1:] != rowv[:-1], True])
        rle.append([[int(rowv[idx[k]]), int(idx[k + 1] - idx[k])] for k in range(len(idx) - 1)])
    print(f"  RLE-encoded in {time.time() - t0:.1f}s", file=sys.stderr)

    meta = {
        "product": PRODUCT,
        "publisher": PUBLISHER,
        "license": LICENSE,
        "sourceUrl": SOURCE_URL,
        "layer": LAYER,
        "classifier": CLASSIFIER_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "resolutionDeg": res,
        "approxCellM": round(res * 111320),
        "cells": cell_counts,
    }
    doc = {
        "cols": cols,
        "rows": rows,
        "west": west,
        "north": north,
        "step": res,
        "families": {str(k): v for k, v in FAMILIES.items()},
        "rle": rle,
        "meta": meta,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    out_path.write_text(raw, encoding="utf-8")
    print(f"\nWrote {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")

    write_audit(units, audit_path)
    print(f"Wrote {audit_path} (curation audit)")
    print_summary(units)
    print("  family cell share:", {FAMILIES[k]["key"]: v for k, v in sorted(cell_counts.items())})
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gpkg", default=str(DEFAULT_GPKG), help="path to the unit GeoPackage")
    ap.add_argument("--res", type=float, default=DEFAULT_RES,
                    help=f"grid cell size in degrees (default {DEFAULT_RES})")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output grid JSON")
    ap.add_argument("--audit", default=str(DEFAULT_AUDIT), help="output unit audit JSON")
    ap.add_argument("--map-only", action="store_true",
                    help="classify units and write the audit only (no rasterization)")
    ap.add_argument("--max-features", type=int, default=None,
                    help="limit the number of polygons processed (smoke test)")
    args = ap.parse_args()

    gpkg = Path(args.gpkg)
    if not gpkg.exists():
        raise SystemExit(
            f"GeoPackage not found: {gpkg}\n"
            f"Download it once from:\n  {SOURCE_URL}\n"
            f"and unzip into meteokat/raw/ (gitignored)."
        )

    units = read_units(gpkg)
    summary = write_audit(units, Path(args.audit))
    print_summary(units, "audit written")

    if args.map_only:
        return

    if args.res <= 0 or args.res >= 0.1:
        raise SystemExit(f"--res must be a small positive number of degrees (got {args.res})")
    build_grid(gpkg, args.res, Path(args.out), Path(args.audit), units=units,
               max_features=args.max_features)


if __name__ == "__main__":
    main()
