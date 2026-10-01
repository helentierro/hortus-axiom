'use strict';
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;

const world = new HX.World({ seed: 'hortus-01', w: 220, h: 140 });
const eco = new HX.Ecosystem(world, { speciesCount: 5, population: 700 });
for (let i = 0; i < 20; i++) eco.tick(1);

function time(label, fn, iters) {
  fn(); // warm
  const t = Date.now();
  for (let i = 0; i < iters; i++) fn();
  const dt = (Date.now() - t) / iters;
  console.log(label.padEnd(28), dt.toFixed(3) + ' ms');
  return dt;
}

const N = 200;
console.log('agents alive:', eco.totalPop, ' cells:', world.grid.size);
time('world.stepLiving(0.25)', () => world.stepLiving(0.25), N);
time('world.recomputeTemps()', () => world.recomputeTemps(), N);
time('world.rollWeather(1)', () => world.rollWeather(1), N);
time('world.advanceTime(1)', () => world.advanceTime(1), N);
time('world.stats()', () => world.stats(), 40);
time('eco.clearOccupancy()', () => eco.clearOccupancy(), N);
time('eco.act()', () => eco.act(), N);
time('eco.metabolise(1)', () => eco.metabolise(1), N);
time('eco.reproduce()', () => eco.reproduce(), N);
time('eco.cull()', () => eco.cull(), N);
time('eco.tally()', () => eco.tally(), N);
time('eco.checkExtinctions()', () => eco.checkExtinctions(), N);
time('eco.recordHistory(6)', () => eco.recordHistory(6), 60);
time('eco.tick(1) total', () => eco.tick(1), N);
time('eco.snapshot()', () => eco.snapshot(), 40);