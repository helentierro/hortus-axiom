'use strict';
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;

const seed = process.argv[2] || 'hortus-01';
const days = parseInt(process.argv[3] || '120', 10);

const world = new HX.World({ seed, w: 220, h: 140 });
const eco = new HX.Ecosystem(world, { speciesCount: 5, population: 520 });

const causes = {};
let prevPop = eco.totalPop;
const ages = [];
eco.emitter.on('death', a => { causes[a.cause] = (causes[a.cause] || 0) + 1; });

console.log('day pop births deaths grazers stalkers meanAge meanE vegUnderH thermal');
for (let d = 0; d < days; d++) {
  eco.tick(1);
  if ((d + 1) % 20 === 0) {
    const alive = eco.agents.filter(a => a.alive);
    let sumAge = 0, n = 0, sumE = 0, sumVeg = 0, sumStress = 0;
    for (const a of alive) {
      sumAge += a.age; n++;
      sumE += a.energy;
      if (a.kind === 0) {
        sumVeg += world.veg[a.cell];
        sumStress += eco.maintenance(a, world.crowd[a.cell]);
      }
    }
    const H = alive.filter(a => a.kind === 0);
    console.log(
      String(d + 1).padStart(4), String(alive.length).padStart(4),
      String(eco.births).padStart(5), String(eco.deaths).padStart(5),
      String(eco.counts[0]).padStart(6), String(eco.counts[1]).padStart(7),
      (n ? sumAge / n : 0).toFixed(1).padStart(6),
      (n ? sumE / n : 0).toFixed(1).padStart(5),
      (H.length ? sumVeg / H.length : 0).toFixed(3),
      (H.length ? sumStress / H.length : 0).toFixed(2)
    );
  }
}
console.log('\ndeath causes:', causes);
console.log('births', eco.births, 'deaths', eco.deaths, 'kills', eco.kills);

/* age distribution of the living */
const buckets = new Array(20).fill(0);
for (const a of eco.agents) if (a.alive) buckets[Math.min(19, Math.floor(a.age / 10))]++;
console.log('age histogram (per 10 days):', buckets.map((v, i) => i * 10 + ':' + v).join(' '));

/* energy + maxAge samples */
const s = eco.agents.filter(a => a.alive).slice(0, 6);
s.forEach(a => console.log(`  ${a.name} age=${a.age.toFixed(0)}/${a.maxAge.toFixed(0)} E=${a.energy.toFixed(0)} mat=${a.age < a.maturity ? 'juv' : 'ad'} breedAt=${a.breedAt.toFixed(0)} cost=${a.birthCost.toFixed(0)} children=${a.offspring} score=${a.score.toFixed(0)} state=${a.state} kind=${a.kind}`));

/* how many agents are reproductive-eligible right now */
let elig = 0, matured = 0;
for (const a of eco.agents) { if (a.alive) { if (a.age >= a.maturity) matured++; if (a.age >= a.maturity && a.energy >= a.breedAt && a.breedTimer <= 0) elig++; } }
console.log(`eligible to breed: ${elig} (matured ${matured})`);