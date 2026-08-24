import { Session, VEvent } from "./api";

interface Props {
  session: Session;
  jd: number;
  onScrub: (jd: number) => void;
  onJump: (jd: number) => void;
}

const KIND_COLOR: Record<string, string> = {
  ingress: "#7ac74f",
  station: "#e05a4e",
  eclipse: "#f2d16b",
  dasha: "#8b7dd8",
};

/** Event-dense timeline with sade-sati bands and draggable playhead. */
export default function Timeline({ session, jd, onScrub, onJump }: Props) {
  const t0 = session.meta.range.fromJd;
  const t1 = session.meta.range.toJd;
  const toPct = (v: number) => ((v - t0) / (t1 - t0)) * 100;

  const yearTicks: number[] = [];
  for (let y = Math.ceil(jToYear(t0)); y <= jToYear(t1); y += 10) yearTicks.push(y);

  // events within ±window of playhead for the insight list
  const near = nearestEvents(session.events, jd, 8);

  return (
    <div className="timeline-block">
      <div
        className="timeline"
        role="slider"
        aria-label="time"
        aria-valuenow={Math.round(jd)}
        tabIndex={0}
        onMouseDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture((e.nativeEvent as PointerEvent).pointerId);
          const move = (ev: PointerEvent) => {
            const rect = el.getBoundingClientRect();
            const f = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1);
            onScrub(t0 + f * (t1 - t0));
          };
          move(e as unknown as PointerEvent);
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
        }}
      >
        {/* decade ticks */}
        {yearTicks.map(y => (
          <div key={y} className="tick" style={{ left: `${((yearToJd(y) - t0) / (t1 - t0)) * 100}%` }}>
            <span>{y % 100 === 0 || y === Math.ceil(jToYear(t0)) ? y : "'" + String(y).slice(2)}</span>
          </div>
        ))}

        {/* sade sati bands */}
        {session.periods.sadeSati.map((s, i) => (
          <div key={i} className="ss-band"
            style={{ left: `${toPct(s.startJd)}%`, width: `${toPct(s.endJd) - toPct(s.startJd)}%` }}
            title={s.label} />
        ))}

        {/* event marks */}
        {session.events.map((e, i) =>
          e.kind === "dasha" && (e.depth ?? 1) > 1 ? null : (
            <button key={i} className={"mark mark-" + e.kind}
              style={{ left: `${toPct(e.jd)}%`, background: KIND_COLOR[e.kind] }}
              onClick={() => onJump(e.jd)}
              title={e.label} />
          )
        )}

        {/* birth marker */}
        <div className="birth-mark" style={{ left: `${toPct(session.meta.jdBirth)}%` }} title="birth" />

        {/* playhead */}
        <div className="playhead" style={{ left: `${toPct(jd)}%` }} />
      </div>

      <div className="near-events">
        <h3>Around this moment</h3>
        <ul>
          {near.map((e, i) => (
            <li key={i}>
              <span className="dot" style={{ background: KIND_COLOR[e.kind] }} />
              <button onClick={() => onJump(e.jd)}>
                {e.iso?.slice(0, 10) ?? fmt(e.jd)} — {e.label}
              </button>
            </li>
          ))}
          {near.length === 0 && <li className="muted">no marked events nearby</li>}
        </ul>
      </div>
    </div>
  );
}

function nearestEvents(events: VEvent[], jd: number, k: number): VEvent[] {
  const idx = binarySearch(events, jd);
  const out: VEvent[] = [];
  let lo = idx - 1, hi = idx;
  while (out.length < k && (lo >= 0 || hi < events.length)) {
    if (lo >= 0 && (hi >= events.length || jd - events[lo].jd <= events[hi].jd - jd)) out.push(events[lo--]);
    else out.push(events[hi++]);
  }
  return out;
}
function binarySearch(events: VEvent[], jd: number): number {
  let lo = 0, hi = events.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (events[mid].jd < jd) lo = mid + 1; else hi = mid - 1; }
  return lo;
}
const jToYear = (jd: number) => 1970 + (jd - 2440587.5) / 365.2425;
const yearToJd = (y: number) => 2440587.5 + (y - 1970) * 365.2425;
const fmt = (jd: number) => new Date((jd - 2440587.5) * 86400_000).toISOString().slice(0, 10);
