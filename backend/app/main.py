"""FastAPI app exposing the deterministic engine.

- POST /api/session : full scrub bundle for a birth chart (heavy, ~1 request per chart)
- GET  /api/state   : instant context (panchanga, transits, running dasha) for a paused playhead
- GET  /api/health

Serves the built frontend from ../frontend/dist when present (single-container deploy).
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import time
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import engine
from .jhora_setup import RASIS

@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Heavy chart computation must run in a PROCESS, not a thread:
    # swisseph.calc_ut measures ~6x slower under the event loop's GIL churn.
    _get_pool()
    yield
    app.state.pool.shutdown(wait=False)


def _get_pool() -> ProcessPoolExecutor:
    """Lazily create the executor so TestClient-without-lifespan still works."""
    pool = getattr(app.state, "pool", None)
    if pool is None:
        pool = ProcessPoolExecutor(max_workers=1)
        app.state.pool = pool
    return pool


app = FastAPI(title="Vedic Visualizer", version="0.1.0",
              description="Deterministic Vedic astrology timeline visualizer. "
                          "No predictions — positions, periods and classical rules only.",
              lifespan=_lifespan)

app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


class BirthData(BaseModel):
    year: int = Field(..., ge=1800, le=2400)
    month: int = Field(..., ge=1, le=12)
    day: int = Field(..., ge=1, le=31)
    hour: int = Field(12, ge=0, le=23)
    minute: int = Field(0, ge=0, le=59)
    lat: float = Field(..., ge=-89.9, le=89.9)
    lon: float = Field(..., ge=-179.9, le=179.9)
    tz: float = Field(0.0, ge=-14, le=14)
    place_name: str = "custom"


@app.get("/api/health")
def health():
    return {"ok": True, "service": "vedic-visualizer", "version": app.version}


@app.post("/api/session")
async def create_session(birth: BirthData):
    """Full scrub bundle for one chart. Runs in a process pool (see _lifespan)
    and returns JSONResponse directly: FastAPI's default path runs
    jsonable_encoder over the whole ~2.5 MB dict, which costs more than the
    astronomy itself."""
    data = birth.model_dump()
    key = hashlib.sha256(
        repr(sorted(data.items())).encode()
    ).hexdigest()[:24]
    cached = _session_cache_get(key)
    if cached is not None:
        return JSONResponse(cached)
    loop = asyncio.get_running_loop()
    try:
        session = await loop.run_in_executor(
            _get_pool(), engine.build_session, data, 120,
        )
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=422, detail=f"computation failed: {exc}") from exc
    _session_cache_put(key, session)
    return JSONResponse(session)


# Small per-worker session cache (charts are deterministic; identical births hit RAM).
_SESSION_CACHE: dict[str, tuple[float, dict]] = {}
_SESSION_CACHE_MAX = 16


def _session_cache_get(key: str):
    hit = _SESSION_CACHE.get(key)
    if hit:
        return hit[1]
    return None


def _session_cache_put(key: str, session: dict) -> None:
    if len(_SESSION_CACHE) >= _SESSION_CACHE_MAX:
        oldest = min(_SESSION_CACHE.items(), key=lambda kv: kv[1][0])
        _SESSION_CACHE.pop(oldest[0], None)
    _SESSION_CACHE[key] = (time.monotonic(), session)


class StateQuery(BaseModel):
    year: int = Field(..., ge=1800, le=2400)
    month: int = Field(..., ge=1, le=12)
    day: int = Field(..., ge=1, le=31)
    hour: float = Field(12.0, ge=0, le=23.999)  # local decimal hours at the birth place tz
    minute: float = 0.0
    lat: float
    lon: float
    tz: float
    # natal reference (for houses/conjunctions): reuse birth values by default
    natal_year: int | None = None
    natal_month: int | None = None
    natal_day: int | None = None
    natal_hour: int | None = None
    natal_minute: int | None = None


@app.get("/api/state")
def get_state(
    year: int = Query(...), month: int = Query(...), day: int = Query(...),
    hour: float = Query(12.0), minute: float = Query(0.0),
    lat: float = Query(...), lon: float = Query(...), tz: float = Query(...),
):
    """Instant context for an arbitrary moment. Natal reference defaults to the
    same instant (useful for 'any date' mode); pass natal_* for chart-relative views."""
    q = {
        "year": year, "month": month, "day": day,
        "hour": int(hour), "minute": int(round(minute + (hour % 1) * 60)),
        "lat": lat, "lon": lon, "tz": tz,
    }
    try:
        jd_now, place, meta = engine.parse_birth(q)
        jd_ref, _, _ = engine.parse_birth(q)
        natal = engine.natal_chart(jd_ref, place)
        state = engine.state_at(jd_ref, place, jd_now, natal)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"state computation failed: {exc}") from exc
    return state


# --- static frontend (built React app), mounted last -------------------------
_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if (_dist / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = _dist / full_path
        if full_path and candidate.is_file() and str(candidate).startswith(str(_dist)):
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
else:
    @app.get("/")
    def root():
        return {"service": "vedic-visualizer",
                "hint": "frontend not built yet — POST /api/session is live"}
