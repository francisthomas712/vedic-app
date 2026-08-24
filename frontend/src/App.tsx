import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BirthData, PlaceResult, Session, civilToJd, createSession, jdToCivil, placeLabel, searchPlaces, tzLabel } from "./api";
import Wheel from "./wheel";
import DashaLanes from "./dasha";
import Timeline from "./timeline";
import Insights from "./insights";

const SPEEDS: Array<{ label: string; daysPerSec: number }> = [
  { label: "1 d/s", daysPerSec: 1 },
  { label: "10 d/s", daysPerSec: 10 },
  { label: "100 d/s", daysPerSec: 100 },
  { label: "1 y/s", daysPerSec: 365.25 },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jd, setJd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(2);
  const raf = useRef<number | null>(null);

  const load = useCallback(async (birth: BirthData) => {
    setLoading(true); setError(null); setPlaying(false);
    try {
      const s = await createSession(birth);
      setSession(s);
      setJd(s.meta.jdBirth);
      localStorage.setItem("vedic.birth", JSON.stringify(birth));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // restore last chart or load the demo one
  useEffect(() => {
    const saved = localStorage.getItem("vedic.birth");
    if (saved) { try { load(JSON.parse(saved)); return; } catch { /* fallthrough */ } }
    load(DEMO_BIRTH);
  }, [load]);

  // playback loop
  useEffect(() => {
    if (!playing || !session) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setJd(prev => Math.min(prev + SPEEDS[speedIdx].daysPerSec * dt, session.meta.range.toJd));
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, speedIdx, session]);

  // stop at range end
  useEffect(() => {
    if (session && jd >= session.meta.range.toJd - 1) setPlaying(false);
  }, [jd, session]);

  // keyboard: space play/pause, ←/→ nudge
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!session) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Space") { e.preventDefault(); setPlaying(p => !p); }
      if (e.key === "ArrowRight") setJd(v => Math.min(v + 30, session.meta.range.toJd));
      if (e.key === "ArrowLeft") setJd(v => Math.max(v - 30, session.meta.range.fromJd));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  const civil = useMemo(() => session ? jdToCivil(jd, session.birth.tz) : null, [jd, session]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">ॐ</span>
          <div>
            <h1>Vedic Visualizer</h1>
            <p>deterministic timelines · no predictions</p>
          </div>
        </div>
        <BirthForm initial={session?.birth ?? DEMO_BIRTH} busy={loading} onSubmit={load} />
      </header>

      {error && <div className="banner error">{error}</div>}
      {loading && <div className="banner">computing a 120-year sky… first load takes a few seconds.</div>}

      {session && (
        <main className="layout">
          <section className="left">
            <Wheel session={session} jd={jd} />

            <div className="transport card">
              <button className="play" onClick={() => setPlaying(p => !p)} aria-label={playing ? "pause" : "play"}>
                {playing ? "⏸" : "▶"}
              </button>
              <div className="datebox">
                <span className="date-big">{civil!.dateStr}</span>
                <span className="time-muted">{civil!.timeStr} · JD {jd.toFixed(2)}</span>
              </div>
              <div className="speeds">
                {SPEEDS.map((s, i) => (
                  <button key={i} className={i === speedIdx ? "on" : ""} onClick={() => setSpeedIdx(i)}>{s.label}</button>
                ))}
              </div>
              <button className="ghost" onClick={() => setJd(session.meta.jdBirth)}>birth</button>
              <button className="ghost" onClick={() => setJd(Date.now() / 86400_000 + 2440587.5)}>today</button>
              <span className="hint">space = play/pause · ←/→ = ±30d</span>
            </div>

            <DashaLanes session={session} jd={jd} onJump={(v) => { setPlaying(false); setJd(v); }} />
            <Timeline session={session} jd={jd} onScrub={(v) => { setPlaying(false); setJd(v); }}
              onJump={(v) => { setPlaying(false); setJd(v); }} />
          </section>

          <aside className="right">
            <Insights session={session} jd={jd} />
          </aside>
        </main>
      )}

      <footer className="footer">
        Computed locally from Swiss Ephemeris via PyJHora · Lahiri ayanāṃśa ·
        every insight traces to classical rules, none to generative models.
      </footer>
    </div>
  );
}

const DEMO_BIRTH: BirthData = {
  year: 1990, month: 5, day: 15, hour: 10, minute: 30,
  lat: 13.0878, lon: 80.2782, tz: 5.5, place_name: "Chennai",
};

function BirthForm({ initial, busy, onSubmit }: {
  initial: BirthData; busy: boolean; onSubmit: (b: BirthData) => void;
}) {
  const [f, setF] = useState<BirthData>(initial);
  const [query, setQuery] = useState<string>(initial.place_name);
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [manual, setManual] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setF(initial);
    setQuery(initial.place_name);
  }, [initial]);

  // debounced place autocomplete
  useEffect(() => {
    if (manual || query.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      const r = await searchPlaces(query.trim(), 8);
      setResults(r);
      setOpen(r.length > 0);
      setHighlight(0);
    }, 180);
    return () => clearTimeout(t);
  }, [query, manual]);

  // click-outside closes the dropdown
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (p: PlaceResult) => {
    setF({ ...f, place_name: p.name, lat: p.lat, lon: p.lon, tz: p.tz });
    setQuery(placeLabel(p));
    setOpen(false);
  };

  const resolved = !manual && Math.abs(f.lat) + Math.abs(f.lon) > 0.01;

  const setNum = (k: keyof BirthData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value === "" ? 0 : Number(e.target.value) });

  return (
    <form
      className="birth-form"
      onSubmit={(e) => { e.preventDefault(); setOpen(false); onSubmit(f); }}
    >
      {/* ---- place search ---- */}
      <div className="place-wrap" ref={wrapRef}>
        <input
          className="wide"
          placeholder="Birthplace — type a city…"
          aria-label="Birthplace"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setManual(false); }}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={(e) => {
            if (!open || results.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(h => (h + 1) % results.length); }
            if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(h => (h - 1 + results.length) % results.length); }
            if (e.key === "Enter" && open) { e.preventDefault(); pick(results[highlight]); }
            if (e.key === "Escape") setOpen(false);
          }}
        />
        {open && (
          <div className="place-dd" role="listbox">
            {results.map((p, i) => (
              <button type="button" key={`${p.name}-${p.lat}-${p.lon}-${i}`}
                role="option" aria-selected={i === highlight}
                className={"place-opt" + (i === highlight ? " hl" : "")}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(p)}>
                <span className="place-opt-name">{p.name}</span>
                <span className="place-opt-meta">{[p.state, p.country].filter(Boolean).join(", ")} · {tzLabel(p.tz)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---- date & time ---- */}
      <div className="dt-group" title="Date of birth (local)">
        <input type="number" required min={1800} max={2400} value={f.year} onChange={setNum("year")} aria-label="Year" placeholder="YYYY" />
        <input type="number" required min={1} max={12} value={f.month} onChange={setNum("month")} aria-label="Month" placeholder="MM" />
        <input type="number" required min={1} max={31} value={f.day} onChange={setNum("day")} aria-label="Day" placeholder="DD" />
      </div>
      <div className="dt-group" title="Local clock time at the birthplace">
        <input type="number" required min={0} max={23} value={f.hour} onChange={setNum("hour")} aria-label="Hour" placeholder="HH" />
        <span className="dt-colon">:</span>
        <input type="number" required min={0} max={59} value={f.minute} onChange={setNum("minute")} aria-label="Minute" placeholder="MM" />
      </div>

      <button type="submit" disabled={busy}>{busy ? "Casting…" : "Cast chart"}</button>

      {/* ---- resolved place summary / manual override ---- */}
      {manual ? (
        <div className="manual-row">
          <label>lat<input type="number" step="0.0001" required value={f.lat} onChange={setNum("lat")} aria-label="Latitude (+N)" /></label>
          <label>lon<input type="number" step="0.0001" required value={f.lon} onChange={setNum("lon")} aria-label="Longitude (+E)" /></label>
          <label>tz<input type="number" step="0.5" required value={f.tz} onChange={setNum("tz")} aria-label="UTC offset hours" /></label>
          <button type="button" className="link-btn" onClick={() => setManual(false)}>use search</button>
        </div>
      ) : (
        <div className={"place-meta" + (resolved ? "" : " warn")}>
          {resolved ? (
            <>
              {f.place_name} · {fmtCoord(f.lat, "N", "S")} {fmtCoord(f.lon, "E", "W")} · {tzLabel(f.tz)}
              <button type="button" className="link-btn" onClick={() => setManual(true)}>adjust</button>
            </>
          ) : (
            <>pick a place from the list — coordinates & timezone fill in automatically
              <button type="button" className="link-btn" onClick={() => setManual(true)}>enter manually</button>
            </>
          )}
        </div>
      )}
    </form>
  );
}

function fmtCoord(v: number, pos: string, neg: string) {
  const hemi = v >= 0 ? pos : neg;
  const a = Math.abs(v);
  const deg = Math.floor(a);
  const min = Math.round((a - deg) * 60);
  return `${deg}°${String(min).padStart(2, "0")}′${hemi}`;
}
