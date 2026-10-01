/* ============================================================================
 * HORTUS / core/util.js
 * Math, colour and formatting primitives shared by every subsystem.
 * No DOM access in this file — it must stay loadable from Node.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = {};

  /* ---------------------------------------------------------------- scalars */

  U.TAU = Math.PI * 2;
  U.EPS = 1e-9;

  U.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  U.clamp01 = function (v) { return v < 0 ? 0 : (v > 1 ? 1 : v); };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.mix = U.lerp;
  U.invLerp = function (a, b, v) { return b - a === 0 ? 0 : (v - a) / (b - a); };
  U.remap = function (v, a, b, c, d) { return c + (d - c) * U.clamp01(U.invLerp(a, b, v)); };
  U.mod = function (a, n) { return ((a % n) + n) % n; };
  U.sign = function (v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); };
  U.wrap01 = function (v) { return v - Math.floor(v); };

  U.smoothstep = function (a, b, v) {
    var t = U.clamp01(U.invLerp(a, b, v));
    return t * t * (3 - 2 * t);
  };

  U.smootherstep = function (a, b, v) {
    var t = U.clamp01(U.invLerp(a, b, v));
    return t * t * t * (t * (t * 6 - 15) + 10);
  };

  /* Bell curve centred on `mu` with standard deviation `sd`. */
  U.gauss = function (v, mu, sd) {
    var d = (v - mu) / (sd || 1e-6);
    return Math.exp(-0.5 * d * d);
  };

  /* Trapezoid window: 0 outside [a,d], 1 between [b,c], smooth shoulders. */
  U.trap = function (v, a, b, c, d) {
    if (v <= a || v >= d) return 0;
    if (v >= b && v <= c) return 1;
    if (v < b) return U.smoothstep(a, b, v);
    return 1 - U.smoothstep(c, d, v);
  };

  /* ----------------------------------------------------------------- arrays */

  U.sum = function (a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; };
  U.mean = function (a) { return a.length ? U.sum(a) / a.length : 0; };
  U.max = function (a) { var m = -Infinity; for (var i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };
  U.min = function (a) { var m = Infinity; for (var i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; };

  U.argmax = function (a) {
    var m = -Infinity, k = 0;
    for (var i = 0; i < a.length; i++) if (a[i] > m) { m = a[i]; k = i; }
    return k;
  };

  /* Down-sample an array to at most `n` points, preserving the shape. */
  U.resample = function (arr, n) {
    if (arr.length <= n) return arr.slice();
    var out = [], step = (arr.length - 1) / (n - 1 || 1);
    for (var i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
    return out;
  };

  /* ---------------------------------------------------------------- strings */

  U.pad = function (s, n, ch) {
    s = String(s); ch = ch || '0';
    while (s.length < n) s = ch + s;
    return s;
  };

  U.fmt = function (n, dp) {
    if (n === Infinity) return 'inf';
    if (n === -Infinity) return '-inf';
    if (!isFinite(n)) return String(n);
    if (dp === undefined) dp = n >= 1000 ? 0 : (n >= 100 ? 1 : (n >= 10 ? 2 : 3));
    return (Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp)).toFixed(dp);
  };

  U.fmtInt = function (n) {
    var s = String(Math.round(n || 0)), out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s[i] + out;
      if (++c % 3 === 0 && i > 0) out = ',' + out;
    }
    return out;
  };

  U.bytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  };

  U.truncate = function (s, n) {
    s = String(s);
    return s.length <= n ? s : s.slice(0, n - 1) + '\u2026';
  };

  /* --------------------------------------------------------------- timing */

  U.Clock = function () {
    var last = 0, acc = 0, fps = 60, samples = [], i = 0;
    return {
      tick: function (now) {
        if (!now) now = Date.now();
        if (last) {
          var dt = now - last;
          if (dt < 0) dt = 0;
          samples[i++ % 30] = dt;
          var s = 0;
          for (var k = 0; k < samples.length; k++) s += (samples[k] || 0);
          fps = s > 0 ? 1000 / (s / Math.min(samples.length, 30)) : 60;
        }
        last = now;
        return fps;
      },
      fps: function () { return fps; },
      reset: function () { last = 0; samples = []; i = 0; }
    };
  };

  /* ----------------------------------------------------------------- colour */

  /* h in [0,360) degrees, s,l in [0,1] -> {r,g,b} 0..255 */
  U.hsl = function (h, s, l) {
    h = U.mod(h, 360) / 360;
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      var hk = function (t) {
        t = U.mod(t, 1);
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = hk(h + 1 / 3); g = hk(h); b = hk(h - 1 / 3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  };

  U.mixRgb = function (a, b, t) {
    return {
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t)
    };
  };

  U.rgbCss = function (c, a) {
    return a === undefined
      ? 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'
      : 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  };

  U.hexCss = function (c) {
    var h = function (n) { return U.pad(n.toString(16), 2, '0'); };
    return '#' + h(c.r) + h(c.g) + h(c.b);
  };

  /* Evenly-spaced perceptually-decent categorical palette. */
  U.ramp = function (t, stops) {
    t = U.clamp01(t);
    var n = stops.length - 1;
    var f = t * n;
    var i = Math.min(Math.floor(f), n - 1);
    return U.mixRgb(stops[i], stops[i + 1], f - i);
  };

  U.STOP = {
    ice:   [{ r: 12, g: 30, b: 58 }, { r: 122, g: 190, b: 214 }, { r: 246, g: 252, b: 255 }],
    fire:  [{ r: 28, g: 6, b: 40 }, { r: 186, g: 40, b: 62 }, { r: 250, g: 214, b: 96 }],
    moss:  [{ r: 14, g: 30, b: 18 }, { r: 74, g: 128, b: 58 }, { r: 190, g: 214, b: 120 }],
    viridis: [
      { r: 68, g: 1, b: 84 }, { r: 59, g: 82, b: 139 }, { r: 33, g: 145, b: 140 },
      { r: 94, g: 201, b: 98 }, { r: 253, g: 231, b: 37 }
    ],
    magma: [
      { r: 4, g: 4, b: 26 }, { r: 81, g: 18, b: 124 }, { r: 183, g: 55, b: 121 },
      { r: 252, g: 137, b: 97 }, { r: 252, g: 253, b: 191 }
    ],
    dusk: [
      { r: 8, g: 10, b: 24 }, { r: 26, g: 30, b: 66 }, { r: 78, g: 58, b: 122 },
      { r: 178, g: 96, b: 130 }, { r: 244, g: 176, b: 148 }
    ]
  };

  /* ------------------------------------------------------------ functional */

  /* Memoise a nullary function. */
  U.once = function (fn) {
    var done = false, val;
    return function () { if (!done) { val = fn(); done = true; } return val; };
  };

  /* Throttle calls to `fn` to at most once per `ms`. */
  U.throttle = function (fn, ms) {
    var last = 0, pending = null;
    return function () {
      var now = Date.now(), self = this, args = arguments;
      if (now - last >= ms) { last = now; fn.apply(self, args); }
      else if (!pending) {
        pending = setTimeout(function () { pending = null; last = Date.now(); fn.apply(self, args); }, ms - (now - last));
      }
    };
  };

  /* A tiny typed event emitter. */
  U.Emitter = function () {
    var map = {};
    return {
      on: function (k, fn) { (map[k] || (map[k] = [])).push(fn); return this; },
      off: function (k, fn) {
        var a = map[k]; if (!a) return this;
        var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); return this;
      },
      emit: function (k, payload) {
        var a = map[k]; if (!a) return this;
        for (var i = 0; i < a.length; i++) {
          try { a[i](payload); } catch (e) { if (global.console) console.error('[emitter]', k, e); }
        }
        return this;
      }
    };
  };

  /* ------------------------------------------------------------------- DOM */
  /* (guarded so the module remains Node-loadable) */

  U.isDom = function () { return typeof document !== 'undefined' && !!document.createElement; };

  U.el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };

  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  U.on = function (target, type, fn, opts) {
    if (!target) return function () {};
    target.addEventListener(type, fn, opts || false);
    return function () { target.removeEventListener(type, fn, opts || false); };
  };

  U.download = function (name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  };

  global.HX = global.HX || {};
  global.HX.U = U;

})(typeof window !== 'undefined' ? window : globalThis);