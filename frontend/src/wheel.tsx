import { useEffect, useMemo, useRef } from "react";
import { interpLon, unwrap, Session, SIGN_GLYPHS, SIGN_SANSKRIT, PLANET_COLORS } from "./api";

interface Props {
  session: Session;
  jd: number;
}

/** Bi-wheel: fixed natal ring + moving transit markers, drawn at playhead instant. */
export default function Wheel({ session, jd }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Unwrap sample series once per session for jump-free interpolation.
  const series = useMemo(() => {
    const s = session.samples;
    const slowUn: Record<number, number[]> = {};
    for (const k of Object.keys(s.slow)) slowUn[Number(k)] = unwrap(s.slow[Number(k)]);
    return {
      slowJds: s.slowJds,
      slow: slowUn,
      moonJds: s.moonJds,
      moon: unwrap(s.moon),
    };
  }, [session]);

  const lonAt = (pid: number): number =>
    pid === 1
      ? interpLon(series.moonJds, series.moon, jd)
      : interpLon(series.slowJds, series.slow[pid], jd);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssSize = Math.min(canvas.parentElement!.clientWidth - 8, 620);
    if (canvas.style.width !== `${cssSize}px`) {
      canvas.style.width = `${cssSize}px`;
      canvas.style.height = `${cssSize}px`;
    }
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);

    const cx = cssSize / 2, cy = cssSize / 2;
    const R = cssSize / 2 - 6;
    const rSignOuter = R, rSignInner = R * 0.86;
    const rPlanetBandIn = R * 0.60, rPlanetBandOut = R * 0.84;
    const rNatalTick = R * 0.585;
    const deg2xy = (deg: number, rIn: number, rOut: number) => {
      const a = ((deg - 90) * Math.PI) / 180; // Aries starts left (classic east-point varies; we fix Aries at 9 o'clock)
      return [cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn, cx + Math.cos(a) * rOut, cy + Math.sin(a) * rOut];
    };

    // --- background disc
    const bg = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R);
    bg.addColorStop(0, "#141a2e");
    bg.addColorStop(1, "#0d1122");
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // --- sign sectors
    for (let i = 0; i < 12; i++) {
      const a0 = i * 30 - 90, a1 = (i + 1) * 30 - 90;
      ctx.beginPath();
      ctx.arc(cx, cy, rSignOuter, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180);
      ctx.arc(cx, cy, rSignInner, (a1 * Math.PI) / 180, (a0 * Math.PI) / 180, true);
      ctx.closePath();
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.045)" : "rgba(255,255,255,0.02)";
      ctx.fill();
      ctx.strokeStyle = "rgba(212,175,55,0.18)";
      ctx.lineWidth = 0.75;
      ctx.stroke();
      // glyph
      const mid = i * 30 + 15 - 90;
      const gx = cx + Math.cos((mid * Math.PI) / 180) * (rSignInner + (rSignOuter - rSignInner) / 2);
      const gy = cy + Math.sin((mid * Math.PI) / 180) * (rSignInner + (rSignOuter - rSignInner) / 2);
      ctx.fillStyle = "#d4af37";
      ctx.font = `${Math.max(12, R * 0.06)}px Inter, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(SIGN_GLYPHS[i], gx, gy);
    }

    // --- natal marks (fixed inner ticks + faint glyph)
    const natal = session.natal;
    ctx.strokeStyle = "rgba(207,216,227,0.35)";
    for (const p of natal.planets) {
      const [x1, y1, x2, y2] = deg2xy(p.absLon, rNatalTick - 5, rNatalTick + 5);
      ctx.lineWidth = p.id === 1 ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    // ascendant line
    {
      const [x1, y1, x2, y2] = deg2xy(natal.ascendant.absLon, R * 0.10, rNatalTick);
      ctx.strokeStyle = "rgba(212,175,55,0.55)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- sade sati shading on moon-relative signs while active
    const activeSS = session.periods.sadeSati.find(s => jd >= s.startJd && jd < s.endJd);
    if (activeSS) {
      const mr = natal.moonRasi;
      const phases = [((mr - 1) % 12 + 12) % 12, mr, (mr + 1) % 12];
      for (const si of phases) {
        const a0 = si * 30 - 90, a1 = (si + 1) * 30 - 90;
        ctx.beginPath();
        ctx.arc(cx, cy, rSignInner, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180);
        ctx.arc(cx, cy, R * 0.40, (a1 * Math.PI) / 180, (a0 * Math.PI) / 180, true);
        ctx.closePath();
        ctx.fillStyle = "rgba(139,125,216,0.10)";
        ctx.fill();
      }
    }

    // --- transiting planets
    const radii = [0.80, 0.74, 0.68, 0.62, 0.77, 0.71, 0.65, 0.59, 0.56];
    type Mark = { pid: number; lon: number };
    const marks: Mark[] = [];
    for (let pid = 0; pid < 9; pid++) marks.push({ pid, lon: lonAt(pid) });
    // collision-avoid label angles (sort by lon, nudge overlapping labels)
    marks.sort((a, b) => a.lon - b.lon);
    for (const m of marks) {
      const col = PLANET_COLORS[m.pid];
      const rr = R * radii[m.pid];
      const [x1, y1, x2, y2] = deg2xy(m.lon, rPlanetBandIn - 4, rSignInner);
      ctx.strokeStyle = col + "66";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

      const px = cx + Math.cos(((m.lon - 90) * Math.PI) / 180) * rr;
      const py = cy + Math.sin(((m.lon - 90) * Math.PI) / 180) * rr;
      ctx.beginPath(); ctx.arc(px, py, R * 0.032, 0, Math.PI * 2);
      ctx.fillStyle = "#0d1122"; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1.25; ctx.stroke();

      const sym = m.pid === 7 ? "☊" : m.pid === 8 ? "☋" :
        ["☉","☾","♂","☿","♃","♀","♄"][m.pid];
      ctx.fillStyle = col;
      ctx.font = `600 ${Math.max(13, R * 0.058)}px Inter, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(sym, px, py + 0.5);

      // retrograde badge
      if (m.pid <= 6 && isRetro(series, m.pid, jd)) {
        ctx.font = `${Math.max(8, R * 0.03)}px Inter, sans-serif`;
        ctx.fillText("℞", px + R * 0.045, py - R * 0.035);
      }

      // conjunction-to-natal hint line (< 6°)
      const np = natal.planets[m.pid];
      let sep = Math.abs(m.lon - np.absLon); if (sep > 180) sep = 360 - sep;
      if (sep < 6) {
        const [nx1, ny1] = [cx + Math.cos(((np.absLon - 90) * Math.PI) / 180) * rNatalTick,
                            cy + Math.sin(((np.absLon - 90) * Math.PI) / 180) * rNatalTick];
        ctx.strokeStyle = col + "44";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(nx1, ny1); ctx.lineTo(px, py); ctx.stroke();
      }
    }
  }, [session, jd, series]);

  return (
    <div className="wheel-wrap">
      <canvas ref={canvasRef} />
      <WheelLegend session={session} />
    </div>
  );
}

function isRetro(
  series: { slowJds: number[]; slow: Record<number, number[]> },
  pid: number, jd: number
): boolean {
  const arr = series.slow[pid]; if (!arr || arr.length < 3) return false;
  const h = 2;
  const a = interpLon(series.slowJds, arr, jd - h);
  const b = interpLon(series.slowJds, arr, jd + h);
  let d = b - a; if (d > 180) d -= 360; if (d < -180) d += 360;
  return d < 0;
}

function WheelLegend({ session }: { session: Session }) {
  return (
    <div className="legend">
      <span className="legend-title">
        {session.birth.place_name} · Lahirī · asc {session.natal.ascendant.rasiName}{" "}
        {session.natal.ascendant.lonInSign.toFixed(1)}° · Moon in {SIGN_SANSKRIT[session.natal.moonRasi]}
      </span>
    </div>
  );
}
