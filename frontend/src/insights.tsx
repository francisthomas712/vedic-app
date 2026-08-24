import { useEffect, useState } from "react";
import { Session, StateResponse, jdToCivil, PLANET_COLORS, SIGN_SANSKRIT } from "./api";

interface Props {
  session: Session;
  jd: number;
}

/** Deterministic context at the paused playhead — panchanga, transits, running daśā. */
export default function Insights({ session, jd }: Props) {
  const [state, setState] = useState<StateResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const b = session.birth;

  useEffect(() => {
    // Debounced: only fetch when the playhead pauses (~350ms).
    const t = setTimeout(async () => {
      try {
        setErr(null);
        const c = jdToCivil(jd, b.tz);
        const qs = new URLSearchParams({
          year: String(c.y), month: String(c.m), day: String(c.d),
          hour: String(c.hh), minute: String(c.mm),
          lat: String(b.lat), lon: String(b.lon), tz: String(b.tz),
        });
        const res = await fetch(`/api/state?${qs}`);
        if (!res.ok) throw new Error(`state ${res.status}`);
        setState(await res.json());
      } catch (e) {
        setErr(String(e));
      }
    }, 350);
    return () => clearTimeout(t);
  }, [Math.round(jd * 24) / 24, b.lat, b.lon, b.tz]); // eslint-disable-line react-hooks/exhaustive-deps

  const chain = state?.runningDasha ?? [];
  const ssActive = session.periods.sadeSati.find(s => jd >= s.startJd && jd < s.endJd);

  return (
    <div className="insights">
      {err && <div className="card error-card">state error: {err}</div>}

      <div className="card">
        <h3>Running Daśā</h3>
        {chain.length === 0 && <p className="muted">computing…</p>}
        {chain.map((n, i) => (
          <div key={i} className="chain-row">
            <span className="dot" style={{ background: PLANET_COLORS[n.lord] }} />
            <span className={"chain-lord" + (i === 0 ? " big" : "")}>{n.lordName}</span>
            <span className="muted">{jdToCivil(n.startJd, b.tz).dateStr.slice(0, 4)} → {jdToCivil(n.endJd, b.tz).dateStr.slice(0, 4)}</span>
            <span className="years-left">({((n.endJd - jd) / 365.2425).toFixed(1)}y left)</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Panchanga</h3>
        {state ? (
          <>
            <Row k="Tithi" v={tithiStr(state)} />
            <Row k="Nakshatra" v={nakStr(state)} />
            <Row k="Sunrise" v={state.panchanga.sunriseLocal ?? "—"} />
            <Row k="Sunset" v={state.panchanga.sunsetLocal ?? "—"} />
            <Row k="Weekday" v={weekday(jd)} />
          </>
        ) : <p className="muted">…</p>}
      </div>

      <div className="card">
        <h3>Transits</h3>
        {ssActive && (
          <div className="sadesati-note">Sade Sati · {ssActive.phase} phase
            <span className="muted"> ({ssActive.startISO.slice(0, 10)} → {ssActive.endISO.slice(0, 10)})</span>
          </div>
        )}
        <table className="transit-table">
          <thead><tr><th></th><th>Sign</th><th>°</th><th>House¹</th><th>Dignity</th></tr></thead>
          <tbody>
            {(state?.transits ?? []).map(t => (
              <tr key={t.id}>
                <td><span className="dot" style={{ background: PLANET_COLORS[t.id] }} />{t.symbol}{t.retrograde && <sup>℞</sup>}</td>
                <td>{SIGN_SANSKRIT[t.rasi]}</td>
                <td>{degInSign(t.absLon)}</td>
                <td>{t.houseFromMoon}</td>
                <td><span className={`dig dig-${(t.dignity ?? "none").replace(" ", "-")}`}>{t.dignity ?? "—"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">¹ counted from natal Moon (Candra lagna)</p>
      </div>
    </div>
  );
}

const tithiStr = (s: StateResponse) => {
  const t = s.panchanga.tithi as any;
  return t.name ? `${t.paksha} ${t.name}` : String(t.raw ?? "");
};
const nakStr = (s: StateResponse) => {
  const n = s.panchanga.nakshatra as any;
  return n.name ? `${n.name} pada ${n.pada}` : String(n.raw ?? "");
};
const degInSign = (lon: number) => {
  const d = lon % 30;
  return `${Math.floor(d)}°${String(Math.floor((d % 1) * 60)).padStart(2, "0")}′`;
};
const weekday = (jd: number) =>
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Math.floor(jd + 1.5) % 7];

function Row({ k, v }: { k: string; v: string }) {
  return <div className="row"><span className="k">{k}</span><span className="v">{v}</span></div>;
}
