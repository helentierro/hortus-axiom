'use strict';
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;
const g = new HX.HexGrid(9, 7);

console.log('DIRS:', HX.DIRS.map(d => `${d.name}(dr${d.dr},dc${d.dc})`).join(' '));
console.log('idx col,row,q,r');
for (let y = 0; y < 4; y++) {
  let line = [];
  for (let x = 0; x < 5; x++) {
    const i = g.idx(x, y);
    line.push(`${i}(${g.col[i]},${g.row[i]},q${g.q[i]},r${g.r[i]})`);
  }
  console.log('y=' + y + ' ' + line.join(' '));
}
console.log('\nnbr of (3,3)=idx', g.idx(3, 3));
for (let d = 0; d < 6; d++) {
  const nb = g.neighbor(g.idx(3, 3), d);
  const back = nb >= 0 ? g.directionTo(g.idx(3, 3), nb) : -2;
  console.log(`  dir ${HX.DIRS[d].name} -> idx ${nb} (${nb >= 0 ? g.col[nb] + ',' + g.row[nb] + ' q' + g.q[nb] + ' r' + g.r[nb] : 'off'})  back=${back}`);
}

console.log('\nfull scan mismatches:');
let bad = [];
for (let i = 0; i < g.size; i++) for (let d = 0; d < 6; d++) {
  const nb = g.neighbor(i, d);
  if (nb < 0) continue;
  const back = g.directionTo(i, nb);
  if (back !== d) bad.push({ i, want: d, got: back, dq: g.q[nb] - g.q[i], dr: g.r[nb] - g.r[i], dname: HX.DIRS[d].name });
}
console.log(bad.slice(0, 8));
console.log('total bad', bad.length);

/* disc check */
console.log('\ndisc(i=idx(4,3), 1):');
const c = g.idx(4, 3);
for (const j of g.disc(c, 1)) console.log('  ', j, g.col[j] + ',' + g.row[j], 'dist', g.distance(c, j));
console.log('disc(i,2) count', g.disc(c, 2).length, 'expected <= 19');