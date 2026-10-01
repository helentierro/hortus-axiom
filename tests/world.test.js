'use strict';
const { loadSandbox } = require('./harness');

const sb = loadSandbox();
const HX = sb.HX;

console.log('--- HORTUS world test ---');
let t0 = Date.now();
const world = new HX.World({ seed: 'hortus-01', w: 220, h: 140 });
console.log('generate ms      :', Date.now() - t0);
console.log('cells            :', world.grid.size);
console.log('seaLevel         :', world.seaLevel.toFixed(4));
console.log('land fraction    :', world.coverage.land.toFixed(3));
console.log('peak elevation   :', world.coverage.peak.toFixed(3));
console.log('river cells      :', world.riverCells);

const hist = world.biomeHistogram();
let rows = [];
HX.BIOMES.forEach((b, i) => {
  rows.push([b.key, hist[i], (hist[i] / world.grid.size * 100).toFixed(1) + '%']);
});
console.table(rows);

const st = world.stats();
console.log('stats:', {
  snow: st.snow.toFixed(3), veg: st.veg.toFixed(3), vegSat: st.vegSaturation.toFixed(3),
  moist: st.moist.toFixed(3), temp: st.temp.toFixed(3), dominant: st.dominantBiomeName
});

/* determinism check */
const w2 = new HX.World({ seed: 'hortus-01', w: 220, h: 140 });
let same = true;
for (let i = 0; i < world.elev.length; i += 7) {
  if (Math.abs(world.elev[i] - w2.elev[i]) > 1e-6) { same = false; break; }
}
console.log('deterministic    :', same);
const w3 = new HX.World({ seed: 'other-seed', w: 220, h: 140 });
let diff = 0;
for (let i = 0; i < world.elev.length; i += 7) if (Math.abs(world.elev[i] - w3.elev[i]) > 1e-6) diff++;
console.log('different seed differs:', diff > 0);

/* biome invariants */
let bad = 0;
for (let i = 0; i < world.grid.size; i++) {
  const isW = world.water[i] > 0.02;
  const isWaterBiome = world.biome[i] <= 2 || world.biome[i] === 8;
  if (isW !== isWaterBiome && world.biome[i] !== 14 && world.biome[i] !== 16 && world.biome[i] !== 17) bad++;
}
console.log('biome/land mismatches:', bad);

/* running a few climate steps */
t0 = Date.now();
world.advanceTime(0.5);
for (let k = 0; k < 30; k++) {
  world.advanceTime(1);
  world.rollWeather(1);
  world.stepLiving(1);
}
console.log('30 days climate ms:', Date.now() - t0);
console.log('after 30d:', {
  day: world.time.day, season: world.time.seasonName,
  veg: world.stats().veg.toFixed(3), snow: world.stats().snow.toFixed(3)
});

/* neighbour table sanity */
const g = world.grid;
let nbrOk = 0, nbrBad = 0;
for (let i = 0; i < g.size; i += 13) {
  let cnt = 0;
  for (let d = 0; d < 6; d++) if (g.nbr[i * 6 + d] >= 0) cnt++;
  const interior = g.col[i] > 0 && g.col[i] < g.w - 1 && g.row[i] > 0 && g.row[i] < g.h - 1;
  if (interior && cnt === 6) nbrOk++;
  if (interior && cnt !== 6) nbrBad++;
}
console.log('interior cells with 6 neighbours:', nbrOk, 'bad:', nbrBad);

/* direction / distance */
let dirBad = 0;
for (let i = 0; i < g.size; i += 29) {
  for (let d = 0; d < 6; d++) {
    const nb = g.nbr[i * 6 + d];
    if (nb < 0) continue;
    const back = g.directionTo(i, nb);
    if (back < 0 || g.directionTo(nb, i) !== HX.DIRS[d].__op) { /* noop */ }
    if (back !== d) { dirBad++; }
  }
}
console.log('directionTo mismatches:', dirBad);

let distBad = 0;
for (let i = 0; i < g.size; i += 31) {
  for (let d = 0; d < 6; d++) {
    const nb = g.nbr[i * 6 + d];
    if (nb < 0) continue;
    if (g.distance(i, nb) !== 1) distBad++;
  }
}
console.log('neighbour distance errors:', distBad);

/* disc */
let discBad = 0;
for (let i = 0; i < g.size; i += 53) {
  const d2 = g.disc(i, 2);
  const seen = new Set(d2);
  if (seen.size !== d2.length) discBad++;
  if (!seen.has(i)) discBad++;
  for (const j of d2) if (g.distance(i, j) > 2) discBad++;
}
console.log('disc errors:', discBad);