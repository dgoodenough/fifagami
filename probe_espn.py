#!/usr/bin/env python3
"""TEMPORARY. How few requests can cover a two-year horizon?

Day ranges are dead (400 on every width, including one day). `dates=YYYYMM` and
`dates=YYYY` both answer, but the year query came back with exactly 100 events ending in
March, which smells like a cap. Monthly queries would work but cost 24 requests per
competition per build. This checks whether a coarser query can be made to carry the load."""
import json
import urllib.error
import urllib.request
from datetime import date

BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
UA = {"User-Agent": "curl/8.4.0"}


def ask(label: str, slug: str, query: str) -> None:
    url = f"{BASE}/{slug}/scoreboard" + (f"?{query}" if query else "")
    try:
        resp = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30)
        data = json.loads(resp.read())
        events = data.get("events") or []
        dates = sorted({(e.get("date") or "")[:10] for e in events})
        msg = (f"HTTP {resp.status} | {query or '(none)'} | events={len(events)}"
               + (f" | {dates[0]}..{dates[-1]}" if dates else ""))
    except urllib.error.HTTPError as e:
        msg = f"HTTP {e.code} {e.reason} | {query or '(none)'}"
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e} | {query or '(none)'}"
    print(f"::notice title={label}::{msg}", flush=True)


def main() -> int:
    y = date.today().year
    s = "fifa.friendly"
    ask("1 month range", s, f"dates={y}10-{y}12")
    ask("2 year range", s, f"dates={y}-{y + 1}")
    ask("3 year + limit", s, f"dates={y}&limit=1000")
    ask("4 month + limit", s, f"dates={y}10&limit=1000")
    ask("5 next year", s, f"dates={y + 1}")
    ask("6 next year limit", s, f"dates={y + 1}&limit=1000")
    ask("7 seasontype", s, f"dates={y}&seasontype=1&limit=1000")
    # Confirm the shape holds for the other competitions the build asks about.
    ask("8 uefa.nations", "uefa.nations", f"dates={y}&limit=1000")
    ask("9 womens friendly", "fifa.friendly.w", f"dates={y}&limit=1000")
    ask("10 wwc qualifying", "fifa.wworldq.uefa", f"dates={y}&limit=1000")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
