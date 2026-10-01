/* ============================================================================
 * HORTUS / world/world.js
 *
 * The substrate. Generates a deterministic world from a seed string:
 *   1. tectonic elevation (domain-warped fbm + ridged orogeny + island arcs)
 *   2. hydrology (D8-ish flow accumulation over a sorted height order,
 *      which yields believable rivers and river mouths for free)
 *   3. orographic rainfall (sky-view factor -> rain shadows)
 *   4. temperature (latitude, lapse rate, ocean moderation, seasonal swing)
 *   5. biome classification and vegetation seeding
 *
 * Every stage is a pure function of the seed, so worlds are reproducible.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;
  var Rng = global.HX.Rng;
  var ValueNoise2D = global.HX.ValueNoise2D;
  var HexGrid = global.HX.HexGrid;

  /* -------------------------------------------------------------- biomes */

  var B = [
    { key: 'DEEP',      name: 'Abyssal',    fert: 0.42, canopy: 0.15, col: [6, 16, 38],    spawn: 0.30 },
    { key: 'OCEAN',     name: 'Ocean',      fert: 0.30, canopy: 0.10, col: [14, 46, 84],   spawn: 0.24 },
    { key: 'SHALLOWS',  name: 'Shallows',   fert: 0.52, canopy: 0.20, col: [30, 104, 128], spawn: 0.34 },
    { key: 'ICE',       name: 'Glacier',    fert: 0.00, canopy: 0.00, col: [206, 228, 242],spawn: 0.00 },
    { key: 'TUNDRA',    name: 'Tundra',     fert: 0.24, canopy: 0.12, col: [126, 138, 118],spawn: 0.05 },
    { key: 'TAIGA',     name: 'Taiga',      fert: 0.70, canopy: 0.55, col: [52, 82, 62],   spawn: 0.09 },
    { key: 'ALPINE',    name: 'Alpine',     fert: 0.10, canopy: 0.05, col: [138, 138, 146], spawn: 0.00 },
    { key: 'HIGHLAND',  name: 'Highland',   fert: 0.40, canopy: 0.20, col: [104, 112, 84],  spawn: 0.03 },
    { key: 'MARSH',     name: 'Marsh',      fert: 0.95, canopy: 0.45, col: [64, 96, 74],   spawn: 0.20 },
    { key: 'FOREST',    name: 'Forest',     fert: 1.00, canopy: 0.80, col: [40, 78, 48],   spawn: 0.10 },
    { key: 'GRASS',     name: 'Grassland',  fert: 0.88, canopy: 0.18, col: [110, 138, 70],  spawn: 0.10 },
    { key: 'SAVANNA',   name: 'Savanna',    fert: 0.58, canopy: 0.16, col: [150, 146, 78],  spawn: 0.04 },
    { key: 'STEPPE',    name: 'Steppe',     fert: 0.46, canopy: 0.08, col: [166, 156, 112], spawn: 0.03 },
    { key: 'DESERT',    name: 'Desert',     fert: 0.05, canopy: 0.02, col: [198, 176, 128], spawn: 0.00 },
    { key: 'BEACH',     name: 'Shore',      fert: 0.18, canopy: 0.04, col: [214, 198, 158], spawn: 0.06 },
    { key: 'BARRENS',   name: 'Barrens',    fert: 0.04, canopy: 0.00, col: [104, 96, 92],   spawn: 0.00 },
    { key: 'BLIGHT',    name: 'Blight',     fert: 0.26, canopy: 0.22, col: [74, 62, 78],   spawn: 0.06 },
    { key: 'VENT',      name: 'Vent',       fert: 0.14, canopy: 0.00, col: [58, 44, 44],   spawn: 0.00 }
  ];

  var N_BIOME = B.length;

  var SEA_KEYS = { DEEP: 0, OCEAN: 1, SHALLOWS: 2 };

  function biomeName(id) { return (B[id] || B[0]).name; }
  function biomeKey(id) { return (B[id] || B[0]).key; }
  function biomeFert(id) { return (B[id] || B[0]).fert; }

  /* --------------------------------------------------------------- World */

  function World(opts) {
    opts = opts || {};
    this.w = opts.w || 220;
    this.h = opts.h || 140;
    this.seedStr = String(opts.seed === undefined ? 'hortus' : opts.seed);
    this.grid = new HexGrid(this.w, this.h);
    var n = this.grid.size;

    this.emitter = new U.Emitter();
    this.rng = new Rng(this.seedStr);
    this.noise = ValueNoise2D(this.rng);
    var n2 = ValueNoise2D(this.rng.fork('climate'));
    this.noise2 = n2;
    var n3 = ValueNoise2D(this.rng.fork('detail'));
    this.noise3 = n3;

    /* --- cell fields (structure of arrays) ----------------------------- */
    this.hRaw = new Float32Array(n);      /* 0..1 pre-normalisation elevation */
    this.elev = new Float32Array(n);      /* land: 0..1 above sea; water: negative */
    this.water = new Float32Array(n);     /* 0..1 depth (0 = dry)              */
    this.temp = new Float32Array(n);      /* 0..1 potential temperature        */
    this.tempNow = new Float32Array(n);   /* temp incl. season + weather       */
    this.moist = new Float32Array(n);     /* 0..1                             */
    this.veg = new Float32Array(n);       /* 0..1 standing biomass            */
    this.vegTarget = new Float32Array(n);
    this.graze = new Float32Array(n);     /* consumed this tick                */
    this.snow = new Float32Array(n);      /* 0..1                             */
    this.flux = new Float32Array(n);      /* 0..1 river discharge (normalised)*/
    this.biome = new Uint8Array(n);
    this.fert = new Float32Array(n);
    this.canopy = new Float32Array(n);
    this.scorch = new Float32Array(n);    /* event-driven damage 0..1          */
    this.occ = new Int16Array(n);         /* occupant agent id, -1 = empty      */
    this.occ.fill(-1);
    this.crowd = new Int16Array(n);
    this.dWater = new Int16Array(n);      /* hex distance to nearest water     */
    this.precip = new Float32Array(n);    /* orographic rainfall 0..1          */

    /* --- clock & climate ----------------------------------------------- */
    this.daysPerSeason = opts.daysPerSeason || 40;
    this.seasonsPerYear = 4;
    this.daysPerYear = this.daysPerSeason * this.seasonsPerYear;
    this.time = { t: 0, day: 0, year: 1, phase: 0, season: 0, seasonName: 'Spring', dayFrac: 0 };

    this.weather = {
      rain: 0, targetRain: 0, storm: 0, wind: 0.3, windDir: 0,
      cloud: 0.35, tempOffset: 0, flash: 0
    };

    this.lakes = 0;
    this.riverCells = 0;
    this.coverage = { land: 0, water: 0, peak: 0, trench: 1 };

    this.generate();
  }

  World.prototype.generate = function () {
    var g = this.grid, n = g.size;
    var i, x, y, k;

var rng = this.rng;
    var nse = this.noise, nse2 = this.noise2, nse3 = this.noise3;

    /* ---------------- 1. tectonic elevation ---------------------------- */
    /* Warp the domain hard. Domain warping is what turns a smooth blob into a
     * coastline with peninsulas, bays and offshore islands; a weakly warped
     * super-ellipse just gives you an oval, which reads as a smudge rather
     * than as a continent. */
    var warpStrength = rng.float(0.34, 0.52);
    var islandCount = rng.int(3, 6);
    var islands = [];
    for (k = 0; k < islandCount; k++) {
      islands.push({
        x: rng.float(-0.3, 1.3),
        y: rng.float(-0.2, 1.2),
        r: rng.float(0.05, 0.16),
        h: rng.float(0.05, 0.24),
        arc: rng.chance(0.45)
      });
    }
    /* Continental outline: a super-ellipse with a noisy radius, so worlds have
     * a definite "shore of the world" the player can reach. */
    var contX = rng.float(0.42, 0.58), contY = rng.float(0.44, 0.56);
    var contRx = rng.float(0.32, 0.48), contRy = rng.float(0.34, 0.50);
    var squish = rng.float(1.5, 2.6);

    var minR = 1e9, maxR = -1e9;
    for (y = 0; y < this.h; y++) {
      for (x = 0; x < this.w; x++) {
        i = y * this.w + x;
        var u = x / this.w, v = y / this.h;

        var wx = nse.fbm(u * 2.1 + 17.3, v * 2.1 + 4.9, 3) * warpStrength;
        var wy = nse.fbm(u * 2.1 + 61.1, v * 2.1 + 88.7, 3) * warpStrength;
        var su = u + wx, sv = v + wy;

        /* continental mask. Two octaves of radius perturbation: a low-frequency one
         * that pushes whole coasts in and out, and a high-frequency one that
         * nibbles the shoreline itself. */
        var dx = (u - contX) / contRx, dy = (v - contY) / contRy;
        var d = Math.pow(Math.pow(Math.abs(dx), squish) + Math.pow(Math.abs(dy), squish), 1 / squish);
        d += nse.fbm(su * 2.6, sv * 2.6, 4) * 0.34;
        d += nse.fbm(su * 7.5, sv * 7.5, 3) * 0.13;
        var mask = 1 - U.smoothstep(0.58, 1.08, d);

        /* island arcs riding on top */
        var isl = 0;
        for (k = 0; k < islands.length; k++) {
          var I = islands[k];
          var ix = (u - I.x), iy = (v - I.y);
          var ir = Math.sqrt(ix * ix + iy * iy);
          if (I.arc) {
            /* crescent: modulate radius by angle */
            var ang = Math.atan2(iy, ix);
            ir *= 1 + 0.42 * Math.cos(ang - rng.seedValue * 0.0001 + k);
          }
          isl = Math.max(isl, I.h * (1 - U.smoothstep(I.r * 0.35, I.r, ir)));
        }

        /* base continental relief + orogeny.
         * The orogenic belt is deliberately narrow and high-amplitude: wide,
         * gentle belts flatten half the world into one elevation band and
         * destroy any readable geography. */
        var relief = nse.fbm(su * 3.1, sv * 3.1, 6, 2.05, 0.52) * 0.5 + 0.5;
        var belt = nse.ridged(su * 4.6 + 3.3, sv * 4.6 - 2.1, 5, 2.1, 0.48);
        var beltMask = U.smoothstep(0.54, 0.86, nse.fbm(su * 1.45 - 9.1, sv * 1.45 + 5.5, 3) * 0.5 + 0.5);
        var mountains = Math.pow(belt, 1.85) * beltMask;

        var shelves = nse.fbm(su * 8.5, sv * 8.5, 4) * 0.055;

        var h = 0.30 + relief * 0.40 + mountains * 0.46 + isl - shelves;
        h *= (0.40 + mask * 0.78);
        h += (1 - mask) * 0.03;

        this.hRaw[i] = h;
        if (h < minR) minR = h;
        if (h > maxR) maxR = h;
      }
    }

    /* sea level: choose the elevation quantile that yields the requested land
     * fraction. Quotas, not the mean, because the elevation histogram is
     * strongly left-skewed by the continental mask. */
    var sorted = Array.prototype.slice.call(this.hRaw);
    sorted.sort(function (a, b) { return a - b; });
    var targetLand = rng.float(0.54, 0.64);
    var si = Math.floor((1 - targetLand) * (sorted.length - 1));
    var seaLevel = sorted[si];
    var minRaw = sorted[0];
    this.seaLevel = seaLevel;
    this.minRaw = minRaw;

    /* ---------------- 2. carve water + elevation ------------------------ */
    var land = 0, waterCells = 0, peak = -1e9, trench = 1e9;
    var band = Math.max(1e-6, seaLevel - minRaw);
    for (i = 0; i < n; i++) {
      var hr = this.hRaw[i];
      if (hr < seaLevel) {
        /* depth spans the full [minRaw, seaLevel] range so the ocean reads as
         * a real bathymetric gradient instead of a flat plateau */
        var depth = (seaLevel - hr) / band;
        this.water[i] = U.clamp01(Math.pow(U.clamp01(depth), 0.72));
        this.elev[i] = -this.water[i];
        waterCells++;
        if (depth > trench) trench = depth;
      } else {
        this.elev[i] = (hr - seaLevel) / band;
        this.water[i] = 0;
        land++;
        if (this.elev[i] > peak) peak = this.elev[i];
      }
    }

    /* Re-normalise land elevation against a high quantile rather than the
     * global max: one freak summit should not flatten the whole map. */
    var landElev = new Float32Array(land);
    var li = 0;
    for (i = 0; i < n; i++) if (this.water[i] === 0) landElev[li++] = this.elev[i];
    var le = Array.prototype.slice.call(landElev);
    le.sort(function (a, b) { return a - b; });
    var qHi = le[Math.min(le.length - 1, Math.floor(le.length * 0.995))];
    var qLo = le[Math.floor(le.length * 0.02)];
    var eSpan = Math.max(1e-6, qHi - qLo);
    peak = -1e9;
    for (i = 0; i < n; i++) {
      if (this.water[i] === 0) {
        this.elev[i] = U.clamp01((this.elev[i] - qLo) / eSpan);
        if (this.elev[i] > peak) peak = this.elev[i];
      } else {
        this.elev[i] = -U.clamp01(this.elev[i] * 0.62);
      }
    }

    this.coverage.land = land / n;
    this.coverage.water = waterCells / n;
    this.coverage.peak = peak;
    this.coverage.trench = trench;

    /* Smooth the water boundary once so beaches read as gradients, not stairs. */
    this.smoothField(this.water, 1, 0.32);

    /* ---------------- 3. hydrology: flow accumulation ------------------ */
    this.computeFlux();

    /* ---------------- 4. distance to water (BFS) ----------------------- */
    this.computeWaterDistance();

    /* ---------------- 5. rainfall & moisture --------------------------- */
    this.computeClimate();

    /* ---------------- 6. biomes & vegetation --------------------------- */
    this.computeLatAmplitudes();
    /* Open the world in daylight rather than at midnight. The first thing a
     * person sees should not be a blue silhouette with no readable biomes. */
    this.time.t = 0.42;
    this.advanceTime(0);
    this.recomputeTemps();
    this.classifyAll();
    this.seedVegetation();

    this.primeTextures = true;
  };

  /* Separable box blur, `passes` iterations. Operates in place. */
  World.prototype.smoothField = function (field, passes, amount) {
    passes = passes || 1;
    amount = amount === undefined ? 0.5 : amount;
    var n = field.length;
    var tmp = new Float32Array(n);
    for (var p = 0; p < passes; p++) {
      /* horizontal */
      for (var y = 0; y < this.h; y++) {
        var row = y * this.w;
        var l = field[row], c = field[row];
        for (var x = 0; x < this.w; x++) {
          var r = field[row + x];
          tmp[row + x] = c * (1 - amount) + (l + r) * 0.5 * amount;
          l = c; c = r;
        }
      }
      /* vertical */
      for (var x2 = 0; x2 < this.w; x2++) {
        var u = tmp[x2];
        var cc = tmp[x2];
        for (var y2 = 0; y2 < this.h; y2++) {
          var idx = y2 * this.w + x2;
          var d = tmp[idx + (y2 < this.h - 1 ? this.w : 0)];
          field[idx] = cc * (1 - amount) + (u + d) * 0.5 * amount;
          u = cc; cc = d;
        }
      }
    }
  };

  /* In-place separable Gaussian-ish blur (3 taps, sigma ~1.2). */
  World.prototype.blurField = function (field, passes) {
    passes = passes || 1;
    var n = field.length, w = this.w, h = this.h;
    var tmp = new Float32Array(n), i, x, y;
    for (var p = 0; p < passes; p++) {
      for (y = 0; y < h; y++) {
        var row = y * w;
        for (x = 0; x < w; x++) {
          var a = field[row + (x > 0 ? x - 1 : 0)];
          var b = field[row + x];
          var c = field[row + (x < w - 1 ? x + 1 : w - 1)];
          tmp[row + x] = (a + 2 * b + c) * 0.25;
        }
      }
      for (x = 0; x < w; x++) {
        for (y = 0; y < h; y++) {
          var i0 = y * w + x;
          var up = tmp[(y > 0 ? y - 1 : 0) * w + x];
          var mid = tmp[i0];
          var dn = tmp[(y < h - 1 ? y + 1 : h - 1) * w + x];
          field[i0] = (up + 2 * mid + dn) * 0.25;
        }
      }
    }
  };

  /* --- flow accumulation -------------------------------------------------
   * Rain is dropped on every land cell, then routed downhill. Processing
   * cells in strict descending elevation order guarantees that all upstream
   * contributions have already arrived by the time we route a cell, so a
   * single pass produces exact accumulation (no iteration needed).
   * -------------------------------------------------------------------- */
  World.prototype.computeFlux = function () {
    var g = this.grid, n = g.size, i, d;
    var order = new Int32Array(n);
    var acc = new Float32Array(n);
    var isLand = new Uint8Array(n);
    var river = new Uint8Array(n);

    for (i = 0; i < n; i++) {
      isLand[i] = this.water[i] > 0.02 ? 0 : 1;
      acc[i] = 1.0; /* unit rainfall per cell */
      order[i] = i;
    }

    /* descending elevation */
    var elev = this.elev;
    var arr = Array.prototype.slice.call(order);
    arr.sort(function (a, b) { return elev[b] - elev[a]; });

    var riverThreshold = 0;
    for (i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (!isLand[c]) continue;
      /* pick the steepest downhill neighbour */
      var best = -1, bestDrop = 0;
      for (d = 0; d < 6; d++) {
        var nb = g.nbr[c * 6 + d];
        if (nb < 0) continue;
        var drop = elev[c] - elev[nb];
        if (drop > bestDrop) { bestDrop = drop; best = nb; }
      }
      if (best < 0) continue;
      /* water bodies terminate a river */
      if (this.water[best] > 0.02 || isLand[best] === 0) {
        river[c] = 1;
        continue;
      }
      acc[best] += acc[c];
      if (acc[c] > riverThreshold) riverThreshold = acc[c];
    }

    /* normalise, then carve the channel */
    var hi = 1;
    for (i = 0; i < n; i++) if (acc[i] > hi) hi = acc[i];
    var logMax = Math.log(1 + hi);
    this.riverCells = 0;
    for (i = 0; i < n; i++) {
      var f = U.clamp01(Math.log(1 + acc[i]) / logMax);
      this.flux[i] = river[i] ? Math.max(f, 0.22) : 0;
      if (river[i]) this.riverCells++;
    }
    /* rivers carve their own channel a little into the elevation */
    for (i = 0; i < n; i++) {
      if (this.flux[i] > 0.3 && this.water[i] === 0) {
        this.elev[i] = Math.max(0, this.elev[i] - 0.045 * this.flux[i]);
      }
    }
  };

  /* Multi-source BFS from all water cells -> hex distance to nearest water. */
  World.prototype.computeWaterDistance = function () {
    var n = this.grid.size;
    var dist = new Int32Array(n);
    var queue = new Int32Array(n);
    var head = 0, tail = 0, i, d;
    var MAXD = 400;
    for (i = 0; i < n; i++) {
      if (this.water[i] > 0.02) { dist[i] = 0; queue[tail++] = i; }
      else dist[i] = MAXD;
    }
    var g = this.grid;
    while (head < tail) {
      var c = queue[head++];
      var dc = dist[c];
      if (dc >= MAXD) continue;
      for (d = 0; d < 6; d++) {
        var nb = g.nbr[c * 6 + d];
        if (nb < 0) continue;
        if (dist[nb] > dc + 1) { dist[nb] = dc + 1; queue[tail++] = nb; }
      }
    }
    for (i = 0; i < n; i++) this.dWater[i] = Math.min(255, dist[i]);
  };

  /* Orographic rainfall + temperature. */
  World.prototype.computeClimate = function () {
    var g = this.grid, n = g.size, i, k, d;
    var nse = this.noise3;

    /* Latitude: symmetric about the middle with a slight tilt, so the two
     * hemispheres are not mirror images of each other. */
    for (i = 0; i < n; i++) {
      var lat = (g.row[i] / (this.h - 1));
      var tilt = nse.fbm(i * 0.002, 0.5, 2) * 0.06;
      this.temp[i] = U.clamp01(1.12 - Math.abs(lat + tilt - 0.5) * 1.70);
    }
    this.blurField(this.temp, 1);

    /* Lapse rate with elevation; oceans moderate toward the annual mean. */
    for (i = 0; i < n; i++) {
      if (this.water[i] > 0.02) {
        this.temp[i] = U.clamp01(U.lerp(this.temp[i], 0.55, 0.25 + this.water[i] * 0.5));
      } else {
        this.temp[i] = U.clamp01(this.temp[i] - this.elev[i] * 0.70);
      }
    }
    this.blurField(this.temp, 1);

    /* Sky-view factor -> rain shadows on the lee side of ranges. */
    var horizon = new Float32Array(n);
    var DIST = [1, 2, 3, 5, 7, 10, 14, 19];
    for (i = 0; i < n; i++) {
      if (this.water[i] > 0.02) { horizon[i] = 1; continue; }
      var maxAng = 0;
      var e0 = this.elev[i];
      for (d = 0; d < 6; d++) {
        var cur = i;
        for (k = 0; k < DIST.length; k++) {
          cur = g.nbr[cur * 6 + d];
          if (cur < 0) break;
          var ang = Math.atan2(Math.max(0, this.elev[cur] - e0), DIST[k]);
          if (ang > maxAng) maxAng = ang;
        }
      }
      horizon[i] = U.clamp01(1 - maxAng / 0.95);
    }
    this.blurField(horizon, 1);

    for (i = 0; i < n; i++) {
      var lat2 = Math.abs(g.row[i] / (this.h - 1) - 0.5) * 2;
      /* ITCZ: wet near the equator, dry subtropics, wet again at the poles */
      var band = 0.74 + 0.46 * Math.exp(-Math.pow((lat2 - 0.00) * 3.0, 2))
                      - 0.34 * Math.exp(-Math.pow((lat2 - 0.44) * 3.6, 2))
                      + 0.26 * Math.exp(-Math.pow((lat2 - 0.90) * 4.8, 2));
      var noise = this.noise2.fbm(g.px[i] * 0.045, g.py[i] * 0.045, 4) * 0.5 + 0.5;
      var coastal = 1 - U.clamp01(this.dWater[i] / 9);
      var p = U.clamp01(band * (0.55 + 0.65 * noise) * (0.42 + 0.72 * horizon[i])
                        + coastal * 0.24 - 0.06);
      this.precip[i] = p;
      this.moist[i] = U.clamp01(p * 0.80 + coastal * 0.26 + noise * 0.10 - 0.04);
    }
    this.blurField(this.moist, 1);
  };

  /* Quantiles of `field` over land cells only. Sorting a copy of the field is
   * O(n log n) but happens once per world, and it buys us thresholds that mean
   * the same thing on every seed. */
  function landQuantiles(world, field, ps) {
    var n = world.grid.size;
    var vals = [];
    for (var i = 0; i < n; i++) if (world.water[i] <= 0.02) vals.push(field[i]);
    vals.sort(function (a, b) { return a - b; });
    var out = [];
    for (var k = 0; k < ps.length; k++) {
      out.push(vals[Math.min(vals.length - 1, Math.floor(ps[k] * (vals.length - 1)))] || 0);
    }
    return out;
  }

  /* Build the threshold set used by `classify`. Mixing quantiles with a few
   * absolute values keeps the geography seed-independent without flattening
   * the differences between worlds. */
  World.prototype.computeThresholds = function () {
    this.qe = landQuantiles(this, this.elev, [0.06, 0.16, 0.34, 0.52, 0.70, 0.84, 0.93, 0.975]);
    this.qm = landQuantiles(this, this.moist, [0.08, 0.20, 0.38, 0.56, 0.72, 0.86, 0.94]);
    this.qt = landQuantiles(this, this.temp, [0.04, 0.10, 0.20, 0.38, 0.56, 0.74, 0.88]);
    this.thr = {
      e1: this.qe[0], e2: this.qe[1], e3: this.qe[2], e4: this.qe[3],
      e5: this.qe[4], e6: this.qe[5], e7: this.qe[6], e8: this.qe[7],
      m1: this.qm[0], m2: this.qm[1], m3: this.qm[2], m4: this.qm[3],
      m5: this.qm[4], m6: this.qm[5], m7: this.qm[6],
      t1: this.qt[0], t2: this.qt[1], t3: this.qt[2], t4: this.qt[3],
      t5: this.qt[4], t6: this.qt[5], t7: this.qt[6]
    };
    return this.thr;
  };

  /* Classify a single cell. Pure with respect to the cell's fields, so it can
   * be re-run cheaply after an event perturbs the terrain. */
  World.prototype.classify = function (i) {
    var w = this.water[i];
    var e = this.elev[i];
    var m = this.moist[i];
    var f = this.flux[i];
    var T = this.thr;
    /* Biomes are CLIMATIC types, so classification uses the annual mean
     * temperature. Seasonal expression is carried by `snow` and by agents. */
    var t = this.temp[i];

    if (this.scorch[i] > 0.55) return 17; /* VENT   */
    if (this.scorch[i] > 0.16) return 16; /* BLIGHT */

    if (w > 0.02) {
      /* river floodplains: shallow, flat, wet */
      if (f > 0.42 && this.dWater[i] <= 1 && e < 0.02) return 8;
      if (w > 0.70) return 0; /* DEEP     */
      if (w > 0.34) return 1; /* OCEAN    */
      return 2;               /* SHALLOWS */
    }

    /* beaches hug the waterline */
    if (this.dWater[i] <= 1 && e < 0.022) return 14;
    /* seasonal snow cover wins over everything below the snowline */
    if (this.snow[i] > 0.62 && t < 0.34) return 3; /* ICE */

    /* --- altitude ---------------------------------------------------- */
    if (e > T.e7 && t < 0.52) return 6;                  /* ALPINE   */
    if (e > T.e6 && m < T.m2) return 15;                 /* BARRENS  */
    if (e > T.e6) return 7;                              /* HIGHLAND */
    if (e > T.e4 && m < T.m1) return 15;                 /* BARRENS  */

    /* --- cold climates ------------------------------------------------ */
    if (t < T.t2) return t < T.t1 ? 3 : 4;                /* ICE/TUNDRA */
    if (t < T.t3) return m > T.m4 ? 5 : 4;                /* TAIGA/TUNDRA */

    /* --- hot + dry short-circuits: subtropical deserts ignore the
           moisture distribution, which is dominated by the temperate zone --- */
    if (t > T.t5 && m < T.m2) return 13;                  /* DESERT  */
    if (t > T.t6 && m < T.m3) return 11;                  /* SAVANNA */

    /* --- moisture ------------------------------------------------------ */
    if (m > T.m7) return (e < 0.10 && this.dWater[i] < 5) ? 8 : 9; /* MARSH/FOREST */
    if (m > T.m6) return 9;                              /* FOREST  */
    if (m > T.m5) return e < 0.16 ? 10 : (t < T.t5 ? 5 : 9);      /* GRASS/TAIGA/FOREST */
    if (m > T.m4) return 10;                             /* GRASS   */
    if (m > T.m3) return t > T.t5 ? 11 : (t < T.t5 ? 5 : 10);     /* SAVANNA/TAIGA/GRASS */
    if (m > T.m2) return t > T.t6 ? 11 : 12;             /* SAVANNA/STEPPE */
    if (m > T.m1) return 12;                             /* STEPPE  */
    return 13;                                           /* DESERT  */
  };

  World.prototype.classifyAll = function () {
    var n = this.grid.size, i;
    this.computeThresholds();
    var count = new Int32Array(N_BIOME);
    for (i = 0; i < n; i++) {
      var b = this.classify(i);
      this.biome[i] = b;
      this.fert[i] = B[b].fert;
      this.canopy[i] = B[b].canopy;
      count[b]++;
    }
    this.biomeCounts = count;
  };

  World.prototype.seedVegetation = function () {
    var n = this.grid.size, i;
    for (i = 0; i < n; i++) {
      var f = this.fert[i];
      var scatter = this.noise3.fbm(this.grid.px[i] * 0.22, this.grid.py[i] * 0.22, 3) * 0.5 + 0.5;
      this.veg[i] = U.clamp01(f * (0.35 + 0.65 * scatter));
      this.vegTarget[i] = this.veg[i];
    }
  };

  /* ------------------------------------------------------------- climate */

  var SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];

  World.prototype.advanceTime = function (days) {
    this.time.t += days;
    var yf = this.time.t / this.daysPerYear;
    var day = Math.floor(this.time.t);
    this.time.year = Math.floor(yf) + 1;
    this.time.phase = yf - Math.floor(yf);
    this.time.day = day;
    this.time.season = Math.floor(this.time.phase * 4) % 4;
    this.time.seasonName = SEASONS[this.time.season];
    this.time.dayFrac = (this.time.t - day);
  };

  /* Per-cell seasonal amplitude, derived once. Recomputing it every tick meant
     * two divisions per cell inside the hottest loop in the whole program. */
  World.prototype.computeLatAmplitudes = function () {
    var n = this.grid.size;
    this.latAmp = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var lat = Math.abs(this.grid.row[i] / (this.h - 1) - 0.5) * 2;
      this.latAmp[i] = 0.08 + lat * 0.36;   /* high latitudes swing harder */
    }
  };

  World.prototype.recomputeTemps = function () {
    var n = this.grid.size;
    var tempNow = this.tempNow, temp = this.temp, water = this.water;
    var amp = this.latAmp || (this.computeLatAmplitudes(), this.latAmp);
/* Season 0 (phase 0) is the start of spring, so the temperature curve is
      * sin(TAU * (phase - 0.125)): the trough falls in mid-winter and the peak
      * in mid-summer. It used to be -cos(TAU * phase) with a comment about a
      * "thermal lag", but that put the annual maximum at phase 0.5, which is
      * the start of AUTUMN — so the season labelled Spring was the coldest
      * season and Autumn the hottest, and a spring screenshot came out as a
      * white snowball while the growth curve (seasonFactor) peaked in summer.
      * Two curves disagreeing about when summer is is not a look, it is a bug. */
    var seasonal = Math.sin(U.TAU * (this.time.phase - 0.125));
    var offset = this.weather.tempOffset;

    for (var i = 0; i < n; i++) {
      var t = temp[i] + seasonal * amp[i] + offset;
      var w = water[i];
      if (w > 0.02) t += (w - 0.4) * 0.05;
      tempNow[i] = t < 0 ? 0 : (t > 1 ? 1 : t);
    }
  };

  World.prototype.seasonFactor = function () {
    /* Multiplier on vegetation growth: 0 = spring, 1 = summer, 2 = autumn,
     * 3 = winter. A smooth curve peaking in summer. */
    var p = this.time.phase;
    return 0.30 + 1.05 * Math.max(0, Math.sin(U.TAU * (p - 0.12))) + 0.35 * Math.exp(-Math.pow(U.mod(p - 0.0 + 0.5, 1) - 0.5, 2) * 40);
  };

  World.prototype.rollWeather = function (dt) {
    var W = this.weather;
    W.rain += (W.targetRain - W.rain) * Math.min(1, dt * 0.6);
    var p = this.time.phase;
    /* wet season bias */
    var bias = 0.20 + 0.35 * this.noise2.fbm(this.time.t * 0.02, 7.7, 2) + 0.25 * Math.max(0, Math.sin(U.TAU * (p - 0.12)));
    W.targetRain = U.clamp01(bias - 0.15);
    W.storm = U.clamp01((W.rain - 0.55) * 2.4);
    W.wind = U.clamp01(0.25 + W.rain * 0.6 + this.noise2.fbm(this.time.t * 0.05, 3.3, 2) * 0.3);
    W.windDir = this.noise2.fbm(this.time.t * 0.01, 19.1, 1) * U.TAU;
    W.cloud = U.clamp01(0.22 + W.rain * 0.75);
    W.tempOffset = (this.time.season === 3 ? -0.03 : 0.01) * (1 - this.coverage.land * 0.4);
    W.flash = Math.max(0, W.flash - dt * 4);
  };

/* Vegetation growth, snow accumulation/melt, rain moisture.

     * Biomass follows logistic growth toward a carrying capacity set by soil
     * fertility, moisture and temperature:
     *
     *     dv/dt = r * (1 - v/K)
     *
     * The logistic form matters more than it looks. A linear regrowth term lets
     * a grazed-out plain refill instantly, which silently decouples the
     * herbivore population from the resource that limits it and the whole
     * ecology goes exponential. With r fixed, the *sustainable yield* of a
     * landscape is r*K/4, which is the actual ceiling on herbivore density —
     * so overpopulation turns into starvation on its own, with no special case.
     */
  World.prototype.stepLiving = function (dt) {
    /* Every typed-array field is hoisted into a local before the loop. Reading
     * `this.veg[i]` a dozen times per cell turns each access into a property
     * lookup; hoisting is worth roughly an order of magnitude here, because
     * this is the single hottest loop in HORTUS. */
    var n = this.grid.size;
    var tempNow = this.tempNow, moist = this.moist, precip = this.precip;
    var snow = this.snow, veg = this.veg, fert = this.fert;
    var graze = this.graze, scorch = this.scorch, water = this.water, dWater = this.dWater;

    var sf = this.seasonFactor();
    var rain = this.weather.rain;
    var sun = U.clamp01(1 - this.weather.cloud * 0.75);
    var R = 0.26 * (0.55 + sun * 0.75) * (0.65 + rain * 0.5);
    var growthSeason = 0.30 + 0.70 * U.clamp01(sf);
    var moistK = Math.min(1, dt * 0.25);
    var snowK = dt * 0.30;
    var thawK = dt * 1.4;
    var decayK = Math.max(0, 1 - dt * 0.9);
    var scorchK = dt * 0.02;

    var frozen = 0, vegSum = 0, land = 0;

    for (var i = 0; i < n; i++) {
      var t = tempNow[i];

      /* snow: accumulates below freezing, melts above it */
      var sRate = t < 0.22 ? (0.22 - t) * 0.9 - (t > 0.30 ? (t - 0.30) * 1.4 : 0)
                           : -(t - 0.30) * 1.4;
      if (sRate !== 0) {
        var sv = snow[i] + sRate * snowK;
        snow[i] = sv < 0 ? 0 : (sv > 1 ? 1 : sv);
      }
      if (snow[i] > 0.1) frozen++;

      /* soil moisture drifts toward the precipitation target */
      var dw = dWater[i];
      var coastal = 1 - (dw < 10 ? dw / 10 : 1);
      var mt = precip[i] * (0.7 + rain * 0.6) + coastal * 0.22 + 0.04;
      if (mt > 1) mt = 1;
      moist[i] += (mt - moist[i]) * moistK;

      /* logistic regrowth toward carrying capacity */
      var f = fert[i];
      var v = veg[i];
      if (f > 0.001) {
        var sc = scorch[i];
        var thermal = 1 - (t > 0.55 ? (t - 0.55) * 1.7 : (0.55 - t) * 1.7);
        if (thermal < 0) thermal = 0; else if (thermal > 1) thermal = 1;
        var snowy = snow[i] * 1.3; if (snowy > 1) snowy = 1;
        var wet = moist[i] * 1.35; if (wet > 1) wet = 1; else if (wet < 0) wet = 0;
        var K = f * (0.30 + 0.70 * (1 - snowy)) * (0.35 + 0.65 * thermal)
              * (0.35 + 0.75 * wet) * (1 - sc * 1.4);
        if (K > 0.002) {
          if (K < 0) K = 0;
          /* SEED BANK. Pure logistic growth has an absorbing state at zero:
           * dv/dt = v(1 - v/K) never leaves v = 0, so a single cell that a
           * grazer strips bare is barren forever. One overgrazed patch then
           * poisons a whole region and the population starves beside an
           * untouched world. Grasslands do not work that way — they keep a
           * dormant seed bank, and this floor is the single most important
           * line in the file. */
          var floorV = K * 0.04;
          if (v < floorV) v = floorV;
          v += v * (1 - v / K) * R * growthSeason * dt;
        } else {
          v *= Math.max(0, 1 - dt * 1.4);
        }
      } else {
        v *= decayK;
      }
      veg[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
      graze[i] = 0;

      if (water[i] <= 0.02) { vegSum += veg[i]; land++; }
      if (scorch[i] > 0) {
        var ns = scorch[i] - scorchK;
        scorch[i] = ns > 0 ? ns : 0;
      }
    }
    this.frozenFraction = frozen / n;
    this.vegMean = land ? vegSum / land : 0;
    this.vegTotal = vegSum;
  };

  /* ---------------------------------------------------------------- API */

  World.prototype.cellAt = function (col, row) { return this.grid.idx(col, row); };

  World.prototype.isWater = function (i) { return this.water[i] > 0.02; };
  World.prototype.isLand = function (i) { return this.water[i] <= 0.02; };

  World.prototype.passable = function (i) {
    if (i < 0) return false;
    if (this.water[i] > 0.30) return false;
    if (this.snow[i] > 0.9 && this.tempNow[i] < 0.12) return false;
    return true;
  };

  World.prototype.heightAt = function (i) { return this.elev[i]; };

  World.prototype.cell = function (i) {
    if (i < 0 || i >= this.grid.size) return null;
    return {
      i: i,
      col: this.grid.col[i],
      row: this.grid.row[i],
      x: this.grid.col[i] + 0.5 * (this.grid.row[i] & 1),
      y: this.grid.row[i] * 0.75,
      elev: this.elev[i],
      water: this.water[i],
      depth: this.water[i],
      temp: this.tempNow[i] || this.temp[i],
      moist: this.moist[i],
      veg: this.veg[i],
      snow: this.snow[i],
      flux: this.flux[i],
      biome: this.biome[i],
      biomeKey: biomeKey(this.biome[i]),
      biomeName: biomeName(this.biome[i]),
      fert: this.fert[i],
      scorch: this.scorch[i],
      precip: this.precip[i],
      dWater: this.dWater[i],
      crowd: this.crowd[i],
      occupant: this.occ[i] < 0 ? null : this.occ[i]
    };
  };

  /* Aggregate stats, recomputed on demand (cheap enough at this scale). */
  World.prototype.stats = function () {
    var n = this.grid.size, i;
    var land = 0, water = 0, snow = 0, vegSum = 0, vegCap = 0;
    var moistSum = 0, tempSum = 0, biomass = 0, maxBiome = 0, maxBiomeN = 0;
    for (i = 0; i < n; i++) {
      if (this.water[i] > 0.02) water++; else land++;
      snow += this.snow[i];
      vegSum += this.veg[i];
      vegCap += this.fert[i];
      moistSum += this.moist[i];
      tempSum += this.tempNow[i] || this.temp[i];
      biomass += this.veg[i] * this.fert[i];
      var c = this.biome[i];
      if (this.biomeCounts && this.biomeCounts[c] > maxBiomeN) { maxBiomeN = this.biomeCounts[c]; maxBiome = c; }
    }
    return {
      cells: n, land: land, water: water,
      snow: snow / n,
      veg: vegSum / n, vegCapacity: vegCap / n,
      vegSaturation: vegCap > 0 ? vegSum / vegCap : 0,
      moist: moistSum / n, temp: tempSum / n,
      biomass: biomass,
      dominantBiome: maxBiome, dominantBiomeName: biomeName(maxBiome),
      rivers: this.riverCells
    };
  };

  World.prototype.biomeHistogram = function () {
    var hist = new Int32Array(N_BIOME), i;
    for (i = 0; i < this.grid.size; i++) hist[this.biome[i]]++;
    return hist;
  };

  World.prototype.findCells = function (pred, limit) {
    var out = [], n = this.grid.size, i;
    for (i = 0; i < n && out.length < (limit || 1000); i++) if (pred(i, this)) out.push(i);
    return out;
  };

  World.prototype.biomeByKey = function (key) {
    for (var i = 0; i < N_BIOME; i++) if (B[i].key === key) return i;
    return -1;
  };

  /* ------------------------------------------------------------- events */

  World.prototype.scorchAt = function (i, radius, strength) {
    var g = this.grid;
    g.forEachInDisc(i, Math.min(radius, 6), function (j) {
      this.scorch[j] = U.clamp01(this.scorch[j] + strength);
      this.veg[j] = Math.max(0, this.veg[j] - strength * 0.9);
    }.bind(this));
  };

  World.prototype.bloomAt = function (i, radius, strength) {
    var g = this.grid;
    g.forEachInDisc(i, Math.min(radius, 6), function (j) {
      if (this.fert[j] > 0.05) {
        this.veg[j] = U.clamp01(this.veg[j] + strength * this.fert[j]);
      }
    }.bind(this));
  };

  World.prototype.raiseAt = function (i, radius, amount) {
    var g = this.grid;
    g.forEachInDisc(i, Math.min(radius, 5), function (j) {
      if (this.water[j] <= 0.02) this.elev[j] = U.clamp01(this.elev[j] + amount * (1 - this.grid.distance(i, j) / (radius + 1)));
    }.bind(this));
    this.reclassifyAround(i, radius + 2);
  };

  World.prototype.reclassifyAround = function (i, radius) {
    var g = this.grid;
    g.forEachInDisc(i, Math.min(radius, 6), function (j) {
      var b = this.classify(j);
      if (b !== this.biome[j]) {
        this.biome[j] = b;
        this.fert[j] = B[b].fert;
        this.canopy[j] = B[b].canopy;
        if (this.biomeCounts) this.biomeCounts[b]++;
      }
    }.bind(this));
  };

  World.prototype.setSeason = function (name) {
    var s = String(name).toLowerCase();
    var idx = -1;
    for (var i = 0; i < 4; i++) if (SEASONS[i].toLowerCase().indexOf(s) === 0) idx = i;
    if (idx < 0) {
      var m = { spring: 0, summer: 1, autumn: 2, fall: 2, winter: 3 };
      if (m[s] !== undefined) idx = m[s];
    }
    if (idx < 0) return false;
    /* Rewrite the year offset rather than the whole clock: jumping straight
     * to `idx * daysPerSeason` would land exactly on a year boundary, where
     * phase wraps back to 0 and "winter" reads back as spring. */
    var year = Math.floor(this.time.t / this.daysPerYear);
    this.time.t = year * this.daysPerYear + idx * this.daysPerSeason + 1e-3;
    this.advanceTime(0);
    return true;
  };

  World.prototype.seekBiome = function (key, fromCell) {
    var target = this.biomeByKey(key);
    if (target < 0) return -1;
    var order = this.shuffledOrder || (this.shuffledOrder = null);
    if (!order) {
      order = new Int32Array(this.grid.size);
      for (var i = 0; i < order.length; i++) order[i] = i;
      this.shuffledOrder = order;
      this._orderSeed = 0;
    }
    this._orderSeed++;
    var r = new Rng(this.seedStr + ':seek:' + this._orderSeed);
    for (var k = 0; k < 40; k++) {
      var i = r.below(order.length);
      var c = order[i];
      if (this.biome[c] === target) return c;
    }
    /* fall back to an exhaustive scan */
    for (var j = 0; j < this.grid.size; j++) if (this.biome[j] === target) return j;
    return -1;
  };

  World.prototype.randomLand = function (rng, pred) {
    var g = this.grid;
    for (var tries = 0; tries < 4000; tries++) {
      var i = rng.below(g.size);
      if (this.water[i] > 0.02) continue;
      if (!pred || pred(i, this)) return i;
    }
    return -1;
  };

  /* -------------------------------------------------------------- export */

  global.HX = global.HX || {};
  global.HX.BIOMES = B;
  global.HX.SEASONS = SEASONS;
  global.HX.biomeName = biomeName;
  global.HX.biomeKey = biomeKey;
  global.HX.biomeFert = biomeFert;
  global.HX.World = World;

})(typeof window !== 'undefined' ? window : globalThis);