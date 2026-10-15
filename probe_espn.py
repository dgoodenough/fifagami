#!/usr/bin/env python3
"""TEMPORARY. What does ESPN actually say when the refresh asks it?

Results go out as workflow annotations, which survive into the run summary and the API —
the logs themselves are served from a host some clients cannot reach."""
import json
import urllib.error
import urllib.request
from datetime import date, timedelta

import build


def note(title: str, msg: str) -> None:
    print(f"::notice title={title}::{msg}", flush=True)


def main() -> int:
    today = date.today()
    end = today + timedelta(days=120)
    url = ("https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.friendly"
           f"/scoreboard?dates={today:%Y%m%d}-{end:%Y%m%d}")

    # One raw request per user agent, reported verbatim: a 403 means they are blocking us,
    # a 200 with no events means the league slug has moved.
    for ua in ("curl/8.4.0", "Mozilla/5.0 (X11; Linux x86_64)", ""):
        headers = {"User-Agent": ua} if ua else {}
        try:
            resp = urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=30)
            data = json.loads(resp.read())
            league = (data.get("leagues") or [{}])[0].get("name")
            msg = (f"UA={ua!r} -> HTTP {resp.status}, league={league!r}, "
                   f"events={len(data.get('events') or [])}")
        except urllib.error.HTTPError as e:
            msg = f"UA={ua!r} -> HTTPError {e.code} {e.reason}"
        except Exception as e:  # noqa: BLE001
            msg = f"UA={ua!r} -> {type(e).__name__}: {e}"
        note("ESPN raw", msg)

    # Then the real thing, both genders, with the health record the build now keeps.
    for gender in ("men", "women"):
        out, health = build.fetch_espn_fixtures(gender)
        note(f"ESPN {gender}", json.dumps(health))
        for key, val in list(out.items())[:5]:
            note(f"ESPN {gender} sample", f"{key} {val}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
