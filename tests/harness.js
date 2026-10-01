/* Loads HORTUS's non-UI modules into a vm sandbox so the simulation and the
 * AXIOM language can be driven from node.
 *
 * Run any of them directly, e.g.
 *     node tests/lang.test.js
 *     node tests/world.test.js
 *     node tests/eco.test.js [seed] [days]
 *
 * There is no tests/run.js; it never existed.
 *
 * "fake DOM" was never accurate either: the sandbox provides no document at
 * all, which is precisely why only the non-UI modules are listed in MODULES
 * below. Anything that touches the DOM has to be exercised in a browser — see
 * tests/smoke.html, which is where the rendering and App wiring are covered.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const MODULES = [
  'js/core/util.js',
  'js/core/rng.js',
  'js/core/hex.js',
  'js/world/world.js',
  'js/world/genome.js',
  'js/world/brain.js',
  'js/world/names.js',
  'js/world/ecosystem.js',
  'js/lang/reader.js',
  'js/lang/interp.js',
  'js/lang/builtins.js',
  'js/lang/stdlib.js',
  'js/render/palette.js'
];

function loadSandbox(extra) {
  const sandbox = Object.assign({
    console,
    performance: { now: () => Date.now() },
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error,
    Map, Set, WeakMap, ArrayBuffer, Uint8Array, Int8Array, Uint16Array,
    Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView,
    isFinite, isNaN, parseFloat, parseInt, Symbol, Promise, RegExp, Function,
    Infinity, NaN, undefined
  }, extra || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of MODULES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { console.log('  (skip, not present) ' + rel); continue; }
    const code = fs.readFileSync(p, 'utf8');
    try {
      vm.runInContext(code, sandbox, { filename: rel });
    } catch (e) {
      console.error('FAILED loading ' + rel + ': ' + e.stack);
      throw e;
    }
  }
  return sandbox;
}

module.exports = { loadSandbox, MODULES, ROOT };