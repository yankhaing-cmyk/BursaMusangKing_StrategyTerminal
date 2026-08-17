#!/usr/bin/env python3
"""Full Bursa daily snapshot for Trending/Momentum/M.E.T.A. ATR state tracking. Key behavior: - Uses the upstream BursaMusangKing rules directly. - Keeps MIN_UNIVERSE fail-closed protection. - Chooses the newest trading date that exists in at least MIN_UNIVERSE stock histories, instead of blindly choosing the newest date seen in any single stock. - If run during Bursa market hours, it can therefore use the latest sufficiently-covered completed session rather than treating hundreds of stocks as stale just because a subset already has an intraday bar. """

import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone

import requests
import upstream

STRATEGIES = ("trending", "gaining_momentum", "meta_leader")
ATR_MULT = float(os.environ.get("TRAIL_ATR_MULT", "3.0"))
MIN_UNIVERSE = int(os.environ.get("MIN_UNIVERSE", "900"))


def num(v):
    try:
        x = float(v)
        return x if x == x and abs(x) != float("inf") else None
    except Exception:
        return None


def date_key(v):
    """Return YYYY-MM-DD from a pandas/Datetime-like index value."""
    return str(v)[:10]


def choose_trade_date(data):
    """Pick the newest date present in at least MIN_UNIVERSE stock histories. Important: coverage is counted by whether a stock history CONTAINS the date, not only by that stock's latest bar. This makes morning/manual runs safe: stocks that already have today's intraday daily bar still contain yesterday's completed bar. """
    coverage = Counter()

    for raw in data.values():
        if raw is None or not len(raw):
            continue

        # Count a date once per stock.
        seen = {date_key(x) for x in raw.index}
        coverage.update(seen)

    if not coverage:
        raise RuntimeError("FAIL-CLOSED: market feed returned no dated bars")

    eligible = [d for d, count in coverage.items() if count >= MIN_UNIVERSE]
    if not eligible:
        recent = sorted(coverage.items(), reverse=True)[:8]
        raise RuntimeError(
            f"FAIL-CLOSED: no Bursa trading date has >= {MIN_UNIVERSE} "
            f"stock histories; recent_coverage={recent}"
        )

    trade_date = max(eligible)
    return trade_date, coverage[trade_date], coverage


def truncate_to_trade_date(raw, trade_date):
    """Return history ending exactly on trade_date, or None if absent."""
    if raw is None or not len(raw):
        return None

    last_pos = None
    for pos, idx in enumerate(raw.index):
        d = date_key(idx)
        if d <= trade_date:
            last_pos = pos
        else:
            # fetcher returns sorted history, so later rows are not needed
            break

    if last_pos is None:
        return None

    cut = raw.iloc[: last_pos + 1]
    if not len(cut) or date_key(cut.index[-1]) != trade_date:
        return None

    return cut


def run(publish=True):
    eng = upstream.engine()
    cfg = eng["config"]
    fetcher = eng["data_fetcher"]
    ind = eng["indicators"]
    scr = eng["screener"]

    data = fetcher.fetch_market()
    screened = len(data)

    if screened < MIN_UNIVERSE:
        raise RuntimeError(
            f"FAIL-CLOSED: only {screened} market symbols returned; "
            f"need >= {MIN_UNIVERSE}"
        )

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

    trade_date, date_coverage, all_coverage = choose_trade_date(data)
    recent_coverage = sorted(all_coverage.items(), reverse=True)[:5]
    print(
        f"selected trade_date={trade_date} coverage={date_coverage}/{screened}; "
        f"recent_coverage={recent_coverage}"
    )

    rows = []
    bad = 0
    missing_date = 0

    for symbol, raw in data.items():
        try:
            cut = truncate_to_trade_date(raw, trade_date)
            if cut is None:
                missing_date += 1
                continue

            e = ind.enrich(cut)
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
                    "hits": hits,
                }
            )
        except Exception:
            bad += 1

    if len(rows) < MIN_UNIVERSE:
        raise RuntimeError(
            f"FAIL-CLOSED: only {len(rows)} valid rows for {trade_date}; "
            f"bad={bad} missing_date={missing_date}; need >= {MIN_UNIVERSE}"
        )

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
        raise RuntimeError(
            f"FAIL-CLOSED preflight: invalid outgoing rows: {invalid}"
        )

    bt = cfg.BACKTEST
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "trade_date": trade_date,
        "stocks_screened": screened,
        "rows": rows,
        "params": {
            "atr_mult": ATR_MULT,
            "stop_loss_pct": float(bt.get("stop_loss_pct", -7)),
            "commission_pct": float(bt.get("commission_pct", 0)),
        },
        "strategies": list(STRATEGIES),
    }

    with open("strategy_snapshot.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    print(
        f"prepared {len(rows)}/{screened} rows date={trade_date} "
        f"bad={bad} missing_date={missing_date}"
    )

    if publish:
        base = os.environ["WORKER_URL"].rstrip("/")
        token = os.environ["PUBLISH_TOKEN"]

        # Avoid a guaranteed 409 when a manual run is executed before the next
        # completed session and that trade date was already published.
        try:
            before = requests.get(
                base + "/api/health",
                headers={"Cache-Control": "no-cache"},
                timeout=60,
            )
            before.raise_for_status()
            health_before = before.json()
            last_run = health_before.get("last_run") or {}

            if (
                last_run.get("trade_date") == trade_date
                and str(last_run.get("status") or "").upper() == "OK"
            ):
                print(
                    f"SKIP PUBLISH: {trade_date} is already the latest "
                    f"successfully published trade date"
                )
                return payload
        except Exception as exc:
            # Health pre-check is helpful but must not silently replace the
            # normal authenticated publish/verification path.
            print("pre-publish health warning:", exc)

        r = requests.post(
            base + "/api/publish",
            json=payload,
            headers={"Authorization": "Bearer " + token},
            timeout=180,
        )
        print("publish", r.status_code, r.text[:500])
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
            raise RuntimeError(
                f"publish verification mismatch: {health}"
            )

        print("VERIFIED", json.dumps(health, separators=(",", ":")))

    return payload


if __name__ == "__main__":
    run("--no-publish" not in sys.argv)