# Vedic Visualizer

A deterministic Vedic-astrology timeline visualizer. Scrub through an entire
life — daśās, transits, ingresses, retrograde stations, eclipses, Sade Sati —
with every insight computed from the Swiss Ephemeris via
[PyJHora](https://pypi.org/project/PyJHora/). **No predictions, no generative
models** — positions and classical rules only.

**Live instance:** [vedic.195-201-231-230.sslip.io](https://vedic.195-201-231-230.sslip.io)

## What it shows

- **Zodiac bi-wheel** (canvas): natal ring fixed, transiting planets moving as you scrub; ℞ badges; conjunction-to-natal hints; Sade Sati shading.
- **Daśā lanes**: Mahādaśā / Antara / Pratyantar ribbons with the active period highlighted; click any segment to jump the playhead there. Cross-checked against PyJHora's authoritative running-daśā in tests.
- **Event timeline**: 5,000+ precomputed events over ~120 years — sign ingresses (Mars→Ketu, refined to arc-minute precision), stations, place-visible eclipses, daśā boundaries, Sade Sati bands.
- **Insights panel** (deterministic): running daśā chain with years-left, panchanga (tithi/nakshatra-pada/sunrise/sunset), transit table with dignities and Moon-relative houses.

## Architecture

```
frontend/  React + TS + canvas (vite). Interpolates between ephemeris samples
           for smooth 60fps scrubbing; calls /api/state when the playhead pauses.
backend/   FastAPI. Pure deterministic engine on PyJHora:
             POST /api/session → full life bundle (~1.3 s, gzips to ~500 KB)
             GET  /api/state   → instant context for a paused moment
             GET  /api/health
```

The engine is *events, not polls*: heavy astronomy is precomputed once per
chart into a sorted event stream + coarse position samples; the client
interpolates continuously and only fetches context on pause.

## Run locally

```bash
# backend (python 3.12 — pyswisseph wheels)
cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=. uvicorn app.main:app --reload     # serves frontend/dist too

# frontend dev server (proxies /api → :8000)
cd frontend && npm i && npm run dev
```

Ephemeris files (`sepl_18.se1`, `semo_18.se1` — 1800–2400 CE) are vendored in
`backend/data/ephe`; PyJHora's pip wheel omits them, so `app/jhora_setup.py`
copies them into the installed package at startup.

## Tests

```bash
cd backend && PYTHONPATH=. python -m pytest tests/ -q
```

11 tests cover determinism, a random-instant cross-check of our proportional
daśā tree against `get_running_dhasa_for_given_date`, ingress-refinement
precision (<0.01°), eclipse anchoring against the known 1995-10-24 solar
eclipse visible from Chennai, Sade Sati geometry, session sorting, and API
contracts.

## Deploy (Hetzner box that already runs Caddy)

```bash
ssh your-server
sudo mkdir -p /opt && cd /opt
git clone https://github.com/<you>/vedic-app.git vedic-app && cd vedic-app
docker compose up -d --build        # app on 127.0.0.1:8080
```

Then point your existing Caddy at it — see [`deploy/Caddyfile.example`](deploy/Caddyfile.example):

```
astrology.yourdomain.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:8080
}
```

`sudo systemctl reload caddy`. Done — TLS is automatic.

Optional CD: `.github/workflows/deploy.yml` (workflow_dispatch) SSHes in,
pulls, rebuilds, health-checks. Add repo secrets `HETZNER_HOST`,
`HETZNER_USER`, `HETZNER_SSH_KEY`.

## License

AGPL-3.0 — required by our compute stack: PyJHora is AGPL-3.0 and Swiss
Ephemeris (pyswisseph ≥2.10) is AGPL-3.0. If you run a modified version as a
network service you must offer its source to its users (§13). See [LICENSE](LICENSE).

Grateful credit: P.V.R. Narasimha Rao's *Vedic Astrology — An Integrated
Approach* and JHora, and the PyJHora maintainers.

