#!/usr/bin/env python3
"""Bursa Strategy Terminal snapshot publisher.

This file deliberately DOES NOT alter any screening rule.

The Trending, Gaining Momentum and M.E.T.A. checks are imported directly from
the upstream BursaMusangKing repository exactly as before.

Modes
-----
Official (default):
    Uses the newest Bursa trade date available from the feed, processes every
    valid symbol that has a bar on that date, and publishes strategy state.

Preview (--preview):
    Uses the exact same screeners on the current/latest partial daily bars, but
    publishes to /api/preview only. It never changes official positions,
    events, trades, performance or daily run history.

There is no fixed 900-stock acceptance threshold. Bursa counters with no bar
on the selected date are treated as stale/non-trading for that run and are
left unchanged in the official state engine.
"""

import json
import math
import os
import sys
from collections import Counter
from datetime import datetime, timezone

import requests
import upstream

STRATEGIES = ("trending", "gaining_momentum", "meta_leader")
ATR_MULT = float(os.environ.get("TRAIL_ATR_MULT", "3.0"))
MIN_OFFICIAL_COVERAGE_RATIO = float(os.environ.get("MIN_OFFICIAL_COVERAGE_RATIO", "0.50"))


def num(v):
    try:
        x = float(v)
        return x if x == x and abs(x) != float("inf") else None
    except Exception:
        return None


def date_key(v):
    return str(v)[:10]


def choose_trade_date(data, preview, screened):
    """Choose the feed date without imposing a fixed stock-count threshold.

    Preview:
        Always use the newest date seen, because it is deliberately a rough
        intraday view.

    Official:
        Use the newest date represented by at least 50% (configurable) of the
        successfully fetched universe. This protects against one or a handful
        of erroneous/future-dated bars while still accommodating illiquid
        Bursa counters that do not print a bar every day.
    """
    latest_dates = []
    for raw in data.values():
        if raw is not None and len(raw):
            latest_dates.append(date_key(raw.index[-1]))

    if not latest_dates:
        raise RuntimeError("market feed returned no dated bars")

    counts = Counter(latest_dates)

    if preview:
        return max(counts), counts, 1

    ratio = max(0.05, min(1.0, MIN_OFFICIAL_COVERAGE_RATIO))
    required = max(1, math.ceil(screened * ratio))
    eligible = [d for d, count in counts.items() if count >= required]

    if not eligible:
        recent = sorted(counts.items(), reverse=True)[:8]
        raise RuntimeError(
            f"official coverage guard: no date has >= {required}/{screened} "
            f"latest bars ({ratio:.0%}); recent={recent}"
        )

    return max(eligible), counts, required


def run(preview=False, publish=True):
    eng = upstream.engine()
    cfg = eng["config"]
    fetcher = eng["data_fetcher"]
    ind = eng["indicators"]
    scr = eng["screener"]

    data = fetcher.fetch_market()
    screened = len(data)
    if screened <= 0:
        raise RuntimeError("market feed returned zero usable symbols")

    names = {}
    try:
        upstream.ensure()
        import universe
        u = universe.get_universe()
        if "description" in u.columns:
            names = {
                str(r["symbol"]): str(r["description"])
                for _, r in u.iterrows()
                if r.get("description") == r.get("description")
            }
    except Exception as exc:
        print("name lookup warning:", exc)

    trade_date, date_counts, required_coverage = choose_trade_date(data, preview, screened)
    current_histories = int(date_counts.get(trade_date, 0))

    rows = []
    stale = 0
    bad = 0

    for symbol, raw in data.items():
        try:
            if raw is None or not len(raw) or date_key(raw.index[-1]) != trade_date:
                stale += 1
                continue

            e = ind.enrich(raw)
            if e is None or len(e) < 220:
                bad += 1
                continue

            i = len(e) - 1
            row = e.iloc[i]

            o = num(row.get("open"))
            l = num(row.get("low"))
            c = num(row.get("close"))
            a = num(row.get("atr"))
            if not all(x is not None and x > 0 for x in (o, l, c, a)):
                bad += 1
                continue

            previous_close = num(e.iloc[i - 1].get("close")) if i > 0 else None
            change_pct = (
                (c / previous_close - 1.0) * 100.0
                if previous_close is not None and previous_close > 0
                else None
            )

            hits = {}
            for strategy in STRATEGIES:
                p = cfg.STRATEGIES.get(strategy)
                check = scr.CHECKS.get(strategy)
                try:
                    hits[strategy] = bool(p and check and check(e, i, p))
                except Exception:
                    hits[strategy] = False

            rows.append(
                {
                    "symbol": symbol,
                    "name": names.get(symbol, ""),
                    "open": o,
                    "low": l,
                    "close": c,
                    "atr": a,
                    "change_pct": change_pct,
                    "vol_ratio": num(row.get("vol_ratio")),
                    "hits": hits,
                }
            )
        except Exception:
            bad += 1

    if not rows:
        raise RuntimeError(
            f"no valid rows for latest feed date {trade_date}; "
            f"screened={screened} stale={stale} bad={bad}"
        )

    # Keep validation on row integrity, not on an arbitrary universe count.
    invalid = []
    seen = set()
    for r in rows:
        sym = str(r.get("symbol") or "").strip()
        vals = (r.get("open"), r.get("low"), r.get("close"), r.get("atr"))
        if (
            not sym
            or not all(num(v) is not None and num(v) > 0 for v in vals)
            or sym in seen
        ):
            invalid.append((sym, vals))
            if len(invalid) >= 10:
                break
        seen.add(sym)

    if invalid:
        raise RuntimeError(f"preflight invalid outgoing rows: {invalid}")

    bt = cfg.BACKTEST
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "trade_date": trade_date,
        "stocks_screened": screened,
        "rows_current_date": len(rows),
        "histories_on_latest_date": current_histories,
        "stale_or_nontrading": stale,
        "bad_rows": bad,
        "mode": "preview" if preview else "official",
        "required_coverage": required_coverage if not preview else None,
        "official_coverage_ratio": MIN_OFFICIAL_COVERAGE_RATIO if not preview else None,
        "rows": rows,
        "params": {
            "atr_mult": ATR_MULT,
            "stop_loss_pct": float(bt.get("stop_loss_pct", -7)),
            "commission_pct": float(bt.get("commission_pct", 0)),
        },
        "strategies": list(STRATEGIES),
    }

    filename = "strategy_preview.json" if preview else "strategy_snapshot.json"
    with open(filename, "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    print(
        f"prepared mode={payload['mode']} date={trade_date} "
        f"rows={len(rows)}/{screened} latest_histories={current_histories} "
        f"stale={stale} bad={bad}"
    )

    if not publish:
        return payload

    base = os.environ["WORKER_URL"].rstrip("/")
    token = os.environ["PUBLISH_TOKEN"]
    headers = {"Authorization": "Bearer " + token}

    if preview:
        r = requests.post(
            base + "/api/preview",
            json=payload,
            headers=headers,
            timeout=180,
        )
        print("preview publish", r.status_code, r.text[:500])
        r.raise_for_status()
        res = r.json()
        if not res.get("ok"):
            raise RuntimeError(res)

        v = requests.get(
            base + "/api/preview",
            headers={"Cache-Control": "no-cache"},
            timeout=60,
        )
        v.raise_for_status()
        got = v.json().get("preview") or {}
        if (
            got.get("trade_date") != trade_date
            or got.get("generated_at") != payload["generated_at"]
        ):
            raise RuntimeError(f"preview verification mismatch: {got}")
        print("PREVIEW VERIFIED")
        return payload

    # Official run: do not overwrite an already accepted trade date.
    try:
        before = requests.get(
            base + "/api/health",
            headers={"Cache-Control": "no-cache"},
            timeout=60,
        )
        before.raise_for_status()
        last_run = (before.json().get("last_run") or {})
        if (
            last_run.get("trade_date") == trade_date
            and str(last_run.get("status") or "").upper() == "OK"
        ):
            print(
                f"SKIP PUBLISH: {trade_date} is already the latest "
                "successfully published official trade date"
            )
            return payload
    except Exception as exc:
        print("pre-publish health warning:", exc)

    r = requests.post(
        base + "/api/publish",
        json=payload,
        headers=headers,
        timeout=180,
    )
    print("official publish", r.status_code, r.text[:500])
    r.raise_for_status()
    res = r.json()
    if not res.get("ok"):
        raise RuntimeError(res)

    h = requests.get(
        base + "/api/health",
        headers={"Cache-Control": "no-cache"},
        timeout=60,
    )
    h.raise_for_status()
    health = h.json()
    if (health.get("last_run") or {}).get("trade_date") != trade_date:
        raise RuntimeError(f"publish verification mismatch: {health}")

    print("OFFICIAL VERIFIED", json.dumps(health, separators=(",", ":")))
    return payload


if __name__ == "__main__":
    is_preview = "--preview" in sys.argv
    should_publish = "--no-publish" not in sys.argv
    run(preview=is_preview, publish=should_publish)
