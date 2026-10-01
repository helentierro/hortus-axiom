/* ============================================================================
 * HORTUS / core/rng.js
 * Deterministic pseudo-randomness and coherent noise.
 *
 * Everything in HORTUS derives from a single 32-bit seed string, so a given
 * seed always reproduces byte-identical worlds. This module is the root of
 * that determinism and must never touch Math.random().
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;

  /* ------------------------------------------------------------- hashing */

  /* FNV-1a over a string -> uint32. */
  function hashString(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    /* avalanche */
    h ^= h >>> 16; h = (h * 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = (h * 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  function hashInt(n) {
    n = (n | 0) >>> 0;
    n ^= n >>> 16; n = (n * 0x7feb352d) >>> 0;
    n ^= n >>> 15; n = (n * 0x846ca68b) >>> 0;
    n ^= n >>> 16;
    return n >>> 0;
  }

  /* Deterministic hash of 2 (or 3) integers -> [0,1). */
  function hash2(x, y, salt) {
    var h = hashInt((x | 0) * 374761393 + (y | 0) * 668265263 + ((salt || 0) | 0) * 2147483647);
    return h / 4294967296;
  }

  function hash3(x, y, z, salt) {
    var h = hashInt(((x | 0) * 374761393) ^ ((y | 0) * 668265263) ^ ((z | 0) * 1103515245) ^ hashInt((salt || 0) + 0x9e3779b9));
    return h / 4294967296;
  }

  /* ---------------------------------------------------------------- RNG */

  /* mulberry32 — small, fast, statistically decent for a simulation. */
  function Mulberry32(seed) {
    var a = seed >>> 0;
    function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    next.seed = a;
    return next;
  }

  /* sfc32 — used for the "high quality" stream (genome noise). */
  function SFC32(a, b, c, d) {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      var t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  /* xoshiro128** — general purpose stream. */
  function Xoshiro128ss(a, b, c, d) {
    return function () {
      var t = Math.imul(b, 5);
      var r = ((((t << 7) | (t >>> 25)) >>> 0) * 9) >>> 0;
      var res = (((r << 11) | (r >>> 21)) >>> 0);
      var t2 = (b << 9) >>> 0;
      c ^= a; d ^= b; b ^= c; a ^= d; c ^= t2;
      d = ((d << 11) | (d >>> 21)) >>> 0;
      return res / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- Rng */

  function Rng(seed) {
    if (typeof seed === 'string') seed = hashString(seed);
    if (seed === undefined || seed === null || !isFinite(seed)) seed = hashString('hortus');
    this.seedValue = seed >>> 0;
    this.s = this.seedValue;
    var m = Mulberry32(this.seedValue);
    this._next = m;
    this.spare = null;
  }

  Rng.prototype.next = function () { return this._next(); };

  Rng.prototype.float = function (a, b) {
    if (a === undefined) return this._next();
    if (b === undefined) { b = a; a = 0; }
    return a + (b - a) * this._next();
  };

  Rng.prototype.int = function (a, b) {
    if (a === undefined) { b = a; a = 0; }
    return a + Math.floor(this._next() * (b - a));
  };

  /* Integer in [0,n). */
  Rng.prototype.below = function (n) { return Math.floor(this._next() * n) % (n || 1); };

  Rng.prototype.chance = function (p) { return this._next() < p; };

  Rng.prototype.pick = function (arr) { return arr[Math.floor(this._next() * arr.length) % arr.length]; };

  Rng.prototype.sign = function () { return this._next() < 0.5 ? -1 : 1; };

  /* Box-Muller with cached spare. */
  Rng.prototype.gauss = function (mu, sd) {
    mu = mu || 0; sd = sd === undefined ? 1 : sd;
    if (this.spare !== null) { var s = this.spare; this.spare = null; return mu + sd * s; }
    var u, v, sq;
    do {
      u = this._next() * 2 - 1;
      v = this._next() * 2 - 1;
      sq = u * u + v * v;
    } while (sq >= 1 || sq === 0);
    var m = Math.sqrt(-2 * Math.log(sq) / sq);
    this.spare = v * m;
    return mu + sd * u * m;
  };

  /* Uniform in [a,b) via gaussian rejection — better tails than float(). */
  Rng.prototype.bell = function (a, b, k) {
    k = k || 2.5;
    var v;
    var guard = 0;
    do { v = this.float(a, b); guard++; } while (guard < 12 && Math.abs(v - (a + b) / 2) > (b - a) / 2 / k * 2);
    return v;
  };

  Rng.prototype.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(this._next() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };

  /* Weighted pick: items is [{w:number, ...}] */
  Rng.prototype.weighted = function (items, weightFn) {
    var wf = weightFn || function (o) { return o.w; };
    var total = 0, i;
    for (i = 0; i < items.length; i++) total += Math.max(0, wf(items[i]));
    if (total <= 0) return items.length ? items[0] : null;
    var r = this._next() * total;
    for (i = 0; i < items.length; i++) {
      r -= Math.max(0, wf(items[i]));
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  };

  /* Derive an independent stream, tagged so streams never collide. */
  Rng.prototype.fork = function (tag) {
    return new Rng(hashInt(this.seedValue ^ hashString(String(tag)) ^ (this.calls | 0)));
  };

  /* Track call count for better stream separation. */
  var realNext = Rng.prototype.next;
  Rng.prototype.next = function () { this.calls = (this.calls || 0) + 1; return realNext.call(this); };
  var realFloat = Rng.prototype.float;
  Rng.prototype.float = function (a, b) { this.calls = (this.calls || 0) + 1; return realFloat.call(this, a, b); };
  var realInt = Rng.prototype.int;
  Rng.prototype.int = function (a, b) { this.calls = (this.calls || 0) + 1; return realInt.call(this, a, b); };

  /* ---------------------------------------------------------------- noise */

  /* Classic 2D value noise with quintic interpolation. Cheap and smooth. */
  function ValueNoise2D(rng) {
    var size = 256, mask = 255;
    var perm = new Uint8Array(size);
    var i;
    for (i = 0; i < size; i++) perm[i] = i;
    rng.shuffle(perm);
    var grad = new Float32Array(size);
    for (i = 0; i < size; i++) grad[i] = rng.float(0, 1);

    function at(ix, iy) {
      var h = (ix & mask) + ((iy & mask) << 1);
      return grad[h & mask];
    }

    function noise(x, y) {
      var x0 = Math.floor(x), y0 = Math.floor(y);
      var fx = x - x0, fy = y - y0;
      var ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
      var uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
      var n00 = at(x0, y0), n10 = at(x0 + 1, y0);
      var n01 = at(x0, y0 + 1), n11 = at(x0 + 1, y0 + 1);
      var a = n00 + (n10 - n00) * ux;
      var b = n01 + (n11 - n01) * ux;
      return a + (b - a) * uy;
    }

    /* Signed noise in [-1,1]. */
    function sn(x, y) { return noise(x, y) * 2 - 1; }

    /* Fractional Brownian motion. */
    function fbm(x, y, oct, lac, gain) {
      oct = oct || 4; lac = lac || 2.0; gain = gain || 0.5;
      var amp = 1, freq = 1, sum = 0, norm = 0;
      for (var o = 0; o < oct; o++) {
        sum += amp * sn(x * freq, y * freq);
        norm += amp;
        amp *= gain;
        freq *= lac;
      }
      return sum / norm;
    }

    /* Ridged multifractal — produces sharp mountain crests. */
    function ridged(x, y, oct, lac, gain) {
      oct = oct || 5; lac = lac || 2.0; gain = gain || 0.5;
      var amp = 1, freq = 1, sum = 0, norm = 0;
      for (var o = 0; o < oct; o++) {
        var n = 1 - Math.abs(sn(x * freq, y * freq));
        n *= n;
        sum += amp * n;
        norm += amp;
        amp *= gain;
        freq *= lac;
      }
      return sum / norm;
    }

    /* Billowy turbulence. */
    function billow(x, y, oct, lac, gain) {
      oct = oct || 4; lac = lac || 2.0; gain = gain || 0.5;
      var amp = 1, freq = 1, sum = 0, norm = 0;
      for (var o = 0; o < oct; o++) {
        sum += amp * Math.abs(sn(x * freq, y * freq));
        norm += amp;
        amp *= gain;
        freq *= lac;
      }
      return sum / norm;
    }

    /* Domain-warped fbm — the reason the coastlines look organic. */
    function warp(x, y, strength, oct) {
      var q1 = fbm(x, y, oct || 3);
      var q2 = fbm(x + 5.2, y + 1.3, oct || 3);
      var q3 = fbm(x + 9.7, y + 4.1, oct || 3);
      var r1 = fbm(x + strength * q1 + 1.7, y + strength * q2 + 9.2, oct || 3);
      var r2 = fbm(x + strength * q1 + 8.3, y + strength * q2 + 2.8, oct || 3);
      return fbm(x + strength * r1, y + strength * r2, oct || 4);
    }

    return { noise: noise, sn: sn, fbm: fbm, ridged: ridged, billow: billow, warp: warp };
  }

  /* Worley / cellular noise on a jittered lattice. Returns {f1, f2, cellId}. */
  function Worley2D(rng) {
    var rng2 = rng.fork ? rng.fork('worley') : rng;
    var SIZE = 64, MASK = 63;
    var px = new Float32Array(SIZE * SIZE);
    var py = new Float32Array(SIZE * SIZE);
    for (var i = 0; i < SIZE * SIZE; i++) { px[i] = rng2.float(); py[i] = rng2.float(); }

    function featureAt(ix, iy) {
      var h = ((ix & MASK) * SIZE + (iy & MASK));
      return h;
    }

    function raw(x, y) {
      var cx = Math.floor(x), cy = Math.floor(y);
      var f1 = 1e9, f2 = 1e9, id = 0;
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          var gx = cx + i, gy = cy + j;
          var h = featureAt(gx, gy);
          var fx = gx + px[h], fy = gy + py[h];
          var dx = fx - x, dy = fy - y;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) { f2 = f1; f1 = d; id = h; }
          else if (d < f2) { f2 = d; }
        }
      }
      return { f1: f1, f2: f2, id: id };
    }

    return { raw: raw, f1: function (x, y) { return raw(x, y).f1; } };
  }

  global.HX = global.HX || {};
  global.HX.Rng = Rng;
  global.HX.hashString = hashString;
  global.HX.hashInt = hashInt;
  global.HX.hash2 = hash2;
  global.HX.hash3 = hash3;
  global.HX.Mulberry32 = Mulberry32;
  global.HX.SFC32 = SFC32;
  global.HX.Xoshiro128ss = Xoshiro128ss;
  global.HX.ValueNoise2D = ValueNoise2D;
  global.HX.Worley2D = Worley2D;

})(typeof window !== 'undefined' ? window : globalThis);