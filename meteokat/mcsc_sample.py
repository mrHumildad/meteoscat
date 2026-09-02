#!/usr/bin/env python3
"""Sample the ICGC/CREAF MCSC land-cover map at each XEMA station.

For every station in src/logic/stations.json, queries the ICGC WMS
"cobertes-sol" layer "cobertes_2024" via GetFeatureInfo and records the MCSC
land-cover class plus a coarse forestType used by the mushroom scoring engine:

    forest_conif       221/225  Boscos densos/clars d'aciculifolis (pines, fir)
    forest_decid       222/226  Boscos densos/clars de caducifolis (oak, beech)
                        229     Bosc de ribera (riparian deciduous)
    forest_sclerophyll 223/227  Boscos densos/clars d'esclerofil·les (alzina,
                                surera)
    null                     all other classes (conreus, matollar, prats,
                             urban, water, burned, bare, rocks, ...)

Codes follow the official MCSC v1.0 legend, "Classificació - Taules 1-4":
    https://datacloud.ide.cat/especificacions/cobertes-sol-v1r0-esp-01ca-20160919.pdf

Data source: Mapa de Cobertes del Sòl de Catalunya (MCSC) v1.0 —
Institut Cartogràfic i Geològic de Catalunya (ICGC) i CREAF.
Licence CC BY 4.0 — attribution required in derived products.

Method: each station is sampled at 5 points (centre + 4 offsets of ~60 m)
and the modal class wins. The WMS raster sample flips between adjacent cells
near edges, so a single query is unreliable; the vote smooths that out.
Requests are sequential with a short delay to stay polite to the service.

Output (public/logic/forest_types.json):
    { "<codi>": { "mcscClass": "221",
                  "mcscName": "Boscos densos d'aciculifolis",
                  "forestType": "forest_conif",
                  "sampleCount": 5 },
      "_meta": { "source": "...", "license": "CC BY 4.0", ... } }

Usage:
    python3 meteokat/mcsc_sample.py          # all stations
    python3 meteokat/mcsc_sample.py --max 5  # first 5 stations (smoke test)
"""
import argparse
import json
import math
import re
import sys
import time
from collections import Counter
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_STATIONS = SCRIPT_DIR.parent / "src" / "logic" / "stations.json"
DEFAULT_OUT = SCRIPT_DIR.parent / "public" / "logic" / "forest_types.json"

WMS_URL = "https://geoserveis.icgc.cat/servei/catalunya/cobertes-sol/wms"
DEFAULT_LAYER = "cobertes_2024"

# MCSC v1.0 — Nivell 2 codes (from the official spec, annex A)
# (code): (official name, coarse forestType, level-1 group)
MCSC_LEGEND = {
    # Grup 1 — Àrees agrícoles
    "111": ("Conreus herbacis", None, "agricultural"),
    "112": ("Horta, vivers i conreus forçats", None, "agricultural"),
    "113": ("Vinyes", None, "agricultural"),
    "114": ("Oliverars", None, "agricultural"),
    "115": ("Altres conreus llenyosos", None, "agricultural"),
    "116": ("Conreus en transformació", None, "agricultural"),
    # Grup 2 — Àrees forestals i naturals
    "221": ("Boscos densos d'aciculifolis", "forest_conif", "forest_needle"),
    "222": ("Boscos densos de caducifolis, planifolis", "forest_decid", "forest_broad"),
    "223": ("Boscos densos d'esclerofil·les i laurifolis", "forest_sclerophyll", "forest_sclerophyll"),
    "224": ("Matollar", None, "shrubland"),
    "225": ("Boscos clars d'aciculifolis", "forest_conif", "forest_needle"),
    "226": ("Boscos clars de caducifolis, planifolis", "forest_decid", "forest_broad"),
    "227": ("Boscos clars d'esclerofil·les i laurifolis", "forest_sclerophyll", "forest_sclerophyll"),
    "228": ("Prats i herbassars", None, "grassland"),
    "229": ("Bosc de ribera", "forest_decid", "riparian"),
    "230": ("Sòl nu forestal", None, "bare"),
    "231": ("Zones cremades", None, "burned"),
    "232": ("Roquissars i congestes", None, "rock"),
    "233": ("Platges", None, "beach"),
    "234": ("Zones humides", None, "wetland"),
    # Grup 3 — Àrees urbanitzades
    **{str(c): (name, None, "urban") for c, name in {
        341: "Casc urbà", 342: "Eixample", 343: "Zones urbanes laxes",
        344: "Edificacions aïllades en l'espai rural", 345: "Àrees residencials aïllades",
        346: "Zones verdes", 347: "Zones industrials, comercials i/o de serveis",
        348: "Zones esportives i de lleure", 349: "Zones d'extracció minera i/o abocadors",
        350: "Zones en transformació", 351: "Xarxa viària", 352: "Sòl nu urbà",
        353: "Zones aeroportuàries", 354: "Xarxa ferroviària", 355: "Zones portuàries",
    }.items()},
    # Grup 4 — Masses d'aigua
    "461": ("Embassaments", None, "water"),
    "462": ("Llacs i llacunes", None, "water"),
    "463": ("Cursos d'aigua", None, "water"),
    "464": ("Basses", None, "water"),
    "465": ("Canals artificials", None, "water"),
    "466": ("Mar", None, "water"),
    # Sense dades / outside the map (e.g. marine sensors off the coast)
    "0": ("Sense dades", None, "nodata"),
}

CLASS_RE = re.compile(r"^(\d+)\.\s*\(\d+\)\s*(.+)$")


def sample_points(lon, lat, offset_m=60.0):
    """Centre + N/E/S/W offsets of ~offset_m, (lon, lat) tuples."""
    dlat = offset_m / 110574.0
    dlon = offset_m / (111320.0 * max(math.cos(math.radians(lat)), 0.2))
    return [
        (lon, lat),
        (lon, lat + dlat),
        (lon + dlon, lat),
        (lon, lat - dlat),
        (lon - dlon, lat),
    ]


def query_class(session, lon, lat, layer, timeout=20):
    """GetFeatureInfo at the exact point (11x11 px window centred on it)."""
    span = 0.001  # ~110 m half-width; 11 px => ~19 m cell near the point
    bbox = f"{lon - span:.6f},{lat - span:.6f},{lon + span:.6f},{lat + span:.6f}"
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetFeatureInfo",
        "LAYERS": layer,
        "QUERY_LAYERS": layer,
        "STYLES": "",
        "CRS": "CRS:84",
        "BBOX": bbox,
        "WIDTH": "11",
        "HEIGHT": "11",
        "X": "5",
        "Y": "5",
        "INFO_FORMAT": "text/plain",
    }
    r = session.get(WMS_URL, params=params, timeout=timeout)
    r.raise_for_status()
    m = re.search(r"class = '(.+)'", r.text)
    if not m:
        return None
    cm = CLASS_RE.match(m.group(1).strip())
    return cm.group(1) if cm else None


def sample_station(session, lon, lat, layer, offset_m, sleep_s):
    codes = []
    for p_lon, p_lat in sample_points(lon, lat, offset_m):
        for attempt in (1, 2):
            try:
                code = query_class(session, p_lon, p_lat, layer)
                break
            except requests.RequestException:
                code = None
                time.sleep(0.5)  # brief backoff before retry
        if code:
            codes.append(code)
        time.sleep(sleep_s)
    return codes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stations", default=str(DEFAULT_STATIONS),
                        help=f"stations.json with coords (default: {DEFAULT_STATIONS})")
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help=f"output JSON (default: {DEFAULT_OUT})")
    parser.add_argument("--layer", default=DEFAULT_LAYER,
                        help=f"WMS layer (default: {DEFAULT_LAYER})")
    parser.add_argument("--max", type=int, default=None,
                        help="sample only the first N stations (smoke test)")
    parser.add_argument("--offset", type=float, default=60.0,
                        help="vote offset in metres (default: 60)")
    parser.add_argument("--sleep", type=float, default=0.05,
                        help="seconds between WMS requests (default: 0.05)")
    args = parser.parse_args()

    stations = json.loads(Path(args.stations).read_text(encoding="utf-8"))
    if args.max:
        stations = stations[: args.max]
    print(f"Sampling MCSC '{args.layer}' at {len(stations)} stations, "
          f"5 samples each (offset {args.offset:.0f} m) …", file=sys.stderr)

    session = requests.Session()
    session.headers["User-Agent"] = "boletscat-mcsc-sampler/0.1 (meteoscat tooling)"

    result = {}
    unknown = Counter()
    for i, st in enumerate(stations, 1):
        code = st["codi"]
        coords = (st.get("coordenades") or {})
        lon, lat = coords.get("longitud"), coords.get("latitud")
        if lon is None or lat is None:
            result[code] = {"mcscClass": None, "mcscName": None,
                            "forestType": None, "sampleCount": 0, "note": "missing coords"}
            continue
        samples = sample_station(session, float(lon), float(lat),
                                 args.layer, args.offset, args.sleep)
        if samples:
            winner, count = Counter(samples).most_common(1)[0]
        else:
            winner, count = None, 0

        if winner in MCSC_LEGEND:
            name, forest_type, group = MCSC_LEGEND[winner]
        else:
            name, forest_type, group = (None, None, None)
            unknown[winner] += 1
            print(f"  ! unknown MCSC class {winner} at {code}", file=sys.stderr)

        result[code] = {
            "mcscClass": winner,
            "mcscName": name,
            "forestType": forest_type,
            "sampleCount": count,
        }
        if i % 25 == 0 or i == len(stations):
            print(f"  {i}/{len(stations)} done", file=sys.stderr)

    result["_meta"] = {
        "source": "Mapa de Cobertes del Sòl de Catalunya (MCSC) v1.0",
        "publisher": "Institut Cartogràfic i Geològic de Catalunya (ICGC) i CREAF",
        "license": "CC BY 4.0 (attribution required)",
        "layer": args.layer,
        "wms": WMS_URL,
        "legendSpec": "https://datacloud.ide.cat/especificacions/cobertes-sol-v1r0-esp-01ca-20160919.pdf",
        "method": "GetFeatureInfo, 5-point majority vote (centre + ~60 m offsets)",
        "sampledAt": time.strftime("%Y-%m-%d"),
        "stations": len(stations),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")

    dist = Counter(v["forestType"] for v in result.values()
                   if isinstance(v, dict) and v.get("mcscClass"))
    print(f"\nWrote {out_path}", file=sys.stderr)
    print(f"forestType distribution: {dict(dist)}", file=sys.stderr)
    if unknown:
        print(f"TODO: add {len(unknown)} unknown class(es) to MCSC_LEGEND", file=sys.stderr)


if __name__ == "__main__":
    main()