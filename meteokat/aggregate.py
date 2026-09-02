#!/usr/bin/env python3
"""Aggregate raw Meteocat XEMA payloads into per-day, per-station summaries.

Why: previously the client (src/logic/refineData.js) statically imported the
full raw dataset (a ~15 MB JSON) inside the JS bundle. This script moves that
aggregation server-side and emits one small file per day:

    public/logic/daily/YYYY-MM-DD.json   -> { "<stationCodi>": {tempAvg, tempMin,
                                              tempMax, humAvg, humMin, humMax,
                                              precAcc}, ..., "dayStats": {...} }
    public/logic/daily/index.json        -> ["YYYY-MM-DD", ...] (oldest first)

The math mirrors src/logic/refineData.js exactly so swapping the client
import for a fetch of these files produces identical results:
  - hourly values are collected per station per day (nulls skipped)
  - precAcc = max of non-null 30-min precipitation readings (XEMA values are
    the running daily accumulation, so max == daily total)
  - averages are rounded to 1 decimal place
  - dayStats is the global aggregate across stations per day

Raw sources may be either a combined full_dades.json
({ day: { hour: { station: { var: val } } } }) or per-day dades_*.json files
({ hour: { station: { var: val } } }).

Usage:
    python aggregate.py                      # auto-detect raw source
    python aggregate.py --raw ../full_dades.json
    python aggregate.py --raw 'meteokat/dades_*.json'
"""
import argparse
import glob
import json
import re
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_STATIONS = SCRIPT_DIR.parent / "src" / "logic" / "stations.json"
DEFAULT_OUT = SCRIPT_DIR.parent / "public" / "logic" / "daily"

# candidates tried in order when --raw is not given
DEFAULT_RAW_CANDIDATES = [
    str(SCRIPT_DIR / "dades_*.json"),
    str(SCRIPT_DIR / "full_dades.json"),
    str(SCRIPT_DIR.parent / "full_dades.json"),
    str(SCRIPT_DIR.parent / "public" / "logic" / "full_dades.json"),
]

SUMMARY_VARS = ["temperatura", "humitat", "precipitacio"]


def safe_avg(values):
    """parseFloat((sum / count).toFixed(1)), null on empty.

    Uses ROUND_HALF_UP (ties away from zero) because that is what ECMA-262
    Number.prototype.toFixed does in practice, e.g.:
        (95.25).toFixed(1) -> "95.3";  (-95.25).toFixed(1) -> "-95.3"
    Python's format/round default to banker's rounding, which drifts ~0.1 on
    means ending in exactly .25/.75 (common for humidity).
    """
    if not values:
        return None
    mean = sum(values) / len(values)
    return float(Decimal(mean).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def safe_min(values):
    return min(values) if values else None


def safe_max(values):
    return max(values) if values else None


def load_raw_days(sources):
    """Return {'YYYY-MM-DD': {hour: {station: {var: val}}}} oldest-first."""
    files = []
    for src in sources:
        matches = glob.glob(src)
        files.extend(Path(m) for m in matches)
    # de-duplicate, keep order
    seen, unique = set(), []
    for f in files:
        if f.resolve() not in seen:
            seen.add(f.resolve())
            unique.append(f)
    if not unique:
        raise SystemExit(
            "No raw payloads found. Scraped data is expected as dades_*.json "
            "files or a full_dades.json. Pass --raw to point at them."
        )

    raw_days = {}
    for f in unique:
        data = json.loads(f.read_text(encoding="utf-8"))
        if not data:
            continue
        first_key = next(iter(data))
        if re.match(r"^\d{4}-\d{2}-\d{2}$", first_key):
            # combined payload: { day: { hour: { station: {...} } } }
            for day, hours in data.items():
                raw_days.setdefault(day, {}).update(hours or {})
        elif re.match(r"^\d{4}-\d{2}-\d{2}T", first_key):
            # single-day payload: { hour: { station: {...} } }
            day = first_key[:10]
            raw_days.setdefault(day, {}).update(data)
        else:
            raise SystemExit(f"Unrecognized payload shape in {f}")
    return dict(sorted(raw_days.items()))


def summarize_day(raw_hours, station_codes):
    """Per-station summary + dayStats for one day, mirroring refineData.js."""
    acc = {code: {var: [] for var in SUMMARY_VARS} for code in station_codes}
    for hour in raw_hours.values():
        for code, values in (hour or {}).items():
            per_station = acc.get(code)
            if per_station is None:
                continue  # station not in stations.json seed list (as in refineData)
            for var in SUMMARY_VARS:
                val = (values or {}).get(var)
                if val is not None:
                    per_station[var].append(val)

    summaries = {}
    for code, collected in acc.items():
        temp = collected["temperatura"]
        hum = collected["humitat"]
        prec = collected["precipitacio"]
        summaries[code] = {
            "tempAvg": safe_avg(temp),
            "tempMin": safe_min(temp),
            "tempMax": safe_max(temp),
            "humAvg": safe_avg(hum),
            "humMin": safe_min(hum),
            "humMax": safe_max(hum),
            "precAcc": safe_max(prec),
        }
    summaries["dayStats"] = _day_stats(summaries)
    return summaries


def _day_stats(summaries):
    temp_avgs = [s["tempAvg"] for s in summaries.values() if s["tempAvg"] is not None]
    temp_mins = [s["tempMin"] for s in summaries.values() if s["tempMin"] is not None]
    temp_maxs = [s["tempMax"] for s in summaries.values() if s["tempMax"] is not None]
    hum_avgs = [s["humAvg"] for s in summaries.values() if s["humAvg"] is not None]
    hum_mins = [s["humMin"] for s in summaries.values() if s["humMin"] is not None]
    hum_maxs = [s["humMax"] for s in summaries.values() if s["humMax"] is not None]
    prec_accs = [s["precAcc"] for s in summaries.values() if s["precAcc"] is not None]
    return {
        "tempAvg": safe_avg(temp_avgs),
        "tempMin": safe_min(temp_mins),
        "tempMax": safe_max(temp_maxs),
        "humAvg": safe_avg(hum_avgs),
        "humMin": safe_min(hum_mins),
        "humMax": safe_max(hum_maxs),
        "precAcc": sum(prec_accs),
        "precMin": 0,
        "precMax": safe_max(prec_accs),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--raw",
        action="append",
        help="Path or glob of raw payload(s); repeatable. Auto-detected if omitted.",
    )
    parser.add_argument(
        "--stations",
        default=str(DEFAULT_STATIONS),
        help=f"stations.json seed list (default: {DEFAULT_STATIONS})",
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help=f"output directory for daily shards (default: {DEFAULT_OUT})",
    )
    args = parser.parse_args()

    sources = args.raw or DEFAULT_RAW_CANDIDATES
    raw_days = load_raw_days(sources)
    if not raw_days:
        raise SystemExit("No usable days found in the raw payloads.")

    stations_data = json.loads(Path(args.stations).read_text(encoding="utf-8"))
    station_codes = [s["codi"] for s in stations_data]

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    for day, hours in raw_days.items():
        summaries = summarize_day(hours, station_codes)
        shard = out_dir / f"{day}.json"
        shard.write_text(
            json.dumps(summaries, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"{day}: {shard.stat().st_size // 1024} KB, "
              f"{len(summaries) - 1} stations")

    index = list(raw_days.keys())
    (out_dir / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"\nWrote {len(index)} day shards + index.json to {out_dir}")


if __name__ == "__main__":
    main()