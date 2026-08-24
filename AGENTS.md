# AGENTS.md — conventions for working in this repo

## Compute stack facts
- Backend targets **Python 3.12**: pyswisseph ships wheels ≤3.12; don't bump blindly.
- **PyJHora quirks learned the hard way:**
  - pip wheel ships without ephemeris data — `app/jhora_setup.ensure_ephemeris_files()` copies vendored files from `backend/data/ephe` at import. Keep those two `.se1` files in git.
  - Import ONLY `jhora.panchanga.drik`, `jhora.horoscope.*`, `jhora.utils` — never `jhora.ui.*` (drags PyQt6).
  - `get_planet_speed_sign` returns strings: `''`, `'℞'`, `'S'`.
  - Eclipse tuples contain placeholder dates (year `-4713`) for missing contacts — filter `t[0] > 1000` before use.
  - `next_solar_eclipse(jd, place)` returns eclipses **visible from that place**, not global ones.
  - `get_running_dhasa_for_given_date` can raise ValueError in the tail years of the final mahadasha (upstream limitation) — our proportional tree handles it.
  - Dasha year = mean sidereal year (365.2425 d) by default.

## Engine rules
- All engine functions are pure: `(birth, jd) -> dict`. No randomness, no ML.
- Every user-facing label must trace to a classical rule + ephemeris number.
- Tithi/nakshatra are computed from first principles (elongation/moon arcs), not from opaque library tuple formats.
- After touching the engine run: `cd backend && PYTHONPATH=. python -m pytest tests/ -q`

## Frontend
- Position display interpolates **unwrapped** sample series (see `unwrap()`); never interpolate mod-360 values directly.
- The client scrubs offline-smooth; `/api/state` fires only after a ~350 ms pause (debounce).

## Deploy
- Single-container deploy; Caddy already lives on the host — never add Caddy to Docker here.
- App binds `127.0.0.1:8080` inside compose; TLS terminates at host Caddy.
