import { Session, DashaNode, PLANET_COLORS } from "./api";

interface LaneProps {
  session: Session;
  jd: number;
  onJump: (jd: number) => void;
}

function findActive(nodes: DashaNode[], jd: number): DashaNode | null {
  return nodes.find(n => jd >= n.startJd && jd < n.endJd) ?? null;
}

/** Three stacked daśā lanes (Mahā / Antara / Pratyantar) with a shared playhead. */
export default function DashaLanes({ session, jd, onJump }: LaneProps) {
  const maha = session.dashaTree;
  const activeMaha = findActive(maha, jd);
  const antara = activeMaha?.children ?? [];
  const activeAntara = findActive(antara, jd);
  const praty = activeAntara?.children ?? [];

  const t0 = maha[0]?.startJd ?? 0;
  const t1 = maha[maha.length - 1]?.endJd ?? 1;
  const pctOf = (n: DashaNode) => ({
    left: ((Math.max(n.startJd, t0) - t0) / (t1 - t0)) * 100,
    width: Math.max(((Math.min(n.endJd, t1) - n.startJd) / (t1 - t0)) * 100, 0.15),
    active: jd >= n.startJd && jd < n.endJd,
  });

  return (
    <div className="lanes">
      <Lane title="Mahādaśā" span={`${yr(t0)} – ${yr(t1)}`}>
        {maha.map(n => {
          const p = pctOf(n);
          return (
            <Segment key={`m${n.lord}-${n.startJd}`} node={n} pct={p} onJump={onJump}
              label={p.width > 4 ? n.lordName : ""} />
          );
        })}
      </Lane>
      <Lane title="Antara" span={activeMaha ? `${activeMaha.lordName} · ${yr(activeMaha.startJd)}–${yr(activeMaha.endJd)}` : "—"}>
        {antara.map((n, i) => {
          // scale antara segments within the parent's own window
          const left = ((n.startJd - activeMaha!.startJd) / (activeMaha!.endJd - activeMaha!.startJd)) * 100;
          const width = ((n.endJd - n.startJd) / (activeMaha!.endJd - activeMaha!.startJd)) * 100;
          return (
            <Segment key={`a${i}`} node={n} pct={{ left, width, active: jd >= n.startJd && jd < n.endJd }}
              onJump={onJump} label={width > 5.5 ? n.lordName : ""} />
          );
        })}
      </Lane>
      <Lane title="Pratyantar" span={activeAntara ? `${activeAntara.lordName} · ${yr(activeAntara.startJd)}–${yr(activeAntara.endJd)}` : "—"}>
        {praty.map((n, i) => {
          const left = ((n.startJd - activeAntara!.startJd) / (activeAntara!.endJd - activeAntara!.startJd)) * 100;
          const width = ((n.endJd - n.startJd) / (activeAntara!.endJd - activeAntara!.startJd)) * 100;
          return (
            <Segment key={`p${i}`} node={n} pct={{ left, width, active: jd >= n.startJd && jd < n.endJd }}
              onJump={onJump} label={""} />
          );
        })}
      </Lane>
    </div>
  );
}

const yr = (jd: number) => new Date((jd - 2440587.5) * 86400_000).getUTCFullYear();

function Lane({ title, span, children }: { title: string; span: string; children: React.ReactNode }) {
  return (
    <div className="lane-row">
      <div className="lane-meta">
        <span className="lane-title">{title}</span>
        <span className="lane-span">{span}</span>
      </div>
      <div className="lane">{children}</div>
    </div>
  );
}

function Segment({ node, pct, onJump, label }: {
  node: DashaNode;
  pct: { left: number; width: number; active: boolean };
  onJump: (jd: number) => void;
  label: string;
}) {
  const col = PLANET_COLORS[node.lord] ?? "#888";
  return (
    <button
      className={"seg" + (pct.active ? " seg-active" : "")}
      style={{
        left: `${pct.left}%`, width: `${pct.width}%`,
        background: `linear-gradient(180deg, ${col}cc, ${col}77)`,
        outlineColor: col,
      }}
      onClick={() => onJump(node.startJd)}
      title={`${node.lordName}: ${new Date((node.startJd - 2440587.5) * 86400_000).toUTCString().slice(5, 16)} → ${new Date((node.endJd - 2440587.5) * 86400_000).toUTCString().slice(5, 16)}`}
    >
      {label}
    </button>
  );
}
