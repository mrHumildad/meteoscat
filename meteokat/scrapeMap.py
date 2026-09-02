import requests
import re
import json
import sys
import time

from datetime import datetime, timedelta

days_n = int(sys.argv[1]) if len(sys.argv) > 1 else 60
max_attempts = 3
base_url = "https://www.meteo.cat/observacions/xema?dia={date}"

today = datetime.now(datetime.utcnow().astimezone().tzinfo)
dates = [(today - timedelta(days=i)).strftime("%Y-%m-%dT00:00Z") for i in range(days_n)]
full_data = {}
failed = []

for date_str in dates:
    url = base_url.format(date=date_str)
    data = None
    # Meteocat occasionally drops a request; retry before giving up on a day
    # (a silent gap would survive until the next rolling-window run).
    for attempt in range(1, max_attempts + 1):
        print(f"Fetching: {url}" + (f" (attempt {attempt})" if attempt > 1 else ""))
        try:
            response = requests.get(url, timeout=30)
            text = response.text
        except Exception as e:
            print(f"  request error: {e}")
            time.sleep(2 * attempt)
            continue

        match = re.search(r"var\s+dades\s*=\s*(.*?);", text, re.DOTALL)
        if not match:
            print("  'dades' variable not found")
            time.sleep(2 * attempt)
            continue
        try:
            data = json.loads(match.group(1))
            break
        except Exception as e:
            print("  could not parse 'dades' as JSON:", e)
            time.sleep(2 * attempt)

    if data is None:
        failed.append(date_str[:10])
        print(f"  !! giving up on {date_str[:10]} after {max_attempts} attempts")
        continue
    full_data[date_str[:10]] = data

with open("full_dades.json", "w", encoding="utf-8") as f:
    json.dump(full_data, f, ensure_ascii=False, indent=2)

print(f"Saved {len(full_data)} days to full_dades.json")
if failed:
    print(f"WARNING: {len(failed)} day(s) failed and were skipped: {', '.join(failed)}")