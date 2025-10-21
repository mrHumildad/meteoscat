import requests
import re
import json
from datetime import datetime, timedelta

base_url = 'https://www.meteo.cat/observacions/xema?dia={date}'

today = datetime.now(datetime.utcnow().astimezone().tzinfo)
dates = [(today - timedelta(days=i)).strftime('%Y-%m-%dT00:00Z') for i in range(30)]
full_data = {}

for date_str in dates:
    url = base_url.format(date=date_str)
    print(f"Fetching: {url}")
    response = requests.get(url)
    text = response.text

    # Extract 'dades'
    match = re.search(r'var\s+dades\s*=\s*(.*?);', text, re.DOTALL)
    if match:
        data_str = match.group(1)
        try:
            data = json.loads(data_str)
            full_data[date_str[:10]] = data
            """ with open(f"dades_{date_str[:10]}.json", "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"Saved 'dades' to dades_{date_str[:10]}.json") """
        except Exception as e:
            print("Could not parse 'dades' as JSON:", e)
    else:
        print("'dades' variable not found")
""" for date_str in dates:
    hours = full_data[date_str[:10]].keys()
    for hour in hours:
        full_data[date_str[:10]['stations']] """

    #print(f"Date: {date_str[:10]}, Hours: {list(hours)}")
with open("full_dades.json", "w", encoding="utf-8") as f:
    json.dump(full_data, f, ensure_ascii=False, indent=2)
print("Saved all 'dades' to full_dades.json")