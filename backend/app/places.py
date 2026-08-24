"""Place search over PyJHora's bundled GeoNames CSVs.

The wheel ships two CSVs (world ~68k cities; world + all-India ~619k rows) with
columns: place_name, alternate_names(|-separated), state, country, lat, lon,
timezone_hours, elevation.

We bake them into a compact SQLite index (see `python -m app.places_build`,
run at Docker-build time) so runtime autocomplete is fast and RAM-light.

Honest limitation: timezone_hours is the place's standard UTC offset. Historical
daylight-saving is NOT applied — for DST-era births users can override tz
manually in the form.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "places.db"


def _csv_paths() -> list[Path]:
    import jhora
    data = Path(jhora.__file__).parent / "data"
    return [data / "geonames_places_5k.csv", data / "geonames_places_5k_IN.csv"]


def build_index(db_path: Path = DB_PATH) -> int:
    """(Re)build the SQLite place index from jhora's bundled CSVs. Returns rows written."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("""
        CREATE TABLE places (
            name TEXT NOT NULL,
            alts TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL DEFAULT '',
            country TEXT NOT NULL DEFAULT '',
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            tz REAL NOT NULL
        )
    """)
    seen: set[tuple] = set()
    rows_written = 0
    for path in _csv_paths():
        if not path.exists():
            continue
        import csv

        with open(path, encoding="utf-8", newline="") as fh:
            reader = csv.reader(fh)
            next(reader, None)  # header (has BOM)
            batch = []
            for row in reader:
                if len(row) < 7:
                    continue
                name, alts, state, country, lat, lon, tz = row[:7]
                try:
                    lat_f, lon_f, tz_f = float(lat), float(lon), float(tz)
                except ValueError:
                    continue
                key = (name.lower(), state.lower(), round(lat_f, 4), round(lon_f, 4))
                if key in seen:  # IN csv duplicates the world csv
                    continue
                seen.add(key)
                batch.append((name, alts[:512], state, country, lat_f, lon_f, tz_f))
                if len(batch) >= 20000:
                    con.executemany("INSERT INTO places VALUES (?,?,?,?,?,?,?)", batch)
                    rows_written += len(batch)
                    batch = []
            if batch:
                con.executemany("INSERT INTO places VALUES (?,?,?,?,?,?,?)", batch)
                rows_written += len(batch)
    con.execute("CREATE INDEX idx_places_name ON places(name)")
    con.commit()
    con.close()
    return rows_written


def search_places(query: str, limit: int = 12) -> list[dict]:
    """Autocomplete search: exact → prefix → contains, shorter names first."""
    q = query.strip().lower()
    if len(q) < 2:
        return []
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    like_prefix, like_contains = f"{q}%", f"%{q}%"
    rows = con.execute(
        """
        SELECT * FROM (
            SELECT 0 AS rank, name, alts, state, country, lat, lon, tz FROM places
              WHERE lower(name) = :exact
            UNION ALL
            SELECT 1, name, alts, state, country, lat, lon, tz FROM places
              WHERE name LIKE :pfx COLLATE NOCASE AND lower(name) != :exact
            UNION ALL
            SELECT 2, name, alts, state, country, lat, lon, tz FROM places
              WHERE name LIKE :contains COLLATE NOCASE
                AND name NOT LIKE :pfx COLLATE NOCASE
        )
        ORDER BY rank, length(name), name
        LIMIT :lim
        """,
        {"exact": q, "pfx": like_prefix, "contains": like_contains, "lim": limit * 3},
    ).fetchall()

    # also match alternate names (e.g. 'Calcutta' → Kolkata), lower priority
    if len(rows) < limit:
        alt_rows = con.execute(
            """
            SELECT name, alts, state, country, lat, lon, tz FROM places
             WHERE alts LIKE :contains COLLATE NOCASE
               AND name NOT LIKE :contains COLLATE NOCASE
             LIMIT :lim
            """,
            {"contains": like_contains, "lim": limit},
        ).fetchall()
        rows = list(rows) + [("rank-alias", *r) for r in alt_rows]  # type: ignore[assignment]

    con.close()

    out, seen = [], set()
    for r in rows:
        rank = r[0]
        name, alts, state, country, lat, lon, tz = (
            r[1], r[2], r[3], r[4], r[5], r[6], r[7]
        ) if rank != "rank-alias" else (r[1], r[2], r[3], r[4], r[5], r[6], r[7])
        k = (name, state, round(lat, 3))
        if k in seen:
            continue
        seen.add(k)
        out.append({
            "name": name, "state": state, "country": country,
            "lat": lat, "lon": lon, "tz": tz,
            "match": "name" if rank != "rank-alias" else "alias",
        })
        if len(out) >= limit:
            break
    return out


if __name__ == "__main__":
    n = build_index()
    print(f"places.db built: {n} rows, {DB_PATH.stat().st_size / 1e6:.1f} MB")
