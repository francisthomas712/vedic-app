import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BirthData, Session, civilToJd, createSession, jdToCivil } from "./api";
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
  useEffect(() => setF(initial), [initial]);
  const set = (k: keyof BirthData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: Number(e.target.value) });

  return (
    <form
      className="birth-form"
      onSubmit={(e) => { e.preventDefault(); onSubmit(f); }}
    >
      <input placeholder="place name" value={f.place_name}
        onChange={(e) => setF({ ...f, place_name: e.target.value })} className="wide" />
      <input type="number" required min={1800} max={2400} value={f.year} onChange={set("year")} title="year" />
      <input type="number" required min={1} max={12} value={f.month} onChange={set("month")} title="month" />
      <input type="number" required min={1} max={31} value={f.day} onChange={set("day")} title="day" />
      <input type="number" required min={0} max={23} value={f.hour} onChange={set("hour")} title="local hour" />
      <input type="number" min={0} max={59} value={f.minute} onChange={set("minute")} title="minute" />
      <input type="number" step="0.0001" required value={f.lat} onChange={set("lat")} title="latitude (+N)" placeholder="lat" />
      <input type="number" step="0.0001" required value={f.lon} onChange={set("lon")} title="longitude (+E)" placeholder="lon" />
      <input type="number" step="0.5" required value={f.tz} onChange={set("tz")} title="timezone offset (hours)" placeholder="tz" />
      <button type="submit" disabled={busy}>{busy ? "…" : "Cast chart"}</button>
    </form>
  );
}
