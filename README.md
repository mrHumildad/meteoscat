# MeteoSCat

Lightweight React + Vite app to visualise meteorological station averages on a MapLibre map.

Quick start
- npm ci
- npm run dev
- npm run build
- npm run preview

Deploy (GitHub Pages)
- Keep `vite.config.js` base = '/meteoscat/' for production.
- Put `public/logic/stations.geojson` before build so Vite copies it to `dist/logic/stations.geojson`.
- Use `gh-pages` or GitHub Actions to publish `dist`.

How it works (short)
- Select a day range in the calendar.
- App computes per-station average for the chosen variable and sets `properties.avg` on the GeoJSON.
- Map reads `properties.avg` for color and the numeric label inside the circle.

Scraper (short)
- Run this to fetch `dades` from meteocat for the last 30 days and save JSON.

```python
# filepath: /home/mbridas/Dev/python/meteoSCat/meteokat/scrapeMap.py
import requests, re, json
from datetime import datetime, timedelta

base = 'https://www.meteo.cat/observacions/xema?dia={}'
today = datetime.utcnow()
out = {}

for i in range(30):
    d = (today - timedelta(days=i)).strftime('%Y-%m-%dT00:00Z')
    print('fetch', d)
    r = requests.get(base.format(d))
    m = re.search(r'var\s+dades\s*=\s*(\{.*?\});', r.text, re.S)
    if not m:
        continue
    try:
        out[d[:10]] = json.loads(m.group(1))
    except Exception as e:
        print('parse error', d, e)

# save to public so Vite copies it
with open('public/logic/stations_raw.json', 'w', encoding='utf8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
```

Notes
- Keep the final GeoJSON used by the app at `public/logic/stations.geojson`.
- For GH Pages use a public map style (no API key) or host your own style/tiles.
