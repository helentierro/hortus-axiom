'use strict';
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;
const R = HX.Reader;

const w = new HX.World({ seed: 'x', w: 60, h: 40 });
const e = new HX.Ecosystem(w, { speciesCount: 2, population: 60 });
const I = new HX.Interp({ stepBudget: 1e6 });
HX.builtins.install(I);
HX.stdlib.install(I, { world: w, eco: e, focus() {}, highlight() {}, setChannel() {}, reset() {} });

function r(src) {
  try {
    const f = R.read(src);
    const res = I.run(f, I.global, { collect: true });
    if (res.error) return 'ERR ' + res.error.message;
    return res.output || res.results.filter(v => !I.isSilent(v)).map(v => R.inspect(v, 3)).join(' ');
  } catch (err) { return 'READ ' + err.message; }
}

const cases = [
  ['c.col', '(define c (cell 3 4)) c.col'],
  ['field col', '(define c (cell 3 4)) (field c "col")'],
  ['println c.col', '(define c (cell 3 4)) (println c.col)'],
  ['scan c.col', '(scan-cells-count (fn (c) (= 0 (mod c.col 20))))'],
  ['scan field', '(scan-cells-count (fn (c) (= 0 (mod (agent-field c "col") 20))))'],
  ['quasiquote', '(define f 1) `(a ,f b)'],
  ['macro do-twice', '(defmacro m1 (form) `(do ,form ,form)) (define n 0) (list (m1 (set! n (+ n 1))) n)'],
  ['macro my-when', '(defmacro mw (c body) `(if ,c (do ,body))) (mw #t 42)']
];
for (const [label, src] of cases) console.log(label.padEnd(16), '->', r(src));

console.log('\nreader output for a defmacro:');
console.log(JSON.stringify(R.read('(defmacro m2 (form) `(do ,form ,form))'), (k, v) => k === 'isList' ? undefined : v, 1));