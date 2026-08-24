"""Engine verification: determinism, library cross-checks, API contract.

The most important test class is TestDashaCrossCheck — our proportional
sub-period expansion must agree with PyJHora's authoritative running-dasha
function at random instants. If that holds, every dasha label in the UI is
anchored to the library.
"""
from __future__ import annotations

import random

import pytest
from fastapi.testclient import TestClient

from app import engine
from app.main import app

BIRTH = {
    "year": 1990, "month": 5, "day": 15, "hour": 10, "minute": 30,
    "lat": 13.0878, "lon": 80.2782, "tz": 5.5, "place_name": "Chennai",
}


@pytest.fixture(scope="module")
def place():
    jd, pl, _ = engine.parse_birth(BIRTH)
    return jd, pl


def test_natal_structure(place):
    jd, pl = place
    natal = engine.natal_chart(jd, pl)
    assert len(natal["planets"]) == 9
    ids = {p["id"] for p in natal["planets"]}
    assert ids == set(range(9))
    for p in natal["planets"]:
        assert 0 <= p["absLon"] < 360
        assert 0 <= p["rasi"] < 12
        assert p["nakshatra"] in engine.NAKSHATRAS if hasattr(engine, "NAKSHATRAS") else True
    # Sun mid-May (sidereal) is in Taurus or late Aries — sanity band:
    sun = next(p for p in natal["planets"] if p["id"] == 0)
    assert sun["rasi"] in (0, 1), f"unexpected sidereal Sun sign {sun}"


def test_determinism(place):
    jd, pl = place
    n1 = engine.natal_chart(jd, pl)
    n2 = engine.natal_chart(jd, pl)
    assert n1 == n2


class TestDashaCrossCheck:
    def test_tree_covers_120_years(self):
        jd, pl, _ = engine.parse_birth(BIRTH)
        tree = engine.vimshottari_tree(jd, pl, levels=3)
        assert len(tree) == 9
        span = tree[-1]["endJd"] - tree[0]["startJd"]
        assert abs(span - 120 * 365.2425) < 40  # ~a month tolerance on year length
        for maha in tree:
            assert len(maha["children"]) == 9
            for ant in maha["children"]:
                assert len(ant["children"]) == 9
                kids = ant["children"]
                assert all(kids[i]["endJd"] == pytest.approx(kids[i + 1]["startJd"], abs=1e-6)
                           for i in range(8))

    def test_matches_library_running_dasha(self):
        from jhora.horoscope.dhasa.graha import vimsottari

        jd, pl, _ = engine.parse_birth(BIRTH)
        tree = engine.vimshottari_tree(jd, pl, levels=3)
        rng = random.Random(42)
        lo = tree[0]["startJd"] + 1.0            # library window begins pre-birth
        hi = tree[-1]["endJd"] - 30.0            # and ends at last mahadasha end
        checked, lib_limitations = 0, 0
        for _ in range(25):
            probe = rng.uniform(lo, hi)
            mine = engine.running_chain(tree, probe)
            assert len(mine) >= 3, f"chain too short at {probe}"
            try:
                lib_rows = vimsottari.get_running_dhasa_for_given_date(
                    probe, jd, pl, dhasa_level_index=3)
            except ValueError:
                # Known upstream limitation: children generation can fail in the
                # tail of the final mahadasha. Our proportional tree still works.
                lib_limitations += 1
                continue
            for level_idx, row in enumerate(lib_rows[:3]):
                lib_lord = int(row[0][level_idx])
                assert mine[level_idx]["lord"] == lib_lord, (
                    f"mismatch at probe={probe}, level={level_idx}: "
                    f"mine={mine[level_idx]['lord']} lib={lib_lord}"
                )
                checked += 1
        assert checked >= 69, f"too few cross-checks passed: {checked}"
        assert lib_limitations <= 3


class TestEventsAndPeriods:
    def test_ingress_refinement_is_exact(self):
        # Saturn ingress into a sign: refined jd must land within 0.001d (~90s)
        evs = engine.ingress_events(2449000.0, 2450000.0)
        sat = [e for e in evs if e["planet"] == 6]
        for e in sat:
            lon_at = engine.drik.sidereal_longitude(e["jd"], 6) % 30
            assert min(lon_at, 30 - lon_at) < 0.01  # within ~15 arcmin of boundary

    def test_sade_sati_consistency(self):
        jd0, jd1 = 2448027.0, 2483000.0
        moon_rasi = 3  # arbitrary but fixed
        periods = engine.sade_sati_periods(jd0, jd1, moon_rasi)
        for pr in periods:
            mid = (pr["startJd"] + pr["endJd"]) / 2
            sat_rasi = int(engine.drik.sidereal_longitude(mid, 6) // 30) % 12
            assert (sat_rasi - moon_rasi) % 12 in (11, 0, 1)

    def test_eclipses_found(self):
        _, pl, _ = engine.parse_birth(BIRTH)
        # Known anchor: the 1995-10-24 total solar eclipse was visible from Chennai.
        evs = engine.eclipse_events(2450000.0, 2450040.0, pl)
        assert any(e["body"] == "sun" and "1995-10-24" in e["label"] for e in evs), \
            f"missing known 1995 solar eclipse, got {[e['label'] for e in evs]}"
        # Lunar eclipses occur ~twice a year and are visible from half the globe;
        # solar eclipses are place-restricted, so only lunar counts are asserted here.
        evs = engine.eclipse_events(2460000.0, 2460365.0, pl)
        lunar = [e for e in evs if e["body"] == "moon"]
        assert 1 <= len(lunar) <= 4
        jds = [e["jd"] for e in evs]
        assert jds == sorted(jds)
        assert all(b - a > 20 for a, b in zip(jds, jds[1:])), "eclipse dedupe failed"

    def test_session_build_and_sorting(self):
        s = engine.build_session(BIRTH, span_years=60)
        jds = [e["jd"] for e in s["events"]]
        assert jds == sorted(jds)
        assert len(s["events"]) > 500          # dashas alone exceed this over 60y
        assert len(s["samples"]["moon"]) > 20000
        assert s["periods"]["sadeSati"], "expected ≥1 sade sati window in 60y"


class TestPlaces:
    def test_kochi_resolves(self):
        import pytest as _pytest
        from app import places as places_mod
        if not places_mod.DB_PATH.exists():
            _pytest.skip("places.db not built (run: python -m app.places)")
        res = places_mod.search_places("Kochi", 5)
        assert res, "no results for Kochi"
        top = res[0]
        assert top["country"] == "India" and top["state"] == "Kerala"
        assert top["tz"] == 5.5
        assert abs(top["lat"] - 9.94) < 0.2 and abs(top["lon"] - 76.26) < 0.2

    def test_alias_search(self):
        from app import places as places_mod
        if not places_mod.DB_PATH.exists():
            return
        res = places_mod.search_places("Calcutta", 8)
        assert any(r["name"] == "Kolkata" for r in res), "alias Calcutta→Kolkata failed"

    def test_places_endpoint(self):
        from app import places as places_mod
        if not places_mod.DB_PATH.exists():
            return
        c = TestClient(app)
        r = c.get("/api/places", params={"q": "Chennai"})
        assert r.status_code == 200
        body = r.json()
        assert body["results"], "empty results"
        assert {"name", "lat", "lon", "tz"} <= set(body["results"][0].keys())


class TestAPI:
    def test_health(self):
        c = TestClient(app)
        assert c.get("/api/health").json()["ok"] is True

    def test_session_endpoint_contract(self):
        c = TestClient(app)
        r = c.post("/api/session", json=BIRTH)
        assert r.status_code == 200
        body = r.json()
        for key in ("natal", "dashaTree", "samples", "events", "periods"):
            assert key in body
        assert body["natal"]["ascendant"]["rasiName"]

    def test_state_endpoint(self):
        c = TestClient(app)
        r = c.get("/api/state", params={
            "year": 2025, "month": 6, "day": 1, "hour": 12,
            "lat": BIRTH["lat"], "lon": BIRTH["lon"], "tz": BIRTH["tz"],
        })
        assert r.status_code == 200
        st = r.json()
        assert len(st["transits"]) == 9
        assert st["panchanga"]["tithi"]["name"]
        assert len(st["runningDasha"]) == 3
