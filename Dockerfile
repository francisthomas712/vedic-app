# ---------- Stage 1: build frontend ----------
FROM node:22-alpine AS web
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

# ---------- Stage 2: python deps (gcc needed here — pyswisseph builds from
# sdist on linux; no cp312 manylinux wheel exists) ----------
FROM python:3.12-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt ./backend/
# isolate into /install so the toolchain doesn't reach the runtime stage
RUN pip install --no-cache-dir --prefix=/install -r backend/requirements.txt

# ---------- Stage 3: runtime (toolchain-free) ----------
FROM python:3.12-slim AS app
WORKDIR /srv
COPY --from=deps /install /usr/local

COPY backend/app ./backend/app
COPY backend/data ./backend/data
COPY --from=web /build/dist ./frontend/dist

ENV PYTHONPATH=/srv/backend \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    WORKERS=2
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health')" || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers ${WORKERS}"]
