// Types mirroring the backend JSON contract exactly.
export interface PlanetPos {
  id: number; key: string; name: string; symbol: string;
  rasi: number; rasiName: string; lonInSign: number; absLon: number;
  retrograde: boolean | null; stationary?: boolean | null;
  nakshatra: string; pada: number; dignity: string | null;
}
export interface Ascendant { rasi: number; rasiName: string; lonInSign: number; absLon: number; nakshatra: string; symbol: string }
export interface Natal { ascendant: Ascendant; planets: PlanetPos[]; moonRasi: number }

export interface DashaNode {
  lord: number; lordName: string;
  startJd: number; endJd: number; startISO?: string;
  children?: DashaNode[];
}

export interface Samples {
  jd0: number; slowStepDays: number; slowJds: number[];
  slow: Record<string, number[]>;
  moonJds: number[]; moon: number[];
}

export interface VEvent {
  jd: number; iso: string | null; kind: "ingress" | "station" | "eclipse" | "dasha";
  label: string; planet?: number; planetName?: string; intoRasi?: number;
  body?: string; depth?: number; lordName?: string;
}
export interface SadeSatiPeriod { startJd: number; endJd: number; phase: string; label: string; startISO: string; endISO: string }

export interface Session {
  birth: BirthData;
  meta: { ayanamsa: string; jdBirth: number; range: { fromJd: number; toJd: number } };
  natal: Natal;
  dashaTree: DashaNode[];
  samples: Samples;
  events: VEvent[];
  periods: { sadeSati: SadeSatiPeriod[] };
  generatedAt: string;
}

export interface BirthData {
  year: number; month: number; day: number; hour: number; minute: number;
  lat: number; lon: number; tz: number; place_name: string;
}

export interface StateResponse {
  jd: number;
  panchanga: {
    tithi: { index: number; paksha: string; name: string; progress: number } | { raw: string };
    nakshatra: { index: number; name: string; pada: number } | { raw: string };
    sunriseLocal: string | null; sunsetLocal: string | null;
  };
  transits: Array<{
    id: number; name: string; symbol: string; absLon: number; rasi: number; rasiName: string;
    retrograde: boolean | null; stationary?: boolean | null; dignity: string | null;
    houseFromAscendant: number; houseFromMoon: number; conjunctNatalDeg: number;
  }>;
  runningDasha: Array<{ lord: number; lordName: string; startJd: number; endJd: number }>;
}

export const PLANET_COLORS: Record<number, string> = {
  0: "#f5b942", // Sun — gold
  1: "#cfd8e3", // Moon — silver
  2: "#e05a4e", // Mars — red
  3: "#7ac74f", // Mercury — green
  4: "#f2d16b", // Jupiter — warm yellow
  5: "#e88fb0", // Venus — rose
  6: "#8b7dd8", // Saturn — violet-indigo
  7: "#9a86b8", // Rahu — smoky purple
  8: "#a08363", // Ketu — earth brown
};

export const SIGN_KEYS = [
  "aries","taurus","gemini","cancer","leo","virgo",
  "libra","scorpio","sagittarius","capricorn","aquarius","pisces",
];
export const SIGN_GLYPHS = ["♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓"];
export const SIGN_SANSKRIT = ["Mesha","Vrishabha","Mithuna","Karka","Simha","Kanya","Tula","Vrischika","Dhanu","Makara","Kumbha","Meena"];

export async function createSession(birth: BirthData): Promise<Session> {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(birth),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `session failed (${res.status})`);
  return res.json();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** jd (UTC absolute) -> local civil datetime parts at birth-place offset */
export function jdToCivil(jd: number, tzHours: number) {
  const dt = new Date((jd - 2440587.5) * 86400_000);
  const shifted = new Date(dt.getTime() + tzHours * 3600_000);
  return {
    y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(), mm: shifted.getUTCMinutes(),
    dateStr: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    timeStr: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

export function civilToJd(y: number, m: number, d: number, hh: number, mm: number, tzHours: number): number {
  return Date.UTC(y, m - 1, d, hh, mm) / 86400_000 + 2440587.5 - tzHours / 24;
}

/** Linear interp over an unwrapped sample series. */
export function interpLon(jds: number[], valsUnwrapped: number[], jd: number): number {
  const n = jds.length;
  if (jd <= jds[0]) return ((valsUnwrapped[0] % 360) + 360) % 360;
  if (jd >= jds[n - 1]) return ((valsUnwrapped[n - 1] % 360) + 360) % 360;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (jds[mid] <= jd) lo = mid; else hi = mid; }
  const t = (jd - jds[lo]) / (jds[hi] - jds[lo]);
  const v = valsUnwrapped[lo] + t * (valsUnwrapped[hi] - valsUnwrapped[lo]);
  return ((v % 360) + 360) % 360;
}

/** Unwrap mod-360 samples into continuous angles so interpolation never jumps. */
export function unwrap(vals: number[]): number[] {
  const out = [vals[0]];
  for (let i = 1; i < vals.length; i++) {
    let d = vals[i] - vals[i - 1];
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    out.push(out[i - 1] + d);
  }
  return out;
}
