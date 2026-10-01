'use strict';
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;
const G = HX.Genome;

const world = new HX.World({ seed: 'hortus-01', w: 220, h: 140 });
const eco = new HX.Ecosystem(world, { speciesCount: 5, population: 500 });

/* Instrument the metabolism: measure intake vs cost for one day. */
let intake = 0, cost = 0, nDays = 0;
const origGraze = eco.graze.bind(eco);
eco.graze = function (a) { const g = origGraze(a); intake += g; return g; };

const origMetab = eco.metabolise.bind(eco);
eco.metabolise = function (days) {
  const before = eco.agents.reduce((s, a) => s + (a.alive ? a.energy : 0), 0);
  origMetab(days);
  const after = eco.agents.reduce((s, a) => s + (a.alive ? a.energy : 0), 0);
  cost += before - after;
  nDays += days;
};

function report(tag) {
  const alive = eco.agents.filter(a => a.alive);
  const H = alive.filter(a => a.kind === 0), C = alive.filter(a => a.kind === 1);
  const vegOn = H.map(a => world.veg[a.cell]);
  const avgVeg = vegOn.length ? vegOn.reduce((s, v) => s + v, 0) / vegOn.length : 0;
  const avgE = alive.length ? alive.reduce((s, a) => s + a.energy, 0) / alive.length : 0;
  console.log(`d${world.time.day.toString().padStart(4)} pop=${String(alive.length).padStart(4)} H=${String(H.length).padStart(3)} C=${String(C.length).padStart(3)} avgE=${avgE.toFixed(1)} vegUnderHerb=${avgVeg.toFixed(3)} worldVeg=${world.vegMean.toFixed(3)}`);
  const d = Math.max(1, nDays);
  console.log(`        intake/day=${(intake / d).toFixed(1)}  netCost/day=${(cost / d).toFixed(1)}  (per capita intake ${(intake / d / Math.max(1, alive.length)).toFixed(2)})`);
  intake = 0; cost = 0; nDays = 0;

  if (H.length) {
    const a = H[0];
    const size = G.traitOf(a.genome, 'size'), metab = G.traitOf(a.genome, 'metabolism');
    const comfort = a.comfort;
    const t = world.tempNow[a.cell];
    let base = 1.25 * (0.55 + metab * 0.75) * (0.6 + size * 0.55);
    let stress = t < comfort ? (comfort - t) * (1 - G.geneOf(a.genome, 'cold') * 0.85)
                              : (t - comfort) * (1 - G.geneOf(a.genome, 'heat') * 0.85);
    base *= 1 + Math.max(0, Math.min(1, stress)) * 1.9;
    const take = Math.min(world.veg[a.cell], 0.22 * size);
    const gain = take * 15.0 * (1.15 - metab * 0.28);
    console.log(`        sample herb: size=${size.toFixed(2)} metab=${metab.toFixed(2)} comfort=${comfort.toFixed(2)} t=${t.toFixed(2)} crowd=${world.crowd[a.cell]}`);
    console.log(`        -> cost/day=${base.toFixed(2)} (veg-limited intake=${gain.toFixed(2)}) => net ${(gain - base).toFixed(2)}`);
  }
}

for (let d = 0; d < 60; d++) {
  eco.tick(1);
  if ((d + 1) % 10 === 0) report();
}
report('final');