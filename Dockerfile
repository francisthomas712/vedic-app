# ---------- Stage 1: build frontend ----------
FROM node:22-alpine AS web
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM python:3.12-slim AS app
WORKDIR /srv

# pyswisseph ships manylinux wheels for 3.12; slim is enough (no build deps needed)
COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt

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
