'use strict';
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;

const seed = process.argv[2] || 'orchard';
const years = parseInt(process.argv[3] || '16', 10);

const w = new HX.World({ seed, w: 220, h: 140 });
const isLand = [];
for (let i = 0; i < w.grid.size; i++) isLand.push(w.water[i] <= 0.02);
const nLand = isLand.filter(Boolean).length || 1;

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) if (isLand[i]) s += arr[i];
  return s / nLand;
}
function above(arr, thr) {
  let c = 0;
  for (let i = 0; i < arr.length; i++) if (isLand[i] && arr[i] > thr) c++;
  return c / nLand;
}

console.log(`--- HORTUS climate (${seed}, ${years}y) ---`);
console.log('day season  meanT  >0.30  >0.50   snow  >0.5sn  meanSnow   moist   veg');

const rows = [];
const eco = new HX.Ecosystem(w, { speciesCount: 5, population: 400 });
for (let d = 1; d <= years * 360; d++) {
  eco.tick(1);
  if (d % 180 === 0 || d === 30 || d === 60 || d === 90) {
    rows.push({
      day: d,
      season: w.time.seasonName,
      meanT: mean(w.tempNow).toFixed(3),
      'T>0.30': (above(w.tempNow, 0.30) * 100).toFixed(0) + '%',
      'T>0.50': (above(w.tempNow, 0.50) * 100).toFixed(0) + '%',
      snow: (above(w.snow, 0.5) * 100).toFixed(0) + '%',
      meanSnow: mean(w.snow).toFixed(3),
      moist: mean(w.moist).toFixed(3),
      veg: eco.snapshot().world.vegSaturation.toFixed(3)
    });
  }
}
console.table(rows);