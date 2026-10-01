/* ============================================================================
 * HORTUS / lang/builtins.js
 *
 * The core AXIOM standard library. Everything here is host-independent; the
 * simulation-facing API lives in stdlib.js.
 *
 * Conventions worth knowing:
 *   - `!` suffix on a name means it mutates something (list, genome, world).
 *   - `?` suffix means it returns a boolean.
 *   - Collections are JS arrays; a dict is a {dict: {...}} box.
 *   - Nothing throws a raw JS error; every failure becomes an AxiomError with a
 *     message a person can act on.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var R = global.HX.Reader;
  var U = global.HX.U;
  var mk = global.HX.makeBuiltin;
  var num = global.HX.toNumber;
  var truthy = global.HX.truthy;

  function err(msg) { throw new R.AxiomError(msg); }
  function argb(name, args, i, fallback) {
    var v = args[i];
    return (v === undefined || v === null) ? fallback : v;
  }
  function needList(v, who) {
    if (!Array.isArray(v)) err((who || 'argument') + ': expected a list, got ' + R.inspect(v, 3));
    return v;
  }
  function asList(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) { var e = []; e.isList = true; return e; }
    if (typeof v === 'string') return v.split('');
    err('expected a list, got ' + R.inspect(v, 3));
  }
  function numArray(v, who) {
    var out = new Float64Array(v.length);
    for (var i = 0; i < v.length; i++) out[i] = num(v[i], who);
    return out;
  }
  function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

  function install(I) {
    var G = I.global;

    function def(name, fn, opts) {
      G.define(name, mk(name, fn, opts));
      return fn;
    }
    function alias(name, target) {
      var t = G.get(target);
      if (!t) err('cannot alias undefined ' + target);
      G.define(name, mk(name, t.fn, Object.assign({ name: name }, t)));
    }

    /* ------------------------------------------------------------ output */
    I.out = function (s) { I.write(s); return null; };
    def('print', function (v) { I.write(R.inspect(v, 2)); return null; });
    def('println', function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(R.inspect(arguments[i], 2));
      I.write(parts.join(' ') + '\n');
      return null;
    });
    def('display', function (v) { I.write(String(v)); return null; });
    def('newline', function () { I.write('\n'); return null; });
    alias('log', 'println');
    alias('say', 'println');

    def('error', function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(R.inspect(arguments[i], 2));
      err(parts.join(' '));
    });
    def('assert', function (v, msg) {
      if (!truthy(v)) err('assertion failed' + (msg ? ': ' + R.inspect(msg, 2) : ''));
      return v;
    });

    /* ------------------------------------------------------------- math */
    function fold(args, fn, init) {
      var acc = init;
      for (var i = 0; i < args.length; i++) acc = fn(acc, num(args[i], 'arithmetic'));
      return acc;
    }
    def('+', function () { return fold(arguments, function (a, b) { return a + b; }, 0); });
    def('*', function () { return fold(arguments, function (a, b) { return a * b; }, 1); });
    def('-', function (a) {
      a = num(a, '-');
      if (arguments.length === 1) return -a;
      var acc = a;
      for (var i = 1; i < arguments.length; i++) acc -= num(arguments[i], '-');
      return acc;
    });
    def('/', function (a) {
      a = num(a, '/');
      if (arguments.length === 1) return 1 / a;
      var acc = a;
      for (var i = 1; i < arguments.length; i++) acc /= num(arguments[i], '/');
      return acc;
    });
    def('mod', function (a, b) { b = num(b, 'mod'); if (b === 0) err('mod by zero'); return U.mod(num(a, 'mod'), b); });
    def('rem', function (a, b) { b = num(b, 'rem'); if (b === 0) err('rem by zero'); return num(a, 'rem') % b; });
    def('quot', function (a, b) { b = num(b, 'quot'); if (b === 0) err('quot by zero'); return Math.trunc(num(a, 'quot') / b); });
    def('abs', function (a) { return Math.abs(num(a, 'abs')); });
    def('sign', function (a) { return U.sign(num(a, 'sign')); });
    def('min', function () {
      var a = arguments.length === 1 && Array.isArray(arguments[0]) ? numArray(arguments[0], 'min') : null;
      if (a) { var m = Infinity; for (var k = 0; k < a.length; k++) if (a[k] < m) m = a[k]; return m; }
      var best = Infinity;
      for (var i = 0; i < arguments.length; i++) { var v = num(arguments[i], 'min'); if (v < best) best = v; }
      return best === Infinity ? null : best;
    });
    def('max', function () {
      var a = arguments.length === 1 && Array.isArray(arguments[0]) ? numArray(arguments[0], 'max') : null;
      if (a) { var m = -Infinity; for (var k = 0; k < a.length; k++) if (a[k] > m) m = a[k]; return m; }
      var best = -Infinity;
      for (var i = 0; i < arguments.length; i++) { var v = num(arguments[i], 'max'); if (v > best) best = v; }
      return best === -Infinity ? null : best;
    });
    def('floor', function (a) { return Math.floor(num(a, 'floor')); });
    def('ceil', function (a) { return Math.ceil(num(a, 'ceil')); });
    def('round', function (a) {
      var v = num(a, 'round');
      return arguments.length > 1 ? Math.round(v * num(arguments[1], 'round')) / num(arguments[1], 'round') : Math.round(v);
    });
    def('trunc', function (a) { return Math.trunc(num(a, 'trunc')); });
    def('clamp', function (v, lo, hi) { return U.clamp(num(v, 'clamp'), num(lo, 'clamp'), num(hi, 'clamp')); });
    def('lerp', function (a, b, t) { return U.lerp(num(a, 'lerp'), num(b, 'lerp'), num(t, 'lerp')); });
    def('sqrt', function (a) { var v = num(a, 'sqrt'); return v < 0 ? NaN : Math.sqrt(v); });
    def('cbrt', function (a) { return Math.cbrt(num(a, 'cbrt')); });
    def('exp', function (a) { return Math.exp(num(a, 'exp')); });
    def('log', function (a) {
      var v = num(a, 'log');
      if (arguments.length > 1) return Math.log(v) / Math.log(num(arguments[1], 'log'));
      return v <= 0 ? -Infinity : Math.log(v);
    });
    def('pow', function (a, b) { return Math.pow(num(a, 'pow'), num(b, 'pow')); });
    def('hypot', function (a, b) { return Math.hypot(num(a), num(b)); });
    def('atan2', function (a, b) { return Math.atan2(num(a), num(b)); });
    ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp'].forEach(function (fn) {
      def(fn, (function (f) { return function (x) { return Math[f](num(x, f)); }; })(fn));
    });
    def('deg', function (r) { return num(r) * 180 / Math.PI; });
    def('rad', function (d) { return num(d) * Math.PI / 180; });

    /* ------------------------------------------------------- comparison */
    function chain(args, ok) {
      for (var i = 1; i < args.length; i++) {
        var a = args[i - 1], b = args[i];
        if (typeof a === 'string' && typeof b === 'string') {
          if (!ok(a < b ? -1 : (a > b ? 1 : 0))) return false;
        } else if (typeof a === 'boolean' || typeof b === 'boolean') {
          if (!ok((truthy(a) ? 1 : 0) - (truthy(b) ? 1 : 0))) return false;
        } else {
          if (!ok(cmp(num(a), num(b)))) return false;
        }
      }
      return true;
    }
    def('=', function () { return chain(arguments, function (c) { return c === 0; }); });
    def('<', function () { return chain(arguments, function (c) { return c < 0; }); });
    def('>', function () { return chain(arguments, function (c) { return c > 0; }); });
    def('<=', function () { return chain(arguments, function (c) { return c <= 0; }); });
    def('>=', function () { return chain(arguments, function (c) { return c >= 0; }); });
    def('not=', function (a, b) {
      if (typeof a === 'string' || typeof b === 'string') return a !== b;
      return num(a) !== num(b);
    });
    def('eq?', function (a, b) { return a === b; });
    def('equal?', function (a, b) { return R.inspect(a, 8) === R.inspect(b, 8); });

    /* -------------------------------------------------------- predicates */
    def('number?', function (v) { return typeof v === 'number'; });
    def('int?', function (v) { return typeof v === 'number' && Number.isInteger(v); });
    def('string?', function (v) { return typeof v === 'string'; });
    def('list?', function (v) { return Array.isArray(v); });
    def('bool?', function (v) { return typeof v === 'boolean'; });
    def('function?', function (v) { return global.HX.isCallable(v); });
    def('nil?', function (v) { return v === null || v === undefined; });
    def('truthy?', function (v) { return truthy(v); });
    def('zero?', function (v) { return num(v) === 0; });
    def('positive?', function (v) { return num(v) > 0; });
    def('negative?', function (v) { return num(v) < 0; });
    def('even?', function (v) { return num(v) % 2 === 0; });
    def('odd?', function (v) { return Math.abs(num(v) % 2) === 1; });
    def('dict?', function (v) { return !!(v && v.dict); });
    def('agent?', function (v) { return !!(v && v.isAgent); });
    def('cell?', function (v) { return !!(v && v.isCell); });
    def('genome?', function (v) { return !!(v && v.genome); });
    def('nan?', function (v) { return typeof v === 'number' && isNaN(v); });

    /* -------------------------------------------------------------- lists */
    function L() { var a = []; a.isList = true; return a; }
    def('list', function () {
      var a = L();
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      return a;
    });
    def('vector', function () {
      var a = [];
      for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
      a.isVector = true;
      return a;
    });
    def('cons', function (a, b) {
      var out = L(); out.push(a);
      if (Array.isArray(b)) for (var i = 0; i < b.length; i++) out.push(b[i]);
      else out.push(b);
      return out;
    });
    def('car', function (l) { var a = needList(l, 'car'); return a.length ? a[0] : null; });
    def('cdr', function (l) {
      var a = needList(l, 'cdr');
      var out = a.slice(1); out.isList = true; return out;
    });
    def('caar', function (l) {
      var inner = needList(needList(l, 'caar')[0], 'caar');
      return inner.length ? inner[0] : null;
    });
    def('cadr', function (l) { var a = needList(l, 'cadr'); return a.length > 1 ? a[1] : null; });
    def('caddr', function (l) { var a = needList(l, 'caddr'); return a.length > 2 ? a[2] : null; });
    def('cddr', function (l) { var out = needList(l, 'cddr').slice(2); out.isList = true; return out; });
    def('length', function (v) {
      if (typeof v === 'string') return v.length;
      if (v && v.genome) return v.genome.length;
      if (v && v.dict) return Object.keys(v.dict).length;
      return needList(v, 'length').length;
    });
    def('empty?', function (v) {
      if (typeof v === 'string') return v.length === 0;
      if (v && v.dict) return Object.keys(v.dict).length === 0;
      return needList(v, 'empty?').length === 0;
    });
    def('append', function () {
      var out = L();
      for (var i = 0; i < arguments.length; i++) {
        var a = asList(arguments[i]);
        for (var k = 0; k < a.length; k++) out.push(a[k]);
      }
      return out;
    });
    def('concat', function (a) {
      var out = L(), list = needList(a, 'concat');
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (Array.isArray(v)) { for (var k = 0; k < v.length; k++) out.push(v[k]); }
        else out.push(v);
      }
      return out;
    });
    def('reverse', function (v) {
      var a = needList(v, 'reverse'); var out = a.slice().reverse(); out.isList = true; return out;
    });
    def('nth', function (l, i) {
      /* Strings are lists of characters here. `(nth ramp 3)` is a natural thing
         to write when `ramp` is an alphabet, and rejecting it would be a
         gratuitous sharp edge. */
      var a = needList(asList(l), 'nth');
      var k = num(i, 'nth');
      if (k < 0) k += a.length;
      if (k < 0 || k >= a.length) err('nth: index ' + i + ' out of range (length ' + a.length + ')');
      return a[k];
    });
    def('nth?', function (l, i) {
      var a = needList(asList(l), 'nth?'); var k = num(i, 'nth?');
      if (k < 0) k += a.length;
      return (k >= 0 && k < a.length) ? a[k] : null;
    });
    def('set-nth!', function (l, i, v) {
      var a = needList(l, 'set-nth!'); var k = num(i, 'set-nth!');
      if (k < 0) k += a.length;
      if (k < 0 || k >= a.length) err('set-nth!: index out of range');
      a[k] = v; return v;
    });
    def('first', function (l) { return I.apply(G.get('car'), [l]); });
    def('last', function (l) { var a = needList(l, 'last'); return a.length ? a[a.length - 1] : null; });
    def('rest', function (l) { return I.apply(G.get('cdr'), [l]); });
    def('take', function (n, l) {
      var a = needList(l, 'take'); var k = Math.max(0, Math.min(a.length, num(n, 'take')));
      var out = a.slice(0, k); out.isList = true; return out;
    });
    def('drop', function (n, l) {
      var a = needList(l, 'drop'); var k = Math.max(0, Math.min(a.length, num(n, 'drop')));
      var out = a.slice(k); out.isList = true; return out;
    });
    def('range', function () {
      var a, b, step = 1;
      if (arguments.length === 1) { a = 0; b = num(arguments[0], 'range'); }
      else if (arguments.length === 2) { a = num(arguments[0], 'range'); b = num(arguments[1], 'range'); }
      else { a = num(arguments[0], 'range'); b = num(arguments[1], 'range'); step = num(arguments[2], 'range'); }
      if (step === 0) err('range: step cannot be zero');
      var out = [];
      if (step > 0) for (var v = a; v < b; v += step) out.push(v);
      else for (var v2 = a; v2 > b; v2 += step) out.push(v2);
      out.isList = true;
      if (out.length > 200000) err('range: refusing to build a list of ' + out.length + ' items');
      return out;
    });
    def('iota', function (n) {
      var out = [], k = num(n, 'iota');
      for (var i = 0; i < k; i++) out.push(i);
      out.isList = true; return out;
    });
    def('map', function (fn, coll) {
      var a = asList(coll), out = [];
      for (var i = 0; i < a.length; i++) out.push(I.withIndex(fn, a[i], i));
      out.isList = true; return out;
    });
    def('map2', function (fn, a, b) {
      var x = asList(a), y = asList(b), n = Math.min(x.length, y.length), out = [];
      for (var i = 0; i < n; i++) out.push(I.apply(fn, (fn.closure && fn.params.length >= 3) ? [x[i], y[i], i] : [x[i], y[i]]));
      out.isList = true; return out;
    });
    def('filter', function (fn, coll) {
      var a = asList(coll), out = [];
      for (var i = 0; i < a.length; i++) if (truthy(I.withIndex(fn, a[i], i))) out.push(a[i]);
      out.isList = true; return out;
    });
    def('remove', function (fn, coll) {
      var a = asList(coll), out = [];
      for (var i = 0; i < a.length; i++) if (!truthy(I.withIndex(fn, a[i], i))) out.push(a[i]);
      out.isList = true; return out;
    });
    def('reduce', function (fn, init, coll) {
      var a = asList(coll), acc = init;
      for (var i = 0; i < a.length; i++) acc = I.withIndex3(fn, acc, a[i], i);
      return acc;
    });
    def('fold', function (fn, init, coll) {
      return I.apply(G.get('reduce'), [fn, init, coll]);
    });
    def('any?', function (fn, coll) {
      var a = asList(coll);
      for (var i = 0; i < a.length; i++) if (truthy(I.withIndex(fn, a[i], i))) return true;
      return false;
    });
    def('all?', function (fn, coll) {
      var a = asList(coll);
      for (var i = 0; i < a.length; i++) if (!truthy(I.withIndex(fn, a[i], i))) return false;
      return true;
    });
    def('find', function (fn, coll) {
      var a = asList(coll);
      for (var i = 0; i < a.length; i++) if (truthy(I.withIndex(fn, a[i], i))) return a[i];
      return null;
    });
    def('find-index', function (fn, coll) {
      var a = asList(coll);
      for (var i = 0; i < a.length; i++) if (truthy(I.withIndex(fn, a[i], i))) return i;
      return -1;
    });
    def('index-of', function (v, coll) {
      var a = asList(coll);
      for (var i = 0; i < a.length; i++) if (a[i] === v) return i;
      return -1;
    });
    def('member?', function (v, coll) {
      var a = asList(coll);
      for (var i = 0; i < a.length; i++) if (a[i] === v) return true;
      return false;
    });
    def('sort', function (coll, fn) {
      var src = asList(coll);
      var idx = [], i;
      for (i = 0; i < src.length; i++) idx.push(i);
      if (fn) {
        var key = new Float64Array(src.length);
        for (i = 0; i < src.length; i++) key[i] = num(I.apply(fn, [src[i]]), 'sort');
        idx.sort(function (p, q) { return cmp(key[p], key[q]); });
      } else {
        idx.sort(function (p, q) {
          var x = src[p], y = src[q];
          if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : (x > y ? 1 : 0);
          return cmp(num(x), num(y));
        });
      }
      var out = [];
      for (i = 0; i < idx.length; i++) out.push(src[idx[i]]);
      out.isList = true;
      return out;
    });
    def('sort-by', function (fn, coll) { return I.apply(G.get('sort'), [coll, fn]); });
    def('sum', function (coll) {
      var a = asList(coll), s = 0;
      for (var i = 0; i < a.length; i++) s += num(a[i], 'sum');
      return s;
    });
    def('mean', function (coll) {
      var a = asList(coll);
      if (!a.length) return 0;
      var s = 0;
      for (var i = 0; i < a.length; i++) s += num(a[i], 'mean');
      return s / a.length;
    });
    def('variance', function (coll) {
      var a = asList(coll); if (!a.length) return 0;
      var s = 0, i;
      for (i = 0; i < a.length; i++) s += num(a[i]);
      var m = s / a.length, q = 0;
      for (i = 0; i < a.length; i++) { var d = num(a[i]) - m; q += d * d; }
      return q / a.length;
    });
    def('stddev', function (coll) { return Math.sqrt(I.apply(G.get('variance'), [coll])); });
    def('push!', function (l, v) { needList(l, 'push!').push(v); return l; });
    def('pop!', function (l) { var a = needList(l, 'pop!'); return a.length ? a.pop() : null; });
    def('shift!', function (l) { var a = needList(l, 'shift!'); return a.length ? a.shift() : null; });
    def('remove-at!', function (l, i) {
      var a = needList(l, 'remove-at!'); var k = num(i, 'remove-at!');
      if (k >= a.length || k < -a.length) return null;
      if (k < 0) k += a.length;
      return a.splice(k, 1)[0];
    });
    def('flatten', function (v) {
      var a = asList(v), out = [];
      (function walk(xs) {
        for (var i = 0; i < xs.length; i++) {
          if (Array.isArray(xs[i])) walk(xs[i]); else out.push(xs[i]);
        }
      })(a);
      out.isList = true; return out;
    });
    def('zip', function (a, b) {
      var x = asList(a), y = asList(b), n = Math.min(x.length, y.length), out = [];
      for (var i = 0; i < n; i++) { var p = [x[i], y[i]]; p.isList = true; out.push(p); }
      out.isList = true; return out;
    });
    def('enumerate', function (a) {
      var x = asList(a), out = [];
      for (var i = 0; i < x.length; i++) { var p = [i, x[i]]; p.isList = true; out.push(p); }
      out.isList = true; return out;
    });
    def('unique', function (coll) {
      var a = asList(coll), seen = new Set(), out = [];
      for (var i = 0; i < a.length; i++) {
        var key = typeof a[i] === 'object' && a[i] !== null ? R.inspect(a[i], 8) : a[i];
        if (!seen.has(key)) { seen.add(key); out.push(a[i]); }
      }
      out.isList = true; return out;
    });
    def('count', function (fn, coll) {
      var a = asList(coll), n = 0;
      for (var i = 0; i < a.length; i++) if (truthy(I.withIndex(fn, a[i], i))) n++;
      return n;
    });
    def('partition', function (fn, coll) {
      var a = asList(coll), yes = [], no = [];
      for (var i = 0; i < a.length; i++) (truthy(I.withIndex(fn, a[i], i)) ? yes : no).push(a[i]);
      yes.isList = true; no.isList = true;
      var pair = [yes, no]; pair.isList = true; return pair;
    });

    /* ------------------------------------------------------------ strings */
    def('str', function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(R.inspect(arguments[i], 3));
      return parts.join('');
    });
    def('symbol->string', function (s) {
      if (s && typeof s === 'object') {
        if (typeof s.sym === 'string') return s.sym;
        if (typeof s.kw === 'string') return s.kw;
      }
      return String(s);
    });
    function isSymv(s) { return s && typeof s === 'object' && typeof s.sym === 'string'; }
    def('string->symbol', function (s) { return R.sym(String(s)); });
    def('concat-str', function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(I.toString(arguments[i]));
      return parts.join('');
    });
    /* `string` reads better than `concat-str` inside string-building code,
       and `str` inspects its arguments (so a number becomes "1"), which is
       almost never what you want when building a label. */
    def('string', function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(I.toString(arguments[i]));
      return parts.join('');
    });
    def('substring', function (s, a, b) {
      s = String(s);
      if (b === undefined) return s.substring(num(a, 'substring'));
      return s.substring(num(a, 'substring'), num(b, 'substring'));
    });
    def('string-length', function (s) { return String(s).length; });
    def('uppercase', function (s) { return String(s).toUpperCase(); });
    def('upper', function (s) { return String(s).toUpperCase(); });
    def('lowercase', function (s) { return String(s).toLowerCase(); });
    def('lower', function (s) { return String(s).toLowerCase(); });
    def('trim', function (s) { return String(s).trim(); });
    def('split', function (s, sep) {
      var out = String(s).split(sep === undefined ? /\s+/ : String(sep));
      out.isList = true; return out;
    });
    def('replace', function (s, a, b) {
      return String(s).split(String(a)).join(String(b));
    });
    def('starts-with?', function (s, p) { return String(s).indexOf(String(p)) === 0; });
    def('ends-with?', function (s, p) {
      s = String(s); p = String(p);
      return p.length <= s.length && s.lastIndexOf(p) === s.length - p.length;
    });
    def('contains?', function (s, p) { return String(s).indexOf(String(p)) >= 0; });
    def('pad-left', function (s, n, ch) {
      s = String(s); ch = ch === undefined ? ' ' : String(ch);
      while (s.length < num(n)) s = ch + s;
      return s;
    });
    def('truncate', function (s, n) {
      s = String(s);
      var k = num(n, 'truncate');
      return s.length <= k ? s : s.slice(0, k - 1) + '\u2026';
    });
    def('pad-right', function (s, n, ch) {
      s = String(s); ch = ch === undefined ? ' ' : String(ch);
      while (s.length < num(n)) s = s + ch;
      return s;
    });
    def('number->string', function (v, dp) {
      var n = num(v, 'number->string');
      return dp === undefined ? String(n) : n.toFixed(num(dp));
    });
    def('parse-number', function (s) {
      var n = R.parseNumber(String(s).trim());
      return n === null ? null : n;
    });
    def('repeat-str', function (s, n) {
      var out = '';
      for (var i = 0; i < num(n); i++) out += s;
      return out;
    });

    /* ------------------------------------------------------------- dicts */
    def('dict', function () {
      var d = { dict: Object.create(null) };
      for (var i = 0; i + 1 < arguments.length; i += 2) d.dict[dictKey(arguments[i])] = arguments[i + 1];
      return d;
    });
    function dictKey(k) {
      if (isKwv(k)) return k.kw;
      if (typeof k === 'string') return k;
      if (k && typeof k === 'object' && typeof k.sym === 'string') return k.sym;
      return String(k);
    }
    function isKwv(k) { return k && typeof k === 'object' && typeof k.kw === 'string'; }
    def('get', function (d, k) {
      if (!d || !d.dict) err('get: expected a dict');
      var v = d.dict[dictKey(k)];
      return v === undefined ? null : v;
    });
    def('get?', function (d, k) {
      if (!d || !d.dict) err('get?: expected a dict');
      var v = d.dict[dictKey(k)];
      return v === undefined ? null : v;
    });
    def('has?', function (d, k) {
      if (!d || !d.dict) err('has?: expected a dict');
      return d.dict[dictKey(k)] !== undefined;
    });
    def('put!', function (d, k, v) {
      if (!d || !d.dict) err('put!: expected a dict');
      d.dict[dictKey(k)] = v; return v;
    });
    def('remove!', function (d, k) {
      if (!d || !d.dict) err('remove!: expected a dict');
      delete d.dict[dictKey(k)]; return d;
    });
    def('keys', function (d) {
      if (!d || !d.dict) err('keys: expected a dict');
      var out = Object.keys(d.dict).map(R.kw);
      out.isList = true; return out;
    });
    def('values', function (d) {
      if (!d || !d.dict) err('values: expected a dict');
      var ks = Object.keys(d.dict), out = [];
      for (var i = 0; i < ks.length; i++) out.push(d.dict[ks[i]]);
      out.isList = true; return out;
    });

    /* --------------------------------------------------------- functions */
    def('identity', function (v) { return v; });
    def('constantly', function (v) { var b = mk('constantly-fn', function () { return v; }); return b; });
    def('apply', function (fn, args) { return I.apply(fn, asList(args)); });
    def('compose', function () {
      var fns = Array.prototype.slice.call(arguments).reverse();
      return mk('compose', function () {
        var args = arguments;
        var v = I.apply(fns[0], args);
        for (var i = 1; i < fns.length; i++) v = I.apply(fns[i], [v]);
        return v;
      });
    });
    def('partial', function (fn) {
      var pre = Array.prototype.slice.call(arguments, 1);
      return mk('partial', function () {
        return I.apply(fn, pre.concat(Array.prototype.slice.call(arguments)));
      });
    });
    def('flip', function (fn) {
      return mk('flip', function (a, b) { return I.apply(fn, [b, a]); });
    });
    def('curry', function (fn) {
      var pre = Array.prototype.slice.call(arguments, 1);
      /* Only user closures have a knowable arity. A builtin is variadic by
       * default, so there is nothing to wait for — apply immediately. */
      function need(f) {
        if (f && f.closure) return f.params.length;
        return 0;
      }
      function go(f, acc) {
        return mk('curry', function () {
          var all = acc.concat(Array.prototype.slice.call(arguments));
          var want = need(f);
          if (want === 0 || all.length >= want) return I.apply(f, all);
          return go(f, all);
        });
      }
      return go(fn, pre);
    });

    /* ------------------------------------------------------------ random */
    var rng = new global.HX.Rng('axiom');
    def('seed!', function (s) { rng = new global.HX.Rng(String(s)); return null; });
    def('random', function (lo, hi) {
      if (lo === undefined) return rng.float(0, 1);
      if (hi === undefined) return rng.float(0, num(lo));
      return rng.float(num(lo), num(hi));
    });
    def('random-int', function (lo, hi) {
      if (hi === undefined) return rng.int(0, num(lo));
      return rng.int(num(lo), num(hi));
    });
    def('gauss', function (mu, sd) {
      if (mu === undefined) return rng.gauss(0, 1);
      return rng.gauss(num(mu), sd === undefined ? 1 : num(sd));
    });
    def('chance?', function (p) { return rng.chance(num(p, 'chance?')); });
    def('pick', function (coll) {
      var a = asList(coll);
      if (!a.length) return null;
      return a[rng.below(a.length)];
    });
    def('shuffle', function (coll) {
      var a = asList(coll).slice();
      rng.shuffle(a); a.isList = true; return a;
    });
    def('sample', function (n, coll) {
      var a = asList(coll).slice();
      rng.shuffle(a);
      var out = a.slice(0, Math.max(0, Math.min(a.length, num(n))));
      out.isList = true; return out;
    });

    /* -------------------------------------------------------------- misc */
    def('gensym', function (prefix) {
      I.gensymCount++;
      return R.sym((prefix ? String(prefix) : 'g') + I.gensymCount);
    });
    def('type', function (v) {
      if (v === null) return 'nil';
      if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
      if (typeof v === 'string') return 'string';
      if (typeof v === 'boolean') return 'boolean';
      if (Array.isArray(v)) return 'list';
      if (v && v.genome) return 'genome';
      if (v && v.isAgent) return 'agent';
      if (v && v.isCell) return 'cell';
      if (v && v.dict) return 'dict';
      if (v && v.builtin) return 'builtin';
      if (v && v.closure) return 'closure';
      return 'unknown';
    });
    def('gensym-count', function () { return I.gensymCount; });
    def('step-budget', function () { return I.stepBudget; });
    def('set-step-budget!', function (n) { I.stepBudget = num(n); return I.stepBudget; });
    def('eval', function (src) {
      var forms = R.read(I.toString(src));
      var last = null;
      for (var i = 0; i < forms.length; i++) last = I.eval(forms[i], I.global);
      return last;
    });
    def('macroexpand', function (src) {
      var forms = R.read(I.toString(src));
      if (!forms.length) return null;
      var out = I.eval(forms[0], I.global);
      return Array.isArray(out) ? out : out;
    });

    return G;
  }

  global.HX = global.HX || {};
  global.HX.builtins = { install: install };

})(typeof window !== 'undefined' ? window : globalThis);