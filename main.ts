// Adaptive, deterministic forecast for pumpfun-top5-forecast-01.
// It combines current market-cap level, short/long momentum, graduation maturity,
// rank persistence and a conservative allowance for coins launched after the cut.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = {
  rank: number;
  mint: string;
  market_cap_lamports: string | number;
  venue?: string;
  complete?: boolean;
  mayhem?: boolean;
  created_at?: string;
};
type Mark = { at: string; ok: boolean; rows?: Row[] | null };
type Observation = Row & { index: number; logCap: number };
type Candidate = {
  mint: string;
  observations: Observation[];
  last: Observation;
  recentSlope: number;
  longSlope: number;
  trend: number;
  predictedLogCap: number;
  score: number;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outputDir, { recursive: true });

const task = JSON.parse(readFileSync(join(inputDir, 'task.json'), 'utf8')) as {
  places: number;
  output: string;
  history_until?: string;
  reads?: string[];
  cadence_minutes?: number;
  size: { edges: number[] };
};
const marks = readFileSync(join(inputDir, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Mark)
  .filter((mark) => mark.ok === true && Array.isArray(mark.rows));
if (marks.length === 0) throw new Error('history has no usable marks');

const cadenceHours = (task.cadence_minutes ?? 10) / 60;
const lastIndex = marks.length - 1;
const answerAt = task.reads?.at(-1);
const horizonHours = Math.max(
  1,
  answerAt && task.history_until
    ? (Date.parse(answerAt) - Date.parse(task.history_until)) / 3_600_000
    : 1,
);
const effectiveHours = Math.min(horizonHours, 5);
const macroGrowth = 0.10 * Math.sqrt(horizonHours);

const logCap = (value: string | number): number => {
  try {
    return Math.log10(Number(BigInt(value))) - 9;
  } catch {
    return -Infinity;
  }
};
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

const states = new Map<string, Observation[]>();
for (let index = 0; index <= lastIndex; index += 1) {
  for (const row of marks[index].rows ?? []) {
    const observation: Observation = { ...row, index, logCap: logCap(row.market_cap_lamports) };
    const history = states.get(row.mint) ?? [];
    history.push(observation);
    states.set(row.mint, history);
  }
}

const candidates: Candidate[] = [];
for (const [mint, observations] of states) {
  observations.sort((a, b) => a.index - b.index);
  const last = observations[observations.length - 1]!;
  const previous = observations.length > 1 ? observations[observations.length - 2] : undefined;
  const elapsedRecent = previous ? Math.max(cadenceHours, (last.index - previous.index) * cadenceHours) : cadenceHours;
  const recentSlope = previous ? (last.logCap - previous.logCap) / elapsedRecent : 0;
  const first = observations[0]!;
  const elapsedLong = Math.max(cadenceHours, (last.index - first.index) * cadenceHours);
  const longSlope = observations.length > 2 ? (last.logCap - first.logCap) / elapsedLong : recentSlope;
  const trend = clamp(0.7 * recentSlope + 0.3 * longSlope, -0.18, 0.18);
  const staleMarks = lastIndex - last.index;
  const graduationBonus = last.venue === 'pool' ? 0.10 : last.complete ? 0.05 : 0;
  const rankPrior = Number.isFinite(last.rank) ? -0.001 * last.rank : -0.2;
  const stabilityBonus = Math.min(0.06, observations.length * 0.01);
  const predictedLogCap = last.logCap + trend * effectiveHours + macroGrowth;
  const score = predictedLogCap + graduationBonus + stabilityBonus + rankPrior - 0.04 * staleMarks;
  candidates.push({ mint, observations, last, recentSlope, longSlope, trend, predictedLogCap, score });
}

candidates.sort((a, b) => b.score - a.score || a.mint.localeCompare(b.mint));
if (candidates.length < task.places) throw new Error('only ' + candidates.length + ' candidates for ' + task.places + ' places');

// A longer horizon makes both new entrants and rank reversals more likely. Keep
// meaningful probability mass unnamed so the scorer can credit that uncertainty.
const namedMass = clamp(0.72 - 0.012 * horizonHours, 0.55, 0.72);
const temperature = 0.22 + 0.03 * Math.sqrt(horizonHours);
const probabilities: Array<{ mint: string; place: number; p: number }> = [];
for (let place = 1; place <= task.places; place += 1) {
  const sigma = 1.15 + 0.18 * place + 0.035 * horizonHours;
  const top = candidates.slice(0, Math.min(100, candidates.length));
  const weights = top.map((candidate, index) => {
    const rankDistance = (index - (place - 1)) / sigma;
    const scoreWeight = (candidate.score - candidates[0]!.score) / temperature;
    return Math.exp(-0.5 * rankDistance * rankDistance + scoreWeight);
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < top.length; index += 1) {
    const p = namedMass * weights[index]! / total;
    if (p > 1e-7) probabilities.push({ mint: top[index]!.mint, place, p: Number(p.toFixed(10)) });
  }
}

// Forecast each place's log10 market-cap size with a broad normal distribution.
// The broad tails cover growth and coins born after the history cut without
// making the forecast entirely flat.
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const normalCdf = (x: number, mean: number, sd: number): number =>
  0.5 * erfc(-(x - mean) / (sd * Math.SQRT2));
const edges = task.size.edges;
const sizes: Array<{ place: number; bin: number; p: number }> = [];
for (let place = 1; place <= task.places; place += 1) {
  const center = candidates[place - 1]!.predictedLogCap;
  const neighbour = candidates[place]?.predictedLogCap ?? center;
  const mean = 0.78 * center + 0.22 * neighbour;
  const sd = 0.55 + 0.02 * horizonHours + 0.02 * place;
  const raw: number[] = [];
  for (let bin = 0; bin <= edges.length; bin += 1) {
    const lo = bin === 0 ? -Infinity : edges[bin - 1]!;
    const hi = bin === edges.length ? Infinity : edges[bin]!;
    raw.push(normalCdf(hi, mean, sd) - normalCdf(lo, mean, sd));
  }
  const total = raw.reduce((sum, value) => sum + value, 0);
  for (let bin = 0; bin < raw.length; bin += 1) {
    const p = 0.98 * raw[bin]! / total;
    if (p > 1e-8) sizes.push({ place, bin, p: Number(p.toFixed(10)) });
  }
}

const top5 = candidates.slice(0, task.places).map((candidate) => candidate.mint);
const forecast = { probabilities, top5, sizes };
writeFileSync(join(outputDir, task.output), JSON.stringify(forecast) + '\n');
