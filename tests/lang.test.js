'use strict';
/* ============================================================================
 * HORTUS / tests/lang.test.js
 * Exercises the AXIOM reader, evaluator, core library and simulation API.
 * Run with:  node tests/lang.test.js
 * ==========================================================================*/
const { loadSandbox } = require('./harness');
const sb = loadSandbox();
const HX = sb.HX;
const R = HX.Reader;

const world = new HX.World({ seed: 'lang-test', w: 120, h: 80 });
const eco = new HX.Ecosystem(world, { speciesCount: 4, population: 240 });
for (let i = 0; i < 40; i++) eco.tick(1);

const I = new HX.Interp({ stepBudget: 4000000 });
HX.builtins.install(I);
HX.stdlib.install(I, { world, eco, focus() {}, highlight() {}, setChannel() {}, reset() {} });

let lastError = null;

/* A REPL shows printed output AND the values of non-defining top-level forms.
 * The harness does the same, so expectations match what a user would see. */
function run(src, label) {
  let forms;
  try { forms = R.read(src); }
  catch (e) { lastError = e; console.log(`  ${label}: read error: ${e.message}`); return null; }
  const t = Date.now();
  const res = I.run(forms, I.global, { collect: true });
  const ms = Date.now() - t;
  let text = res.output;
  if (!text && res.results.length) {
    const shown = res.results.filter(v => !I.isSilent(v)).map(v => R.inspect(v, 3));
    if (shown.length) text = shown.join(' ') + '\n';
  }
  if (res.error) {
    lastError = res.error;
    console.log(`  ${label}: ERROR ${res.error.message} (${res.steps} steps, ${ms}ms)`);
    return null;
  }
  return { output: text, value: res.value, ms, steps: res.steps };
}

let pass = 0, fail = 0;
const only = process.argv[2];
function check(label, src, expect) {
  if (only && label.indexOf(only) < 0) return;
  const res = run(src, label);
  if (res === null) { fail++; return; }
  if (expect !== undefined && expect !== null) {
    const ok = typeof expect === 'function' ? !!expect(res.output) : String(res.output.trim()) === String(expect);
    if (ok) { pass++; return; }
    fail++;
    console.log(`X ${label}\n    expected ${typeof expect === 'function' ? '(predicate)' : JSON.stringify(expect)}, got ${JSON.stringify(res.output.trim())}`);
    return;
  }
  pass++;
  const txt = res.output.trim();
  if (txt) console.log(`  ${label.padEnd(30)} ${txt.split('\n').join(' | ').slice(0, 110)}`);
}

function expectError(label, src, fragment) {
  if (only && label.indexOf(only) < 0) return;
  const before = fail;
  const res = run(src, label);
  if (res !== null) { fail++; console.log(`X ${label}: expected an error, got ${JSON.stringify(res.output.trim())}`); return; }
  const msg = (lastError && lastError.message) || '';
  if (fragment && msg.indexOf(fragment) < 0) {
    fail++;
    console.log(`X ${label}: error message ${JSON.stringify(msg)} does not mention ${JSON.stringify(fragment)}`);
    return;
  }
  if (fail === before) { pass++; console.log(`  ${label.padEnd(30)} raises: ${msg.split('\n')[0].slice(0, 80)}`); }
}

console.log('--- AXIOM: reader and evaluator ---\n');

check('arithmetic', '(list (+ 1 2 3) (* 2 3) (- 10 1 2) (/ 100 4) (mod 7 3) (rem -7 3) (quot 7 2))', '(6 6 7 25 1 -1 3)');
check('operators as values', '(let ((f +) (x 5)) (f x 3))', '8');
check('closures', '(define (adder n) (fn (x) (+ x n))) (list ((adder 10) 5) ((adder 1) 1))', '(15 2)');
check('lexical capture', '(define (counter) (let ((n 0)) (fn () (set! n (+ n 1)) n))) (define c (counter)) (list (c) (c) (c))', '(1 2 3)');
check('let vs global', '(define x 1) (list (let ((x 2)) x) x)', '(2 1)');
check('let* sequential', '(let* ((a 1) (b (+ a 1))) (list a b))', '(1 2)');
check('set! global', '(do (define v 1) (set! v 9) v)', '9');
check('if / cond / else', '(define x 5) (list (if (> x 3) :big :small) (cond ((< x 3) :low) ((< x 10) :mid) (else :high)))', '(:big :mid)');
check('and / or / not', '(list (and 1 2 3) (or #f 7) (not #f) (and 1 #f 3))', '(3 7 #t #f)');
check('when / unless', '(list (when #t 1 2) (unless #f 9))', '(2 9)');
check('quote', "(list (quote (a b c)) '(1 2))", '((a b c) (1 2))');
check('quote is not eval', '(define x 99) (list (quote x) (quote (quote x)))', '(x (quote x))');
check('quasiquote', '(define n 3) `(a ,n b)', '(a 3 b)');
check('quasiquote splice', '(define xs (list 1 2)) `(a ,@xs b)', '(a 1 2 b)');
check('in-list comma splice', '(define xs (list 1 2)) `(a ,@xs b)', '(a 1 2 b)');
check('do sequencing', '(do (define a 1) (define b 2) (+ a b))', '3');
check('while', '(do (define i 0) (while (< i 5) (set! i (+ i 1))) i)', '5');
check('repeat', '(do (define s 0) (repeat 4 (set! s (+ s 3))) s)', '12');
check('recursion', '(define (fact n) (if (<= n 1) 1 (* n (fact (- n 1))))) (fact 20)', '2432902008176640000');
check('fib 18', '(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))) (fib 18)', '2584');
check('tail-ish loop', '(define (sum-to n acc) (if (<= n 0) acc (sum-to (- n 1) (+ acc n)))) (sum-to 500 0)', '125250');
check('map', '(map (fn (x) (* x x)) (list 1 2 3 4))', '(1 4 9 16)');
check('map with builtin', '(map + (list 1 2 3))', '(1 2 3)');
check('filter + reduce', '(define xs (range 1 20)) (reduce + 0 (filter odd? xs))', '100');
check('map2', '(map2 + (list 1 2 3) (list 10 20 30))', '(11 22 33)');
check('each', '(do (define s 0) (each (list 1 2 3) (fn (v) (set! s (+ s v)))) s)', '6');
check('each with index', '(do (define s 0) (each (list (list 1 9) (list 2 8)) (fn (row i) (set! s (+ s i)))) s)', '1');
check('sort descending', '(sort (list 5 3 9 1) (fn (x) (- x)))', '(9 5 3 1)');
check('sort strings', '(sort (list "pear" "apple" "fig"))', '("apple" "fig" "pear")');
check('reduce with index', '(reduce (fn (a b i) (+ a (* i b))) 0 (list 5 5 5))', '15');
check('take / drop', '(list (take 3 (range 10)) (drop 7 (range 10)))', '((0 1 2) (7 8 9))');
check('append / reverse', '(list (append (list 1 2) (list 3)) (reverse (list 1 2 3)))', '((1 2 3) (3 2 1))');
check('list access', '(list (car (list 1 2)) (cadr (list 1 2)) (last (list 1 2)) (length (list 1 2 3)))', '(1 2 2 3)');
check('list mutation', '(define l (list 1 2 3)) (list (push! l 4) (set-nth! l 0 9) l)', '((9 2 3 4) 9 (9 2 3 4))');
check('flatten / zip', '(list (flatten (list 1 (list 2 (list 3)))) (zip (list 1 2) (list 3 4)))', '((1 2 3) ((1 3) (2 4)))');
check('unique / count', '(unique (list 1 1 2 3 3)) (count (fn (x) (> x 1)) (list 1 2 3 4))', '(1 2 3) 3');
check('any? / all? / find', '(list (any? even? (list 1 3 4)) (all? even? (list 2 4)) (find odd? (list 2 5 6)))', '(#t #t 5)');
check('string ops', '(list (concat-str "a" "b" 1) (upper "hi") (split "a,b,c" ","))', '("ab1" "HI" ("a" "b" "c"))');
check('string predicates', '(list (starts-with? "hello" "he") (contains? "hello" "ll") (ends-with? "hello" "lo"))', '(#t #t #t)');
check('string <-> symbol', "(list (symbol->string 'abc) (string->symbol \"def\"))", '("abc" def)');
check('number formatting', '(list (number->string 3.14159 2) (pad-left 7 3) (parse-number \"12\"))', '("3.14" "  7" 12)');
check('dict basics', '(define d (dict :a 1 :b 2)) (list (get d :a) (put! d :c 3) (get d :c) (length d))', '(1 3 3 3)');
check('dict keys/values', '(define d (dict :x 1 :y 2)) (sort (map symbol->string (keys d)))', '("x" "y")');
check('property access', '(define d (dict :n 7)) (list d.n (get d :n))', '(7 7)');
check('partial / compose', '(list ((partial + 10) 5) ((compose (fn (x) (* 2 x)) (fn (x) (+ x 1))) 5))', '(15 12)');
check('curry', '((curry (fn (a b) (+ a b)) 1) 2)', '3');
check('flip', '((flip -) 3 10)', '7');
check('type predicates', '(list (number? 1) (string? "a") (list? (list)) (nil? nil) (function? car) (int? 3) (int? 3.5))', '(#t #t #t #t #t #t #f)');
check('0 is truthy', '(if 0 :yes :no)', ':yes');
check('negative numbers', '(list (- 0 5) (+ -1 -2) (- 10))', '(-5 -3 -10)');
check('number parsing', '(list 1e3 -2.5e-2 0.5 7)', '(1000 -0.025 0.5 7)');
check('math builtins', '(list (sqrt 16) (pow 2 10) (abs -3) (min 3 1 2) (max 3 1 2) (floor 1.7) (clamp 9 0 5))', '(4 1024 3 1 3 1 5)');
check('math rounding', '(list (round 1.5) (round 2.4) (trunc -1.7) (mod -1 3))', '(2 2 -1 2)');
check('chained comparison', '(list (< 1 2 3) (> 3 2 1) (<= 1 1 2) (>= 2 2 1) (= 1 1 1))', '(#t #t #t #t #t)');
check('defmacro', '(defmacro my-when (c body) `(if ,c (do ,body))) (my-when #t 42)', '42');
check('macro repeats body', '(defmacro twice (form) `(do ,form ,form)) (define n 0) (list (twice (set! n (+ n 1))) n)', '(2 2)');
check('macro inserts args as code', '(define (plus a b) (+ a b)) (defmacro swapped (f a b) `(,f ,b ,a)) (swapped plus 1 2)', '3');
check('gensym is hygienic', '(define n 0) (defmacro bump () (let ((g (gensym))) `(let ((,g (+ n 1))) (do (set! n ,g) ,g)))) (list (bump) (bump) n)', '(1 2 2)');
check('macro shadows safely', '(define n 5) (defmacro shadower () `(let ((n 99)) n)) (list (shadower) n)', '(99 5)');
check('macro as value', "(define m (fn (x) (* x 3))) (m 4)", '12');

console.log('\n--- AXIOM: the world ---\n');

check('world basics', '(list (day) (world-w) (world-h) (cell-count) (season-name))', null);
check('seed string', '(seed-string)', null);
check('cell read', '(define c (random-cell)) (list (biome-name c) c.veg c.water)', null);
check('cell coords', '(define c (cell 10 10)) (list c.col c.row c.index)', null);
check('field accessor', '(field (cell 10 10) "fert")', null);
expectError('unknown field lists options', '(field (cell 0 0) "nope")', 'unknown field');
check('around returns a disc', '(length (around (cell 10 10) 2))', '19');
check('around radius 1', '(length (around (cell 10 10) 1))', '7');
check('neighbors', '(length (neighbors (cell 5 5)))', '6');
check('hex distance', '(hex-distance (cell 0 0) (cell 3 0))', '3');
check('around-sum', '(around-sum (cell 10 10) "veg" 2)', null);
check('biome table', '(list (length (biome-list)) (biome-name 0))', null);
check('dominant biome', '(dominant-biome)', null);
check('scan-cells', '(scan-cells-count (fn (c) (= 0 (mod c.col 20))))', '480');
check('fold-cells', '(fold-cells (fn (s c) (+ s c.veg)) 0)', null);
check('random-cell with predicate', '(define c (random-cell (fn (c) (> c.fert 0.5)))) (> c.fert 0.5)', '#t');
check('population is alive', '(> (population) 0)', '#t');
check('agents list', '(list (agent-count) (agent-count 0) (agent-count nil 1))', null);
check('agent fields', '(define a (nth (agents) 0)) (list (agent-field a "energy") (agent-field a "generation") (kind-name (agent-field a "kind")))', null);
check('agent property access', '(define a (nth (agents) 0)) (list (> a.energy 0) (kind-name a.kind) a.name)', null);
check('agent coords', '(define a (nth (agents) 0)) (list (agent-field a "col") (agent-field a "row"))', null);
check('traits', '(define a (nth (agents) 0)) (list (trait a "speed") (trait a "size") (gene a "speed"))', null);
check('trait-names', '(length (trait-names))', '14');
check('genome length', '(genome-length)', '232');
check('genome distance', '(define a (nth (agents) 0)) (define b (nth (agents) 1)) (genome-distance (genome a) (genome b))', null);
check('describe-genome', '(length (describe-genome (nth (agents) 0)))', '14');
check('brain weights', '(length (weights (nth (agents) 0)))', '18');
check('species table', '(map (fn (s) s.name) (species))', null);
check('stats', '(define s (stats)) (list s.population s.grazers s.stalkers s.generation)', null);
check('history recorded', '(> (history-length) 0)', '#t');
check('hall of fame', '(define b (best)) (if b (list b.name b.generation) nil)', null);
check('chapters', '(length (chapters))', null);
check('advance!', '(define d0 (day)) (list (advance! 5) (= (day) (+ d0 5)))', null);
check('set-season!', '(list (set-season! "winter") (season-name))', '("Winter" "Winter")');
check('set-weather!', '(list (set-weather! "rain" 0.8) (weather "rain"))', '(0.8 0.8)');
check('climate', '(climate)', null);
check('bloom! raises biomass', '(define c (random-cell)) (define b c.veg) (list (bloom! c 3 0.8) (> c.veg b))', '(1 #t)');
check('scorch!', '(scorch! (random-cell) 2 0.9)', '1');
check('set-field!', '(define c (random-cell)) (list (set-field! c "veg" 0.5) c.veg)', '(0.5 0.5)');
check('event log', '(list (say! "hello from axiom") (> (length (event-log 3)) 0))', '("hello from axiom" #t)');
check('advance!', '(define d0 (day)) (list (advance! 5) (= (day) (+ d0 5)))', null);
check('set-season!', '(list (set-season! "winter") (season-name))', '("Winter" "Winter")');
check('set-weather!', '(list (set-weather! "rain" 0.8) (weather "rain"))', '(0.8 0.8)');
check('spawn and kill', '(define a (spawn! (random-cell) nil 0)) (define alive (agent? a)) (list alive (kill! a))', '(#t #t)');
check('heal!', '(define a (nth (agents) 0)) (define e0 a.energy) (list (heal! a 30) (> a.energy e0))', null);
check('mutate!', '(define a (nth (agents) 0)) (mutate! a 0.5 0.3)', '#t');
check('set-trait!', '(define a (nth (agents) 0)) (set-trait! a "speed" 1.0)', '1.45');
check('crossover-genome', '(define a (nth (agents) 0)) (define b (nth (agents) 1)) (genome-length (crossover-genome a b))', '232');
check('make-genome', '(genome-hash (make-genome 0))', null);
check('add-species!', '(define s (add-species! 0 "Testline")) (list s.name s.kind)', '("Testline" 0)');
check('focus / color-by', '(list (color-by "biome") (focus 10 10 2))', '("biome" #t)');

console.log('\n--- AXIOM: a program with teeth ---\n');

const PROG = `
; Crown the swift.
; Over 60 simulated days, report how the population's traits would drift
; under a policy that breeds fast grazers into fertile lowland and culls
; the ones that are starving.

(define grazers (agents nil 0))

(define best-meadow
  (fold-cells (fn (best c)
    (if (and (> c.fert 0.45)
             (= 0 c.water)
             (or (nil? best) (> c.veg (field best "veg"))))
        c best))
    nil))

(println "richest meadow:" best-meadow.col best-meadow.row
         "| fertility" (field best-meadow "fert"))

(define fast-before (mean (map (fn (a) (gene a "speed")) grazers)))
(println "mean speed gene, generation 0:" fast-before)

; Run a harsh winter and count who survives it.
(set-season! "winter")
(set-weather! "rain" 0.2)
(println "population before winter:" (population))

(repeat 20 (advance! 3))

(println "population after winter:" (population))
(println "grazer survivors:" (agent-count nil 0))
(println "mean speed gene now:" (mean (map (fn (a) (gene a "speed")) (agents nil 0))))
(println "generation reached:" (generation))
(say! "the long winter passed")
`;

const prog = run(PROG, 'winter program');
if (prog) {
  pass++;
  console.log('  ' + prog.output.trim().split('\n').filter(Boolean).map(l => '   ' + l).join('\n'));
}

const PROG2 = `
; A predator policy: cull the weakest stalkers whenever they get fat.
(define stalkers (agents nil 1))
(println "stalkers:" (length stalkers))
(define executed 0)
(each stalkers
  (fn (s)
    (if (and (< (gene s "aggression") 0.2) (> (agent-field s "energy") 60))
        (begin (kill! s) (set! executed (+ executed 1)))
        nil)))
(println "culled passive, well-fed stalkers:" executed)
(println "population now:" (population))
`;
const prog2 = run(PROG2, 'cull program');
if (prog2) {
  pass++;
  console.log('  ' + prog2.output.trim().split('\n').filter(Boolean).map(l => '   ' + l).join('\n'));
}

console.log('\n--- AXIOM: errors are legible ---\n');

expectError('car of a number', '(car 1)', 'expected a list');
expectError('undefined function', '(no-such-fn 1)', 'unbound symbol');
expectError('index out of range', '(nth (list 1) 9)', 'out of range');
expectError('non-numeric arithmetic', '(+ 1 "a")', 'expected a number');
expectError('infinite loop', '(while #t 1)', 'step budget');
expectError('unknown trait', '(trait (nth (agents) 0) "nope")', 'unknown trait');
expectError('unknown field', '(field (random-cell) "nope")', 'unknown field');
expectError('unclosed list', '(println "x"', 'unclosed list');
expectError('mismatched bracket', '(list 1 2]', 'mismatched');
expectError('malformed number', '12abc', 'malformed number');
expectError('unterminated string', '(println "abc)', 'unterminated string');
expectError('deep recursion', '(define (f n) (+ 1 (f n))) (f 1)', 'call depth');
expectError('mutating a missing species', '(spawn! (random-cell) 99 0)', 'no species');
expectError('set-trait of unknown', '(set-trait! (nth (agents) 0) "nope" 1)', 'unknown trait');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
