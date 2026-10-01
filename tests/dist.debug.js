'use strict';
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;

function hist(arr, filter, bins, label) {
  const b = new Array(bins).fill(0);
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    if (filter && !filter(i)) continue;
    b[Math.min(bins - 1, Math.floor(arr[i] * bins))]++; n++;
  }
  const max = Math.max(...b) || 1;
  console.log('\n' + label + ' (n=' + n + ')');
  for (let i = 0; i < bins; i++) {
    const bar = '#'.repeat(Math.round(b[i] / max * 46));
    console.log(String((i / bins).toFixed(2)).padEnd(5) + bar + ' ' + b[i]);
  }
}

const seeds = process.argv.slice(2);
if (!seeds.length) seeds.push('hortus-01');

for (const seed of seeds) {
  const w = new HX.World({ seed, w: 220, h: 140 });
  console.log('\n================ seed: ' + seed + ' ================');
  const isLand = i => w.water[i] <= 0.02;
  hist(w.elev, isLand, 20, 'land elevation');
  hist(w.moist, isLand, 20, 'land moisture');
  hist(w.temp, isLand, 20, 'land temperature');
  hist(w.precip, isLand, 20, 'land precipitation');
  hist(w.water, i => !isLand(i), 20, 'ocean depth');
  const hb = w.biomeHistogram();
  console.log('\nbiomes: ' + HX.BIOMES.map((b, i) => b.key + ' ' + (hb[i] / w.grid.size * 100).toFixed(1) + '%').join('  '));
  console.log('land ' + (w.coverage.land * 100).toFixed(1) + '%  peak ' + w.coverage.peak.toFixed(3) + '  rivers ' + w.riverCells);
}