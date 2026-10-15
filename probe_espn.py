#!/usr/bin/env python3
"""TEMPORARY. Find the request shape ESPN's scoreboard still accepts.

Every request the build makes comes back 400 Bad Request — not 403 (blocked) and not 404
(renamed), so the endpoint is there and it is the request it does not like. The build asks
for a 120-day `dates=YYYYMMDD-YYYYMMDD` window, and the one thing already known about this
API is that it caps the window. This sweeps the parameter space and reports what answers.

Results go out as workflow annotations, which survive into the run summary and the API."""
import json
import urllib.error
import urllib.request
from datetime import date, timedelta

BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
UA = {"User-Agent": "curl/8.4.0"}


def note(title: str, msg: str) -> None:
    print(f"::notice title={title}::{msg}", flush=True)


def ask(label: str, slug: str, query: str) -> int:
    url = f"{BASE}/{slug}/scoreboard" + (f"?{query}" if query else "")
    try:
        resp = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30)
        data = json.loads(resp.read())
        events = data.get("events") or []
        dates = sorted({(e.get("date") or "")[:10] for e in events})
        note(label, f"HTTP {resp.status} | {query or '(no query)'} | events={len(events)}"
                    + (f" | {dates[0]}..{dates[-1]}" if dates else ""))
        return len(events)
    except urllib.error.HTTPError as e:
        note(label, f"HTTP {e.code} {e.reason} | {query or '(no query)'}")
    except Exception as e:  # noqa: BLE001
        note(label, f"{type(e).__name__}: {e} | {query or '(no query)'}")
    return -1


def main() -> int:
    today = date.today()
    d = today.strftime("%Y%m%d")
    slug = "fifa.friendly"

    # Shape of the dates parameter.
    ask("A no dates", slug, "")
    ask("B single day", slug, f"dates={d}")
    ask("C month", slug, f"dates={today:%Y%m}")
    ask("D year", slug, f"dates={today:%Y}")

    # How wide a range it will still take, if any.
    for span in (1, 7, 14, 30, 45, 60, 90, 120):
        end = today + timedelta(days=span)
        ask(f"E range {span}d", slug, f"dates={d}-{end:%Y%m%d}")

    # A past window too: if ranges work backwards but not forwards, the problem is the
    # future dates, not the range syntax.
    past = today - timedelta(days=30)
    ask("F past 30d", slug, f"dates={past:%Y%m%d}-{d}")

    # And one other competition, to rule out a slug-specific answer.
    ask("G other slug", "uefa.nations", f"dates={d}")
    ask("H women slug", "fifa.friendly.w", f"dates={d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
