#!/usr/bin/env python3
"""TEMPORARY. Does the fixed fetch actually bring fixtures back?"""
import json

import build


def main() -> int:
    for gender in ("men", "women"):
        out, health = build.fetch_espn_fixtures(gender)
        print(f"::notice title=RESULT {gender}::{json.dumps(health)}", flush=True)
        soonest = sorted(out.items(), key=lambda kv: kv[1][0])[:4]
        for (a, b), (dt, comp) in soonest:
            print(f"::notice title=SAMPLE {gender}::{dt} {a} v {b} ({comp})", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
