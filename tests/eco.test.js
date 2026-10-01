'use strict';
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;

const seed = process.argv[2] || 'hortus-01';
const days = parseInt(process.argv[3] || '400', 10);

console.log(`--- HORTUS ecosystem test (${seed}, ${days} days) ---`);
let t0 = Date.now();
const world = new HX.World({ seed, w: 220, h: 140 });
const tGen = Date.now() - t0;

t0 = Date.now();
const eco = new HX.Ecosystem(world, { speciesCount: 5, population: 520 });
const tSeed = Date.now() - t0;

console.log('gen ms', tGen, '| seed ms', tSeed);
console.log('species:', eco.species.map(s => `${s.name}[${s.kind === 0 ? 'H' : 'C'}]:${s.count}`).join('  '));
console.log('pop', eco.totalPop, 'grazers', eco.counts[0], 'stalkers', eco.counts[1]);

t0 = Date.now();
const marks = [];
for (let d = 0; d < days; d++) {
  eco.tick(1);
  if ((d + 1) % Math.floor(days / 10 || 1) === 0) {
    const s = eco.snapshot();
    marks.push({
      day: d + 1,
      pop: s.pop, H: s.byKind[0], C: s.byKind[1],
      gen: s.maxGeneration,
      eH: s.meanEnergy[0].toFixed(1), eC: s.meanEnergy[1].toFixed(1),
      veg: s.world.veg.toFixed(3), vegSat: s.world.vegSaturation.toFixed(2),
      rain: world.weather.rain.toFixed(2), season: world.time.seasonName,
      ext: s.extinctions, rev: s.revivals
    });
  }
}
const tRun = Date.now() - t0;
console.table(marks);
console.log(`run ms ${tRun} for ${days} ticks -> ${(tRun / days).toFixed(3)} ms/tick, ${(1000 * days / tRun).toFixed(0)} ticks/s`);

console.log('\nlog tail:');
eco.log.slice(-8).forEach(l => console.log(`  d${l.day} [${l.kind}] ${l.text}`));
console.log('\nchapters:', eco.chapters.map(c => `d${c.day} ${c.title}`).join(' | '));

console.log('\nspecies detail:');
eco.species.forEach(s => {
  console.log(`  ${s.name.padEnd(16)} kind=${s.kind} pop=${String(s.count).padStart(4)} peak=${String(s.peakPop).padStart(4)} gen=${String(s.generation).padStart(3)} births=${s.totalBirths} deaths=${s.totalDeaths} revivals=${s.revivals} best=${s.bestScore.toFixed(0)}`);
  if (s.record) console.log(`      record: ${s.record.name} ${s.record.epithet} gen${s.record.generation} score=${s.record.score.toFixed(0)} kids=${s.record.offspring} kills=${s.record.kills} died: ${s.record.cause}`);
});

console.log('\nsample agents:');
for (let i = 0; i < 4 && i < eco.agents.length; i++) {
  const a = eco.agents[i];
  console.log(`  ${a.name.padEnd(14)} ${HX.KIND_NAMES[a.kind].padEnd(9)} gen${String(a.generation).padStart(3)} E=${a.energy.toFixed(0)} age=${a.age.toFixed(0)} state=${a.state} sp=${eco.species[a.sp].name} hash=${HX.Genome.hash(a.genome)}`);
}

/* genome stats over the living population */
const traitAvg = {};
HX.Genome.TRAITS.forEach(t => traitAvg[t.name] = 0);
let n = 0;
eco.agents.forEach(a => { if (!a.alive) return; n++; HX.Genome.TRAITS.forEach(t => { traitAvg[t.name] += a.genome[HX.Genome.GENE_INDEX[t.name]]; }); });
console.log('\ntrait means across living population (n=' + n + '):');
console.log('  ' + HX.Genome.TRAITS.map(t => `${t.name}=${(traitAvg[t.name] / n).toFixed(3)}`).join('  '));

/* determinism of the whole run */
const w4 = new HX.World({ seed, w: 220, h: 140 });
const e4 = new HX.Ecosystem(w4, { speciesCount: 5, population: 520 });
for (let d = 0; d < 60; d++) e4.tick(1);
const w5 = new HX.World({ seed, w: 220, h: 140 });
const e5 = new HX.Ecosystem(w5, { speciesCount: 5, population: 520 });
for (let d = 0; d < 60; d++) e5.tick(1);
console.log('\nfull-run determinism:',
  e4.totalPop === e5.totalPop &&
  e4.births === e5.births && e4.deaths === e5.deaths &&
  e4.agents.every((a, i) => HX.Genome.hash(a.genome) === HX.Genome.hash(e5.agents[i].genome) && a.cell === e5.agents[i].cell));
console.log(`  (pop ${e4.totalPop} vs ${e5.totalPop}, births ${e4.births} vs ${e5.births})`);