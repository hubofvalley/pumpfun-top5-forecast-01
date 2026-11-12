'use strict';
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.MAKEFUN_INPUT_DIR || '/input';
const output = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const task = JSON.parse(fs.readFileSync(path.join(input, 'task.json'), 'utf8'));
const marks = fs.readFileSync(path.join(input, 'history.ndjson'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  .filter(m => m && m.ok && Array.isArray(m.rows) && m.rows.length && Number.isFinite(Date.parse(m.at)));
if (!marks.length) throw new Error('No ranked observations');
const last = marks[marks.length - 1];
const seen = new Map();
for (const mark of marks) for (const row of mark.rows) {
  if (!row || typeof row.mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.mint)) continue;
  if (typeof row.market_cap_lamports !== 'string' || !/^\d+$/.test(row.market_cap_lamports)) continue;
  const cap = Number(row.market_cap_lamports);
  if (!(cap > 0 && Number.isFinite(cap))) continue;
  if (!seen.has(row.mint)) seen.set(row.mint, []);
  seen.get(row.mint).push({ t: Date.parse(mark.at), x: Math.log10(cap) - 9, row });
}
const end = Date.parse(last.at);
const now = Date.parse(task.history_until);
const candidates = [...seen].map(([mint, points]) => {
  const latest = points[points.length - 1];
  const previous = points.find(p => p.t >= latest.t - 3600000) || points[0];
  const momentum = Math.max(-0.3, Math.min(0.3, latest.x - previous.x));
  const stale = Math.max(0, (end - latest.t) / 3600000);
  return { mint, x: latest.x + 0.22 * momentum - Math.min(0.5, stale * 0.12), rank: latest.row.rank };
}).sort((a, b) => b.x - a.x || a.mint.localeCompare(b.mint));
if (candidates.length < 5) throw new Error('At least five observed mints are required');
const top5 = candidates.slice(0, 5).map(c => c.mint);
// Independent normal shocks approximate uncertain future rankings. Seeded PRNG ensures reproducibility.
let seed = 14783921;
function uniform() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; }
function normal() { return Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()); }
const choices = candidates.slice(0, 60);
const counts = Array.from({length: 5}, () => new Map());
const bins = Array.from({length: 5}, () => Array(task.size.edges.length + 1).fill(0));
const iterations = 12000;
for (let i = 0; i < iterations; i++) {
  const horizon = Math.max(0, (Date.parse(task.reads[i % task.reads.length]) - now) / 3600000);
  const sigma = Math.min(0.8, 0.18 + 0.13 * Math.sqrt(horizon + 0.1));
  const scores = choices.map(c => ({mint: c.mint, x: c.x + sigma * normal()}));
  // Anonymous future launches absorb rank probability and contribute to the size distribution.
  const newCount = Math.min(30, Math.max(1, Math.round(1 + horizon * 1.2)));
  for (let j = 0; j < newCount; j++) scores.push({mint: null, x: choices[0].x - 0.55 + sigma * normal()});
  scores.sort((a, b) => b.x - a.x);
  for (let p = 0; p < 5; p++) {
    const s = scores[p];
    if (s.mint) counts[p].set(s.mint, (counts[p].get(s.mint) || 0) + 1);
    let bin = task.size.edges.findIndex(edge => s.x < edge);
    if (bin < 0) bin = task.size.edges.length;
    bins[p][bin]++;
  }
}
const probabilities = [];
const sizes = [];
for (let p = 0; p < 5; p++) {
  // Leave an explicit share to unobserved coins and low-confidence observed coins.
  for (const [mint, n] of counts[p]) {
    const probability = n / iterations * 0.72;
    if (probability >= 0.007) probabilities.push({mint, place: p + 1, p: Math.floor(probability * 1e6) / 1e6});
  }
  for (let b = 0; b < bins[p].length; b++) {
    const probability = 0.92 * bins[p][b] / iterations + 0.08 / bins[p].length;
    // Add the rounding remainder to no bin: probabilities remain safely below one.
    sizes.push({place: p + 1, bin: b, p: Math.floor(probability * 1e6) / 1e6});
  }
}
fs.mkdirSync(output, {recursive: true});
fs.writeFileSync(path.join(output, 'forecast.json'), JSON.stringify({probabilities, top5, sizes}) + '\n');
