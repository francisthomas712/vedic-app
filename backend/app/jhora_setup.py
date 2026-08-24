"""Bootstrap PyJHora for server use.

PyJHora's pip wheel (>=3.6.6) ships WITHOUT ephemeris data files. We vendor the
two Swiss files that cover 1800-2400 CE (sepl_18.se1, semo_18.se1) in
backend/data/ephe and copy them into the installed jhora package on startup.

We import ONLY computation modules from jhora (never jhora.ui — that drags in
PyQt6).
"""
from __future__ import annotations

import shutil
from pathlib import Path

# --- canonical reference data -------------------------------------------------
PLANETS = [
    {"id": 0, "key": "sun",     "name": "Sun",     "symbol": "☉"},
    {"id": 1, "key": "moon",    "name": "Moon",    "symbol": "☾"},
    {"id": 2, "key": "mars",    "name": "Mars",    "symbol": "♂"},
    {"id": 3, "key": "mercury", "name": "Mercury", "symbol": "☿"},
    {"id": 4, "key": "jupiter", "name": "Jupiter", "symbol": "♃"},
    {"id": 5, "key": "venus",   "name": "Venus",   "symbol": "♀"},
    {"id": 6, "key": "saturn",  "name": "Saturn",  "symbol": "♄"},
    {"id": 7, "key": "rahu",    "name": "Rahu",    "symbol": "☊"},
    {"id": 8, "key": "ketu",    "name": "Ketu",    "symbol": "☋"},
]
LORD_NAMES = {p["id"]: p["name"] for p in PLANETS}

RASIS = [
    {"index": 0,  "key": "aries",      "sanskrit": "Mesha",     "symbol": "♈"},
    {"index": 1,  "key": "taurus",     "sanskrit": "Vrishabha", "symbol": "♉"},
    {"index": 2,  "key": "gemini",     "sanskrit": "Mithuna",   "symbol": "♊"},
    {"index": 3,  "key": "cancer",     "sanskrit": "Karka",     "symbol": "♋"},
    {"index": 4,  "key": "leo",        "sanskrit": "Simha",     "symbol": "♌"},
    {"index": 5,  "key": "virgo",      "sanskrit": "Kanya",     "symbol": "♍"},
    {"index": 6,  "key": "libra",      "sanskrit": "Tula",      "symbol": "♎"},
    {"index": 7,  "key": "scorpio",    "sanskrit": "Vrischika", "symbol": "♏"},
    {"index": 8,  "key": "sagittarius","sanskrit": "Dhanu",     "symbol": "♐"},
    {"index": 9,  "key": "capricorn",  "sanskrit": "Makara",    "symbol": "♑"},
    {"index": 10, "key": "aquarius",   "sanskrit": "Kumbha",    "symbol": "♒"},
    {"index": 11, "key": "pisces",     "sanskrit": "Meena",     "symbol": "♓"},
]

NAKSHATRAS = [
    "Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra",
    "Punarvasu", "Pushya", "Ashlesha", "Magha", "Purva Phalguni", "Uttara Phalguni",
    "Hasta", "Chitra", "Swati", "Vishakha", "Anuradha", "Jyeshtha",
    "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana", "Dhanishta", "Shatabhisha",
    "Purva Bhadrapada", "Uttara Bhadrapada", "Revati",
]

# Vimshottari dasha-year lengths keyed by planet id (total = 120)
VIMSHOTTARI_YEARS = {
    0: 6, 1: 10, 2: 7, 3: 17, 4: 16, 5: 20, 6: 19, 7: 18, 8: 7,
}
VIMSHOTTARI_ORDER = [8, 5, 0, 1, 2, 7, 4, 6, 3]  # Ketu→Venus→Sun→Moon→Mars→Rahu→Jup→Sat→Mer

# Natural friendship (Parashari), used only for dignities of planets 0..6.
FRIENDS = {
    0: {1, 2, 4},        # Sun: Moon Mars Jup
    1: {0, 3},           # Moon: Sun Mer
    2: {0, 1, 4},        # Mars: Sun Moon Jup
    3: {0, 5},           # Mercury: Sun Ven
    4: {0, 1, 2},        # Jupiter: Sun Moon Mars
    5: {3, 6},           # Venus: Mer Sat
    6: {3, 5},           # Saturn: Mer Ven
}
ENEMIES = {
    0: {5, 6},
    1: set(),
    2: {3},
    3: {1},
    4: {3, 5},
    5: {0, 1},
    6: {0, 1, 2},
}
# exaltation: planet -> (sign index, deep degree)
EXALTATION = {0: (0, 10), 1: (1, 3), 2: (9, 28), 3: (5, 15), 4: (3, 5), 5: (11, 27), 6: (6, 20)}
DEBILITATION = {p: ((s + 6) % 12, d) for p, (s, d) in EXALTATION.items()}
OWN_SIGNS = {0: {4}, 1: {3}, 2: {0, 7}, 3: {2, 5}, 4: {8, 11}, 5: {1, 6}, 6: {9, 10}}

_ephe_ready = False


def ensure_ephemeris_files() -> Path:
    """Copy vendored ephemeris files into the installed jhora package. Idempotent."""
    global _ephe_ready
    if _ephe_ready:
        return _target_dir()
    import jhora  # local import to keep module import cheap

    target = Path(jhora.__file__).parent / "data" / "ephe"
    vendored = Path(__file__).resolve().parent.parent / "data" / "ephe"
    target.mkdir(parents=True, exist_ok=True)
    copied = 0
    for f in sorted(vendored.glob("*.se1")):
        dst = target / f.name
        if not dst.exists() or dst.stat().st_size != f.stat().st_size:
            shutil.copy2(f, dst)
            copied += 1
    _ephe_ready = True
    return target


def _target_dir() -> Path:
    import jhora
    return Path(jhora.__file__).parent / "data" / "ephe"


def dignity(planet_id: int, sign_index: int, lon_in_sign: float) -> str | None:
    """Deterministic Parashari dignity label. Rahu/Ketu deliberately None —
    schools genuinely disagree on nodes; we don't fake precision."""
    if planet_id > 6:
        return None
    if sign_index == EXALTATION[planet_id][0]:
        return "exalted"
    if sign_index == DEBILITATION[planet_id][0]:
        return "debilitated"
    if sign_index in OWN_SIGNS[planet_id]:
        return "own sign"
    if sign_index in FRIENDS[planet_id]:
        return "friendly sign"
    if sign_index in ENEMIES[planet_id]:
        return "enemy sign"
    return "neutral sign"
