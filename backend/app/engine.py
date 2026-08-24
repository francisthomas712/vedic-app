"""Deterministic Vedic astrology engine on top of PyJHora.

Design contract:
- Pure functions of (birth data, julian day) -> JSON-serializable dicts.
- Every label/insight traces to a classical rule + an ephemeris number.
  No randomness, no ML, no narrative generation.
- Heavy astronomy is PRECOMPUTED into a per-chart "session" bundle; the client
  scrubs offline-smooth and only calls /api/state when the playhead pauses.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from jhora import const, utils
from jhora.horoscope.chart import charts
from jhora.horoscope.dhasa.graha import vimsottari
from jhora.panchanga import drik, eclipse

from .jhora_setup import (
    LORD_NAMES, NAKSHATRAS, PLANETS, RASIS,
    VIMSHOTTARI_ORDER, VIMSHOTTARI_YEARS,
    ensure_ephemeris_files, dignity,
)

ensure_ephemeris_files()

SID_YEAR_DAYS = 365.2425          # PyJHora default (mean sidereal) dasha year
DAY = 1.0
TRACKED_FOR_INGRESS = [2, 4, 6, 7]  # Mars, Jupiter, Saturn, Rahu (Ketu = Rahu+180)
STATION_PLANETS = [2, 3, 4, 5, 6]   # Mars..Saturn (nodes always retro by definition)
MAX_SPAN_DAYS = int(125 * SID_YEAR_DAYS)


# ----------------------------------------------------------------------------- time helpers
def jd_to_iso(jd: float, tz_offset: float) -> str:
    """Julian day -> ISO local datetime string with explicit UTC offset."""
    unix = (jd - 2440587.5) * 86400.0
    dt_utc = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=unix)
    loc = dt_utc + timedelta(hours=tz_offset)
    sign = "+" if tz_offset >= 0 else "-"
    ah = abs(tz_offset)
    off = f"{sign}{int(ah):02d}:{int(round((ah % 1) * 60)):02d}"
    return loc.replace(microsecond=0).isoformat() + off


def iso_to_jd(iso: str) -> float:
    dt = datetime.fromisoformat(iso)
    return dt.timestamp() / 86400.0 + 2440587.5


def parse_birth(data: dict):
    """birth payload -> (jd_birth, Place, meta dict). Deterministic."""
    y, mth, d = data["year"], data["month"], data["day"]
    hh, mm = data.get("hour", 12), data.get("minute", 0)
    place = drik.Place(
        data.get("place_name", "custom"),
        float(data["lat"]), float(data["lon"]), float(data["tz"]),
    )
    jd = utils.julian_day_number(drik.Date(int(y), int(mth), int(d)), (int(hh), int(mm), 0))
    meta = {"ayanamsa": str(getattr(const, "_DEFAULT_AYANAMSA_MODE", "LAHIRI"))}
    return float(jd), place, meta


# ----------------------------------------------------------------------------- natal chart
def _split(lon: float) -> tuple[int, float]:
    return int(lon // 30) % 12, lon % 30.0


def _speed_state(jd: float, place, pid: int) -> dict:
    """PyJHora returns '', '℞' or 'S' from get_planet_speed_sign."""
    s = drik.get_planet_speed_sign(jd, place, pid)
    return {"retrograde": s == "℞", "stationary": s == "S"}


def natal_chart(jd: float, place) -> dict:
    pp = charts.rasi_chart(jd, place)
    asc_entry = next(row for row in pp if row[0] == "L")
    planets = []
    for pid in range(9):
        row = next(r for r in pp if r[0] == pid)
        rasi_idx, lon_in = int(row[1][0]), float(row[1][1])
        abs_lon = rasi_idx * 30 + lon_in
        retro, stationary = None, None
        if pid <= 6:
            st = _speed_state(jd, place, pid)
            retro, stationary = st["retrograde"], st["stationary"]
        nak = int(abs_lon // (360 / 27)) % 27
        pada = int((abs_lon % (360 / 27)) // (360 / 108)) + 1
        pmeta = PLANETS[pid]
        planets.append({
            "id": pid, "key": pmeta["key"], "name": pmeta["name"], "symbol": pmeta["symbol"],
            "rasi": rasi_idx, "rasiName": RASIS[rasi_idx]["sanskrit"],
            "lonInSign": round(lon_in, 4), "absLon": round(abs_lon, 4),
            "retrograde": retro, "stationary": stationary,
            "nakshatra": NAKSHATRAS[nak], "pada": pada,
            "dignity": dignity(pid, rasi_idx, lon_in),
        })
    a_rasi, a_lon = int(asc_entry[1][0]), float(asc_entry[1][1])
    a_abs = a_rasi * 30 + a_lon
    a_nak = int(a_abs // (360 / 27)) % 27
    return {
        "ascendant": {
            "rasi": a_rasi, "rasiName": RASIS[a_rasi]["sanskrit"],
            "lonInSign": round(a_lon, 4), "absLon": round(a_abs, 4),
            "nakshatra": NAKSHATRAS[a_nak],
            "symbol": RASIS[a_rasi]["symbol"],
        },
        "planets": planets,
        "moonRasi": next(p for p in planets if p["id"] == 1)["rasi"],
    }


# ----------------------------------------------------------------------------- vimshottari
def _vimshottari_children(lord: int, start_jd: float, length_days: float) -> list[dict]:
    """Classical proportional antara expansion within one parent period.
    Sequence starts at the parent lord and follows Vimshottari order."""
    order = VIMSHOTTARI_ORDER
    i0 = order.index(lord)
    out, t = [], start_jd
    for k in range(9):
        clord = order[(i0 + k) % 9]
        clen = length_days * VIMSHOTTARI_YEARS[clord] / 120.0
        out.append({"lord": clord, "startJd": t, "endJd": t + clen})
        t += clen
    return out


def vimshottari_tree(jd_birth: float, place, levels: int = 3) -> list[dict]:
    """Mahadashas from the library (authoritative), sub-levels by classical
    proportion. Cross-checked against the library's running-dasha in tests."""
    maha = vimsottari.vimsottari_mahadasa(jd_birth, place)
    items = [(int(k), float(v)) for k, v in maha.items()]
    nodes = []
    for idx, (lord, start_jd) in enumerate(items):
        if idx + 1 < len(items):
            end_jd = items[idx + 1][1]
        else:
            # last period runs its own length (library omits trailing ends)
            end_jd = start_jd + VIMSHOTTARI_YEARS[lord] * SID_YEAR_DAYS
        node = {
            "lord": lord, "lordName": LORD_NAMES[lord],
            "startJd": start_jd, "endJd": end_jd,
            "startISO": jd_to_iso(start_jd, place.timezone if hasattr(place, 'timezone') else place.time_zone if hasattr(place, 'time_zone') else 0.0),
            "children": [],
        }
        if levels >= 2:
            for ant in _vimshottari_children(lord, start_jd, end_jd - start_jd):
                a = {
                    "lord": ant["lord"], "lordName": LORD_NAMES[ant["lord"]],
                    "startJd": ant["startJd"], "endJd": ant["endJd"], "children": [],
                }
                if levels >= 3:
                    a["children"] = [
                        {
                            "lord": c["lord"], "lordName": LORD_NAMES[c["lord"]],
                            "startJd": c["startJd"], "endJd": c["endJd"],
                        }
                        for c in _vimshottari_children(ant["lord"], ant["startJd"], ant["endJd"] - ant["startJd"])
                    ]
                node["children"].append(a)
        nodes.append(node)
    return nodes


def running_chain(tree: list[dict], jd: float) -> list[dict]:
    """Active mahadasha/antara/pratyantara at an instant, from the tree."""
    chain = []
    level = tree
    while level:
        hit = next((n for n in level if n["startJd"] <= jd < n["endJd"]), None)
        if not hit:
            break
        chain.append({k: hit[k] for k in ("lord", "lordName", "startJd", "endJd")})
        level = hit.get("children") or []
    return chain


# ----------------------------------------------------------------------------- samples
def position_samples(jd0: float, jd1: float) -> dict:
    """Coarse longitude samples for client-side interpolation.
    Moon daily (~13 deg/d), others every 5 days. Values are absolute sidereal
    longitudes rounded to 3 decimals (≈11 km at lunar distance — plenty)."""
    slow_step, moon_step = 5, 1
    slow_jds = []
    moon_vals = []
    slow_vals = {p: [] for p in (0, 2, 3, 4, 5, 6, 7, 8)}
    n_slow = int((jd1 - jd0) // slow_step) + 2
    n_moon = int((jd1 - jd0) // moon_step) + 2

    for i in range(n_slow):
        jd = jd0 + i * slow_step
        if jd > jd1 + slow_step:
            break
        slow_jds.append(round(jd, 4))
        for p in (0, 2, 3, 4, 5, 6, 7, 8):
            slow_vals[p].append(round(drik.sidereal_longitude(jd, p) % 360.0, 3))

    moon_jds = []
    for i in range(n_moon):
        jd = jd0 + i * moon_step
        if jd > jd1 + moon_step:
            break
        moon_jds.append(round(jd, 4))
        moon_vals.append(round(drik.sidereal_longitude(jd, 1) % 360.0, 3))

    return {
        "jd0": round(jd0, 4),
        "slowStepDays": slow_step,
        "slowJds": slow_jds,
        "slow": {str(k): v for k, v in slow_vals.items()},
        "moonJds": moon_jds,
        "moon": moon_vals,
    }


# ----------------------------------------------------------------------------- events
def _refine_crossing(longitude_fn, lo: float, hi: float, target_lon: float,
                     iters: int = 34) -> float:
    """Bisect the moment longitude_fn(jd) crosses target_lon between lo and hi.
    Uses wrap-aware difference so 0°/360° boundaries work."""
    def diff(jd):
        return (longitude_fn(jd) - target_lon + 180.0) % 360.0 - 180.0
    d_lo = diff(lo)
    for _ in range(iters):
        mid = (lo + hi) / 2
        d_mid = diff(mid)
        if (d_lo < 0) == (d_mid < 0):
            lo, d_lo = mid, d_mid
        else:
            hi = mid
    return (lo + hi) / 2


def ingress_events(jd0: float, jd1: float) -> list[dict]:
    """Sidereal sign ingresses for tracked planets, refined to ~minute precision."""
    step = 5.0
    out = []
    prev = {}
    for p in TRACKED_FOR_INGRESS + [8]:
        prev[p] = drik.sidereal_longitude(jd0, p)
    n = int((jd1 - jd0) / step) + 1
    for i in range(1, n + 1):
        jd = min(jd0 + i * step, jd1)
        for p in TRACKED_FOR_INGRESS + [8]:
            cur = drik.sidereal_longitude(jd, p)
            if (cur // 30) != (prev[p] // 30):
                # direction-aware boundary target (retrograde crosses downward)
                if cur > prev[p]:
                    target = (math.floor(prev[p] / 30) + 1) * 30.0
                else:
                    target = math.floor(prev[p] / 30) * 30.0
                jd_x = _refine_crossing(lambda j: drik.sidereal_longitude(j, p),
                                        jd - step, jd, target)
                into = int(cur // 30) % 12
                out.append({
                    "jd": jd_x,
                    "iso": None,  # filled by caller with tz
                    "kind": "ingress",
                    "planet": p,
                    "planetName": PLANETS[p]["name"],
                    "intoRasi": into,
                    "label": f"{PLANETS[p]['name']} enters {RASIS[into]['sanskrit']}",
                })
            prev[p] = cur
    return out


def station_events(jd0: float, jd1: float) -> list[dict]:
    """Retrograde↔direct stations via speed-sign changes (numeric derivative)."""
    def speed(jd, p):
        h = 0.25
        l1 = drik.sidereal_longitude(jd - h, p)
        l2 = drik.sidereal_longitude(jd + h, p)
        return ((l2 - l1 + 180.0) % 360.0 - 180.0) / (2 * h)

    step = 3.0
    out = []
    prev_sign = {}
    for p in STATION_PLANETS:
        prev_sign[p] = 1 if speed(jd0, p) >= 0 else -1
    n = int((jd1 - jd0) / step) + 1
    for i in range(1, n + 1):
        jd = min(jd0 + i * step, jd1)
        for p in STATION_PLANETS:
            s_now = 1 if speed(jd, p) >= 0 else -1
            if s_now != prev_sign[p]:
                lo, hi = jd - step, jd
                for _ in range(28):
                    mid = (lo + hi) / 2
                    sm = 1 if speed(mid, p) >= 0 else -1
                    if sm == prev_sign[p]:
                        lo = mid
                    else:
                        hi = mid
                jd_x = (lo + hi) / 2
                going = "turns retrograde" if s_now < 0 else "turns direct"
                out.append({
                    "jd": jd_x, "iso": None, "kind": "station",
                    "planet": p, "planetName": PLANETS[p]["name"],
                    "label": f"{PLANETS[p]['name']} {going}",
                })
            prev_sign[p] = s_now
    return out


def eclipse_events(jd0: float, jd1: float, place) -> list[dict]:
    out = []
    for kind_label, fn, pk in (("Solar eclipse", eclipse.next_solar_eclipse, "sun"),
                               ("Lunar eclipse", eclipse.next_lunar_eclipse, "moon")):
        jd = jd0
        last_jd = None
        guard = 0
        while guard < 400:
            guard += 1
            try:
                etype, whens = fn(jd, place)
            except TypeError:
                etype, whens = fn(jd)
            # Some contact slots are placeholder dates (year -4713); keep real ones.
            real = [t for t in whens if t[0] > 1000]
            if not real:
                jd += 30
                continue
            peak = max(real, key=lambda t: (t[0], t[1], t[2], t[3]))
            jd_e = utils.julian_day_number(drik.Date(peak[0], peak[1], peak[2]),
                                           (int(peak[3]), int(round((peak[3] % 1) * 60)), 0))
            if jd_e > jd1:
                break
            # dedupe: same event re-reported within ±25 days of the previous one
            if last_jd is not None and abs(jd_e - last_jd) < 25:
                jd = max(jd_e, last_jd) + 25
                continue
            out.append({
                "jd": jd_e, "iso": None, "kind": "eclipse",
                "body": pk,
                "label": f"{etype.capitalize()} {kind_label.lower()} · {peak[0]}-{peak[1]:02d}-{peak[2]:02d}",
            })
            last_jd = jd_e
            jd = jd_e + 20
    return sorted(out, key=lambda e: e["jd"])


def dasha_boundary_events(tree: list[dict]) -> list[dict]:
    ev = []
    def walk(nodes, depth):
        for nde in nodes:
            ev.append({
                "jd": nde["startJd"], "iso": None,
                "kind": "dasha", "depth": depth,
                "lordName": nde["lordName"],
                "label": f"{'—' * depth}{'· ' if depth else ''}{' › '.join([])}{nde['lordName']} daśā begins",
            })
            walk(nde.get("children") or [], depth + 1)
    walk(tree, 1)
    return ev


# ----------------------------------------------------------------------------- periods
def sade_sati_periods(jd0: float, jd1: float, natal_moon_rasi: int) -> list[dict]:
    """Saturn transiting 12th/1st/2nd from natal Moon — rising/peak/setting."""
    target = {(natal_moon_rasi - 1) % 12: "rising",
              natal_moon_rasi % 12: "peak",
              (natal_moon_rasi + 1) % 12: "setting"}
    step = 5.0
    periods, cur = [], None
    n = int((jd1 - jd0) / step) + 1
    for i in range(n + 1):
        jd = min(jd0 + i * step, jd1)
        rasi = int(drik.sidereal_longitude(jd, 6) // 30) % 12
        phase = target.get(rasi)
        if phase and cur and cur["phase"] == phase:
            cur["endJd"] = jd
        elif phase:
            if cur:
                periods.append(cur)
            cur = {"startJd": max(jd - step, jd0), "endJd": jd, "phase": phase}
        else:
            if cur:
                periods.append(cur)
                cur = None
    if cur:
        periods.append(cur)
    # Drop boundary artifacts (zero/one-day stubs where the scan starts mid-phase).
    periods = [p for p in periods if p["endJd"] - p["startJd"] > 20]
    for pr in periods:
        pr["label"] = f"Sade Sati · {pr['phase']} phase"
    return periods


# ----------------------------------------------------------------------------- instant state
def state_at(jd_birth: float, place, jd: float, natal: dict) -> dict:
    """Deterministic context for a paused playhead instant."""
    # Classical definitions computed directly (transparent + no opaque tuples):
    # tithi = 12° steps of (Moon − Sun) elongation; nakshatra = 13°20′ moon arcs.
    sun_lon = drik.sidereal_longitude(jd, 0) % 360.0
    moon_lon = drik.sidereal_longitude(jd, 1) % 360.0
    elong = (moon_lon - sun_lon) % 360.0
    tithi_idx = int(elong // 12)
    tithi_prog = round((elong % 12) / 12.0, 4)
    nak_arc = 360.0 / 27
    nak_idx = int(moon_lon // nak_arc) % 27
    nak_pada = int((moon_lon % nak_arc) // (nak_arc / 4)) + 1

    sr = drik.sunrise(jd, place)
    ss = drik.sunset(jd, place)

    transits = []
    for pid in range(9):
        lon = drik.sidereal_longitude(jd, pid) % 360.0
        rasi_idx, lon_in = _split(lon)
        retro, stationary = None, None
        if pid <= 6:
            st = _speed_state(jd, place, pid)
            retro, stationary = st["retrograde"], st["stationary"]
        natal_p = next(p for p in natal["planets"] if p["id"] == pid)
        house_from_asc = (rasi_idx - natal["ascendant"]["rasi"]) % 12 + 1
        transits.append({
            "id": pid, "name": PLANETS[pid]["name"], "symbol": PLANETS[pid]["symbol"],
            "absLon": round(lon, 4), "rasi": rasi_idx,
            "rasiName": RASIS[rasi_idx]["sanskrit"],
            "retrograde": retro, "stationary": stationary,
            "dignity": dignity(pid, rasi_idx, lon_in),
            "houseFromAscendant": house_from_asc,
            "houseFromMoon": (rasi_idx - natal["moonRasi"]) % 12 + 1,
            "conjunctNatalDeg": round(_angular_sep(lon, natal_p["absLon"]), 2),
        })

    return {
        "jd": round(jd, 6),
        "panchanga": {
            "tithi": _tithi_label(tithi_idx, tithi_prog),
            "nakshatra": {"index": nak_idx, "name": NAKSHATRAS[nak_idx], "pada": nak_pada},
            "sunriseLocal": sr[1] if isinstance(sr, (list, tuple)) and len(sr) > 1 else None,
            "sunsetLocal": ss[1] if isinstance(ss, (list, tuple)) and len(ss) > 1 else None,
        },
        "transits": transits,
        "runningDasha": running_chain(vimshottari_tree(jd_birth, place, levels=3), jd),
    }


def _angular_sep(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _tithi_label(idx: int, progress: float) -> dict:
    names = ["Pratipada", "Dwitiya", "Tritiya", "Chaturthi", "Panchami", "Shashthi",
             "Saptami", "Ashtami", "Navami", "Dashami", "Ekadashi", "Dwadashi",
             "Trayodashi", "Chaturdashi"]
    paksha = "Shukla" if idx < 15 else "Krishna"
    i = idx % 15
    name = {14: "Purnima", 29: "Amavasya"}.get(idx, names[i])
    return {"index": idx, "paksha": paksha, "name": name, "progress": progress}


# ----------------------------------------------------------------------------- session bundle
def build_session(birth_data: dict, span_years: int = 120) -> dict:
    """Everything the client needs to scrub a whole life without further calls
    except optional /api/state pauses."""
    jd_birth, place, meta = parse_birth(birth_data)
    jd0 = jd_birth - 365.25 * 5
    jd1 = jd_birth + min(span_years, 122) * SID_YEAR_DAYS
    natal = natal_chart(jd_birth, place)

    tree = vimshottari_tree(jd_birth, place, levels=3)

    events = []
    events += dasha_boundary_events(tree)
    events += ingress_events(jd0, jd1)
    events += station_events(jd0, jd1)
    events += eclipse_events(jd0, jd1, place)
    for e in events:
        e["iso"] = jd_to_iso(e["jd"], birth_data.get("tz", 0.0))
    events.sort(key=lambda e: e["jd"])

    ss = sade_sati_periods(jd0, jd1, natal["moonRasi"])
    for pr in ss:
        pr["startISO"] = jd_to_iso(pr["startJd"], birth_data.get("tz", 0.0))
        pr["endISO"] = jd_to_iso(pr["endJd"], birth_data.get("tz", 0.0))

    return {
        "birth": birth_data,
        "meta": {**meta, "jdBirth": round(jd_birth, 6),
                 "range": {"fromJd": round(jd0, 4), "toJd": round(jd1, 4)}},
        "natal": natal,
        "dashaTree": tree,
        "samples": position_samples(jd0, jd1),
        "events": events,
        "periods": {"sadeSati": ss},
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
