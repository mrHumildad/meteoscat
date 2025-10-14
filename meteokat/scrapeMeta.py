import json

with open("meta.json", "r", encoding="utf-8") as f:
    meta = json.load(f)

result = []
for codi, info in meta.items():
    entry = {
        "codi": codi,
        "nom": info.get("nom"),
        "altitud": info.get("altitud"),
        "comarca": info.get("comarca", {}).get("nom"),
        "coordenades": info.get("coordenades")
    }
    result.append(entry)

with open("stations.json", "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"Extracted {len(result)} entries to meta_extract.json")