/* ============================================================================
 * HORTUS / lang/stdlib.js
 *
 * The simulation-facing half of AXIOM. Everything here reaches into the live
 * world and the ecosystem, so these are the functions that let you do things
 * rather than merely look at things.
 *
 * Naming:
 *   (verb)      observe      (getter)
 *   (verb!)     change       (mutator, returns the new value)
 *   (scan fn)   fold over a collection, always with a hard cap so that a
 *               mistaken scan cannot lock the frame
 *
 * The host is injected rather than imported so the language stays testable in
 * Node and swappable at runtime.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var R = global.HX.Reader;
  var U = global.HX.U;
  var mk = global.HX.makeBuiltin;
  var num = global.HX.toNumber;
  var G = global.HX.Genome;
  var Brain = global.HX.Brain;

  var SCAN_CAP = 200000;

  function err(msg) { throw new R.AxiomError(msg); }

  function install(I, host) {
    var env = I.global;
    /* The interpreter resolves `cell.field` against the live world through
     * this reference. */
    I.host = host;

    function def(name, fn) {
      env.define(name, mk(name, fn));
      return fn;
    }

    /* --------------------------------------------------------------- time */
    function world() { return host.world; }
    function eco() { return host.eco; }

    def('day', function () { return world().time.day; });
    def('year', function () { return world().time.year; });
    def('season', function () { return world().time.season; });
    def('season-name', function () { return world().time.seasonName; });
    def('day-fraction', function () { return world().time.dayFrac; });
    def('seed-string', function () { return world().seedStr; });
    def('world-w', function () { return world().w; });
    def('world-h', function () { return world().h; });
    def('cell-count', function () { return world().grid.size; });

    def('advance!', function (days) {
      var d = days === undefined ? 1 : num(days, 'advance!');
      var max = 20000;
      if (d > max) err('advance!: refusing to skip ' + d + ' days in one call (max ' + max + ')');
      if (d < 0) err('advance!: time only moves forward');
      for (var i = 0; i < d; i++) eco().tick(1);
      return world().time.day;
    });
    def('tick', function (n) { return I.apply(env.get('advance!'), [n === undefined ? 1 : n]); });

    def('set-season!', function (name) {
      var ok = world().setSeason(String(name));
      if (!ok) err('set-season!: unknown season "' + name + '" (try spring, summer, autumn, winter)');
      return world().time.seasonName;
    });
    def('set-weather!', function (k, v) {
      var W = world().weather;
      if (k === 'rain') W.targetRain = U.clamp01(num(v));
      else if (k === 'storm') W.storm = U.clamp01(num(v));
      else if (k === 'wind') W.wind = U.clamp01(num(v));
      else if (k === 'cloud') W.cloud = U.clamp01(num(v));
      else if (k === 'temperature') W.tempOffset = num(v);
      else err('set-weather!: unknown channel "' + k + '"');
      if (k === 'rain') W.rain = U.clamp01(num(v));
      return v;
    });
    def('weather', function (k) {
      var W = world().weather;
      if (k === undefined || k === null) {
        return { rain: W.rain, storm: W.storm, wind: W.wind, cloud: W.cloud, tempOffset: W.tempOffset };
      }
      return W[String(k)];
    });
    def('climate', function () {
      var w = world(), s = w.stats();
      var meanPrecip = 0, land = 0;
      for (var i = 0; i < w.grid.size; i += 7) {
        if (w.water[i] > 0.02) continue;
        meanPrecip += w.precip[i]; land++;
      }
      return {
        meanTemp: s.temp, meanMoisture: s.moist,
        meanPrecip: land ? meanPrecip / land : 0,
        frozen: w.frozenFraction || 0, snow: s.snow,
        growth: w.seasonFactor(), rain: w.weather.rain,
        wind: w.weather.wind, storm: w.weather.storm
      };
    });

    /* -------------------------------------------------------------- cells */
    function cellIndex(x, y) {
      var w = world();
      var col = num(x, 'x'), row = num(y, 'y');
      var i = w.grid.idx(Math.round(col), Math.round(row));
      return i;
    }
    def('in-bounds?', function (x, y) { return cellIndex(x, y) >= 0; });

    function cellRef(i) {
      if (i === null || i === undefined) return null;
      if (i < 0 || i >= world().grid.size) return null;
      var w = world();
      var ref = w.cell(i);
      ref.isCell = true;
      ref.index = i;
      return ref;
    }
    def('cell', function (x, y) {
      var i = cellIndex(x, y);
      if (i < 0) return null;
      return cellRef(i);
    });
    def('cell-at', function (i) { return cellRef(Math.round(num(i, 'cell-at'))); });
    def('cell-index', function (x, y) { return cellIndex(x, y); });

    var FIELD = {
      elev: 'elev', height: 'elev', water: 'water', depth: 'water', temp: 'tempNow',
      temperature: 'tempNow', 'mean-temp': 'temp', moist: 'moist', moisture: 'moist',
      veg: 'veg', vegetation: 'veg', biomass: 'veg', snow: 'snow', flux: 'flux',
      fert: 'fert', fertility: 'fert', scorch: 'scorch', precip: 'precip',
      'distance-to-water': 'dWater', crowd: 'crowd', canopy: 'canopy'
    };
    var MUT_FIELD = {
      veg: 'veg', vegetation: 'veg', biomass: 'veg', 'veg-target': 'vegTarget',
      snow: 'snow', scorch: 'scorch', moist: 'moist', moisture: 'moist',
      fert: 'fert', flux: 'flux', elev: 'elev'
    };

    def('field', function (cellOrIndex, name) {
      var key = String(name);
      /* A record or a dict: (field (stats) "vegetation"). Making `field` the
         universal record accessor means every function that returns a struct
         is inspectable without a second accessor per type. */
      if (cellOrIndex && typeof cellOrIndex === 'object' && !cellOrIndex.isCell && !cellOrIndex.isAgent) {
        var src = cellOrIndex.dict || cellOrIndex;
        var v = src[key];
        return v === undefined ? null : v;
      }
      var i = resolveCell(cellOrIndex);
      if (i < 0) return null;
      var w = world();
      switch (key) {
        case 'col': return w.grid.col[i];
        case 'row': return w.grid.row[i];
        case 'x': return w.grid.px[i];
        case 'y': return w.grid.py[i];
        case 'index': return i;
        case 'biome': return w.biome[i];
        case 'biome-name': return global.HX.biomeName(w.biome[i]);
        case 'biome-key': return global.HX.biomeKey(w.biome[i]);
        case 'temp': case 'temperature': return w.tempNow[i] || w.temp[i];
        case 'occupant': return w.occ[i] < 0 ? null : w.occ[i];
      }
      var f = FIELD[key];
      if (!f) err('field: unknown field "' + name + '"\n  known: ' +
        Object.keys(FIELD).concat(['col', 'row', 'x', 'y', 'index', 'biome', 'biome-name']).join(', '));
      return w[f][i];
    });
    def('set-field!', function (cellOrIndex, name, v) {
      var i = resolveCell(cellOrIndex);
      if (i < 0) return null;
      var f = MUT_FIELD[String(name)];
      if (!f) err('set-field!: field "' + name + '" is not writable\n  writable: ' + Object.keys(MUT_FIELD).join(', '));
      world()[f][i] = U.clamp01(num(v, 'value'));
      return world()[f][i];
    });
    function resolveCell(c) {
      if (c === null || c === undefined) return -1;
      if (typeof c === 'number') return Math.round(c);
      if (c.isCell) return c.index;
      if (c.isAgent) return c.ref ? c.ref.cell : -1;
      return -1;
    }

    def('biome', function (cellOrIndex) {
      var i = resolveCell(cellOrIndex);
      return i < 0 ? null : world().biome[i];
    });
    def('biome-name', function (b) {
      var id = typeof b === 'number' ? b : world().biome[resolveCell(b)];
      return global.HX.biomeName(id);
    });
    def('biome-key', function (b) {
      var id = typeof b === 'number' ? b : world().biome[resolveCell(b)];
      return global.HX.biomeKey(id);
    });
    def('biome-list', function () {
      return global.HX.BIOMES.map(function (b) {
        return { name: b.name, key: b.key, fertility: b.fert };
      });
    });
    def('biome-id', function (name) {
      var id = world().biomeByKey(String(name));
      return id < 0 ? null : id;
    });
    def('biome-histogram', function () {
      var h = world().biomeHistogram(), out = [];
      for (var i = 0; i < h.length; i++) out.push(h[i]);
      out.isList = true;
      return out;
    });
    def('dominant-biome', function () { return global.HX.biomeName(world().stats().dominantBiome); });

    def('neighbors', function (cellOrIndex) {
      var i = resolveCell(cellOrIndex);
      if (i < 0) return null;
      var g = world().grid, out = [];
      for (var d = 0; d < 6; d++) out.push(g.nbr[i * 6 + d]);
      out.isList = true;
      return out;
    });
    def('neighbors-of', function (cellOrIndex) {
      var i = resolveCell(cellOrIndex);
      if (i < 0) return null;
      var g = world().grid, out = [];
      for (var d = 0; d < 6; d++) { var j = g.nbr[i * 6 + d]; if (j >= 0) out.push(cellRef(j)); }
      out.isList = true;
      return out;
    });
    def('hex-distance', function (a, b) {
      var ia = resolveCell(a), ib = resolveCell(b);
      if (ia < 0 || ib < 0) return null;
      return world().grid.distance(ia, ib);
    });
    def('around', function (cellOrIndex, radius) {
      var i = resolveCell(cellOrIndex);
      if (i < 0) return null;
      var r = Math.max(0, Math.min(6, Math.round(num(radius === undefined ? 1 : radius))));
      var out = [];
      world().grid.forEachInDisc(i, r, function (j) { out.push(cellRef(j)); });
      out.isList = true;
      if (out.length > SCAN_CAP) err('around: radius too large');
      return out;
    });
    def('around-sum', function (cellOrIndex, name, radius) {
      var i = resolveCell(cellOrIndex);
      var f = FIELD[String(name)];
      if (i < 0 || !f) return 0;
      var w = world(), g = w.grid, s = 0, n = 0;
      var r = Math.max(0, Math.min(6, Math.round(num(radius === undefined ? 1 : radius))));
      g.forEachInDisc(i, r, function (j) { s += w[f][j]; n++; });
      return n ? s / n : 0;
    });

    /* -------------------------------------------------------------- scans */
    def('scan-cells', function (fn) {
      var w = world(), n = w.grid.size, out = [];
      for (var i = 0; i < n && i < SCAN_CAP; i++) {
        var v = I.apply(fn, [cellRef(i), i]);
        if (global.HX.truthy(v)) out.push(cellRef(i));
      }
      out.isList = true;
      return out;
    });
    def('scan-cells-count', function (fn) {
      var w = world(), n = w.grid.size, c = 0;
      for (var i = 0; i < n && i < SCAN_CAP; i++) if (global.HX.truthy(I.apply(fn, [cellRef(i), i]))) c++;
      return c;
    });
    def('fold-cells', function (fn, init) {
      var w = world(), n = w.grid.size, acc = init;
      for (var i = 0; i < n && i < SCAN_CAP; i++) acc = I.apply(fn, [acc, cellRef(i), i]);
      return acc;
    });
    def('random-cell', function (pred) {
      var w = world(), rng = eco().rng;
      for (var t = 0; t < 5000; t++) {
        var i = rng.below(w.grid.size);
        var ref = cellRef(i);
        if (!pred || global.HX.truthy(I.apply(pred, [ref, i]))) return ref;
      }
      return null;
    });

    /* ------------------------------------------------------------- events */
    def('bloom!', function (cellOrIndex, radius, strength) {
      var i = resolveCell(cellOrIndex);
      if (i < 0) return 0;
      world().bloomAt(i, Math.round(num(radius === undefined ? 2 : radius)),
        U.clamp01(strength === undefined ? 0.5 : num(strength)));
      eco().emit('event', { type: 'bloom', cell: i });
      return 1;
    });
    def('scorch!', function (cellOrIndex, radius, strength) {
      var i = resolveCell(cellOrIndex);
      if (i < 0) return 0;
      world().scorchAt(i, Math.round(num(radius === undefined ? 2 : radius)),
        U.clamp01(strength === undefined ? 0.6 : num(strength)));
      eco().emit('event', { type: 'scorch', cell: i });
      return 1;
    });
    def('quake!', function (cellOrIndex, radius, amount) {
      var i = resolveCell(cellOrIndex);
      if (i < 0) return 0;
      world().raiseAt(i, Math.round(num(radius === undefined ? 3 : radius)),
        num(amount === undefined ? 0.12 : amount));
      eco().emit('event', { type: 'quake', cell: i });
      return 1;
    });
    def('flood!', function (cellOrIndex, radius) {
      var i = resolveCell(cellOrIndex);
      if (i < 0) return 0;
      var w = world();
      w.grid.forEachInDisc(i, Math.min(5, Math.round(num(radius === undefined ? 2 : radius))), function (j) {
        if (w.elev[j] < 0.35) { w.elev[j] = 0.30; w.water[j] = 0.25; }
      });
      w.reclassifyAround(i, Math.min(6, Math.round(num(radius === undefined ? 2 : radius)) + 2));
      return 1;
    });
    def('scattered-events', function () {
      var w = world(), e = eco(), out = [];
      for (var i = 0; i < w.grid.size; i++) if (w.scorch[i] > 0.1) out.push(cellRef(i));
      if (out.length > 4000) { out.length = 4000; out.isList = true; }
      out.isList = true;
      return out;
    });

    /* ------------------------------------------------------------ species */
    /* `founder` is exposed directly: divergence from the founder genome is the
       single most interesting number about a lineage, and making people write
       `sp.species.founder` to reach it would just be an obstacle. */
    function speciesRef(sp) {
      return {
        name: sp.name, kind: sp.kind, id: sp.id, count: sp.count,
        generation: sp.generation, revivals: sp.revivals, peak: sp.peakPop,
        founder: { genome: sp.founder.slice(0), isRawGenome: true },
        species: sp
      };
    }

    def('species', function () {
      var out = eco().species.map(speciesRef);
      out.isList = true;
      return out;
    });
    def('species-count', function () { return eco().species.length; });
    def('species-name', function (i) {
      var sp = eco().species[Math.round(num(i, 'species-name'))];
      return sp ? sp.name : null;
    });
    def('add-species!', function (kind, name) {
      var k = num(kind, 'kind');
      if (k !== 0 && k !== 1 && k !== 2) err('add-species!: kind must be 0 (grazer), 1 (stalker) or 2 (omnivore)');
      var g = G.roleGenome(eco().rng, k);
      var sp = eco().addSpecies(k, g, name === undefined || name === null ? undefined : String(name));
      eco().logEvent('A new lineage takes root: ' + sp.name + '.', 'birth', sp.id);
      return speciesRef(sp);
    });
    def('kind-name', function (k) { return global.HX.KIND_NAMES[Math.round(num(k, 'kind'))] || '?'; });

    /* ------------------------------------------------------------- agents */
    function agentRef(a) {
      if (!a) return null;
      var ref = { isAgent: true, ref: a, id: a.id, name: a.name };
      return ref;
    }
    def('agents', function (speciesId, kind) {
      var e = eco(), out = [];
      var wantSp = speciesId === undefined || speciesId === null ? -1 : Math.round(num(speciesId));
      var wantKind = kind === undefined || kind === null ? -1 : Math.round(num(kind));
      for (var i = 0; i < e.agents.length; i++) {
        var a = e.agents[i];
        if (!a.alive) continue;
        if (wantSp >= 0 && a.sp !== wantSp) continue;
        if (wantKind >= 0 && a.kind !== wantKind) continue;
        out.push(agentRef(a));
        if (out.length >= 20000) break;
      }
      out.isList = true;
      return out;
    });
    def('agent-count', function (speciesId, kind) {
      var n = I.apply(env.get('agents'), [speciesId, kind]);
      return Array.isArray(n) ? n.length : 0;
    });
    def('population', function () { return eco().totalPop; });
    def('population-by-kind', function () {
      var c = eco().counts;
      return { grazers: c[0], stalkers: c[1], omnivores: c[2] };
    });
    def('agent-at', function (x, y) {
      return agentRef(eco().pick(Math.round(num(x, 'x')), Math.round(num(y, 'y'))));
    });

    var AGENT_FIELD = {
      energy: 'energy', age: 'age', generation: 'generation', score: 'score',
      offspring: 'offspring', kills: 'kills', meals: 'meals', kind: 'kind',
      species: 'sp', state: 'state', name: 'name', comfort: 'comfort',
      'breed-at': 'breedAt', 'birth-cost': 'birthCost', maturity: 'maturity',
      'max-age': 'maxAge', x: null, y: null, col: null, row: null, cell: 'cell'
    };
    var AGENT_SETTABLE = {
      energy: 'energy', age: 'age', comfort: 'comfort', breedTimer: 'breedTimer'
    };

    def('agent-field', function (agent, name) {
      var a = agent && agent.ref;
      if (!a) return null;
      var key = String(name);
      var f = AGENT_FIELD[key];
      if (f === null) {
        var w = world();
        if (key === 'x') return w.grid.px[a.cell];
        if (key === 'y') return w.grid.py[a.cell];
        if (key === 'col') return w.grid.col[a.cell];
        if (key === 'row') return w.grid.row[a.cell];
      }
      if (!f) err('agent-field: unknown field "' + name + '"\n  known: ' + Object.keys(AGENT_FIELD).join(', '));
      var v = a[f];
      return (typeof v === 'number') ? v : String(v);
    });
    def('set-agent!', function (agent, name, v) {
      var a = agent && agent.ref;
      if (!a) return null;
      var f = AGENT_SETTABLE[String(name)];
      if (!f) err('set-agent!: "' + name + '" is not writable\n  writable: ' + Object.keys(AGENT_SETTABLE).join(', '));
      a[f] = num(v, 'value');
      return a[f];
    });

    def('spawn!', function (cellOrIndex, speciesId, kind) {
      var e = eco();
      var sp;
      if (speciesId !== undefined && speciesId !== null) {
        sp = e.species[Math.round(num(speciesId, 'speciesId'))];
        if (!sp) err('spawn!: no species with id ' + speciesId);
      } else {
        var k = kind === undefined || kind === null ? 0 : Math.round(num(kind, 'kind'));
        sp = e.species.filter(function (s) { return s.kind === k; })[0];
        if (!sp) { sp = e.addSpecies(k, G.roleGenome(e.rng, k)); }
      }
      var g = G.roleGenome(e.rng, sp.kind);
      var near = resolveCell(cellOrIndex);
      var a = e.spawn(sp, g, sp.generation, near, [-1, -1]);
      return agentRef(a);
    });
    def('kill!', function (agent) {
      var a = agent && agent.ref;
      if (!a) return false;
      if (!a.alive) return false;
      eco().killAgent(a, 'harness');
      return true;
    });
    def('heal!', function (agent, amount) {
      var a = agent && agent.ref;
      if (!a) return null;
      a.energy = Math.min(eco().cfg.energyCap, a.energy + num(amount === undefined ? 50 : amount));
      return a.energy;
    });
    def('move!', function (agent, cellOrIndex) {
      var a = agent && agent.ref;
      var i = resolveCell(cellOrIndex);
      if (!a || i < 0) return false;
      a.cell = i;
      return true;
    });

    /* ------------------------------------------------------------ genomes */
    /* A killed agent's genome is released back to the pool, so a program holding a
       stale reference must get nil rather than an exception. Silently
       pretending the trait is 0.5 would be worse than nil — it would let a
       selection policy quietly select on garbage. */
    function liveGenome(agent) {
      var a = agent && agent.ref;
      return (a && a.alive && a.genome) ? a.genome : null;
    }

    def('genome', function (agent) {
      var g = liveGenome(agent);
      return g ? { genome: g.slice(0), isRawGenome: true, owner: agentRef(agent.ref) } : null;
    });
    def('genome-list', function (g) {
      if (!g) return null;
      var src = g.genome || g;
      var out = [];
      for (var i = 0; i < src.length; i++) out.push(Math.round(src[i] * 1000) / 1000);
      out.isList = true;
      return out;
    });
    /* Any write to a genome must invalidate the cached trait block, or the
     * simulation would keep running on the values the animal was born with
     * while the inspector shows the new ones. */
    function reseat(a) {
      a.brain = a.genome.subarray(G.NG);
      eco().derive(a);
      return a;
    }

    def('set-genome!', function (agent, g) {
      var a = agent && agent.ref;
      if (!a || !g) return false;
      a.genome = G.deserialize(g.genome || g);
      reseat(a);
      return true;
    });
    def('genome-length', function () { return G.totalLen(); });
    def('trait-names', function () {
      var out = G.TRAITS.map(function (t) { return t.name; });
      out.isList = true;
      return out;
    });
    def('trait', function (agent, name) {
      var g = liveGenome(agent);
      if (!g) return null;
      var idx = G.GENE_INDEX[String(name)];
      if (idx === undefined) err('trait: unknown trait "' + name + '"\n  known: ' + G.TRAITS.map(function (t) { return t.name; }).join(', '));
      return G.traitOf(g, name);
    });
    def('gene', function (agent, name) {
      var g = liveGenome(agent);
      if (!g) return null;
      return G.geneOf(g, String(name));
    });
    def('set-trait!', function (agent, name, v) {
      var a = (agent && agent.ref && agent.ref.alive) ? agent.ref : null;
      if (!a) return null;
      var idx = G.GENE_INDEX[String(name)];
      if (idx === undefined) err('set-trait!: unknown trait "' + name + '"');
      a.genome[idx] = U.clamp01(num(v, 'value'));
      reseat(a);
      return G.traitOf(a.genome, name);
    });
    def('mutate!', function (agent, rate, strength) {
      var a = agent && agent.ref;
      if (!a) return false;
      a.genome = G.mutate(a.genome, eco().rng, rate === undefined ? 0.15 : num(rate), strength === undefined ? 0.2 : num(strength));
      reseat(a);
      return true;
    });
    def('crossover-genome', function (agentA, agentB) {
      var a = agentA && agentA.ref, b = agentB && agentB.ref;
      if (!a || !b) return null;
      var g = G.crossover(a.genome, b.genome, eco().rng);
      return { genome: g, isRawGenome: true };
    });
    def('mutate-genome', function (g, rate, strength) {
      if (!g) return null;
      return { genome: G.mutate(g.genome || g, eco().rng, rate === undefined ? 0.15 : num(rate), strength === undefined ? 0.2 : num(strength)), isRawGenome: true };
    });
    def('make-genome', function (kind) {
      return { genome: G.roleGenome(eco().rng, kind === undefined || kind === null ? 0 : num(kind)), isRawGenome: true };
    });
    def('random-genome', function () {
      return { genome: G.randomGenome(eco().rng), isRawGenome: true };
    });
    def('genome-distance', function (g1, g2) {
      if (!g1 || !g2) return null;
      return G.distance(g1.genome || g1, g2.genome || g2);
    });
    def('genome-hash', function (g) {
      if (!g) return null;
      return G.hash(g.genome || g);
    });
    def('weights', function (agent) {
      var g = liveGenome(agent);
      return g ? Brain.describeWeights(g.subarray(G.NG)) : null;
    });
    def('describe-genome', function (agent) {
      var g = liveGenome(agent);
      return g ? G.describe(g) : null;
    });

    /* ------------------------------------------------------- introspection */
    def('history', function (limit) {
      var h = eco().history, out = [];
      var start = limit ? Math.max(0, h.length - num(limit)) : 0;
      for (var i = start; i < h.length; i++) out.push(h[i]);
      out.isList = true;
      return out;
    });
    def('history-length', function () { return eco().history.length; });
    def('best', function (speciesId) {
      var e = eco();
      var bestRec = null;
      for (var i = 0; i < e.species.length; i++) {
        if (speciesId !== undefined && speciesId !== null && e.species[i].id !== num(speciesId)) continue;
        if (e.species[i].record && (!bestRec || e.species[i].record.score > bestRec.score)) bestRec = e.species[i].record;
      }
      if (!bestRec) return null;
      return {
        name: bestRec.name, epithet: bestRec.epithet, score: bestRec.score,
        generation: bestRec.generation, day: bestRec.day, offspring: bestRec.offspring,
        kills: bestRec.kills, cause: bestRec.cause, genome: { genome: bestRec.genome, isRawGenome: true }
      };
    });
    def('record', function (speciesId) {
      var sp = eco().species[speciesId === undefined || speciesId === null ? 0 : Math.round(num(speciesId))];
      return sp && sp.record ? { name: sp.record.name, score: sp.record.score, generation: sp.record.generation } : null;
    });
    def('chapters', function () {
      var out = eco().chapters.map(function (c) { return { day: c.day, title: c.title }; });
      out.isList = true;
      return out;
    });
    def('event-log', function (limit) {
      var l = eco().log, out = [];
      var start = limit ? Math.max(0, l.length - num(limit)) : 0;
      for (var i = start; i < l.length; i++) out.push(l[i]);
      out.isList = true;
      return out;
    });
    def('say!', function (msg) {
      eco().logEvent(I.toString(msg), 'program');
      return msg;
    });
    def('stats', function () {
      var s = eco().snapshot();
      return {
        population: s.pop, grazers: s.byKind[0], stalkers: s.byKind[1],
        births: s.births, deaths: s.deaths, kills: s.kills,
        extinctions: s.extinctions, revivals: s.revivals,
        generation: s.maxGeneration,
        meanEnergy: s.meanEnergy[0], meanStalkerEnergy: s.meanEnergy[1],
        vegetation: s.world.veg, vegetationSaturation: s.world.vegSaturation,
        biomass: s.world.biomass, landFraction: s.world.land / s.world.cells,
        dominantBiome: s.world.dominantBiomeName, rivers: s.world.rivers
      };
    });
    def('generation', function () { return eco().maxGeneration; });

    /* ------------------------------------------------------------ rendering */
    def('focus', function (x, y, zoom) {
      if (host.focus) host.focus(num(x), num(y), zoom === undefined ? null : num(zoom));
      return true;
    });
    def('highlight', function (agent) {
      if (host.highlight) host.highlight(agent && agent.ref ? agent.ref : null);
      return true;
    });
    def('color-by', function (mode) {
      if (host.setChannel) host.setChannel(String(mode));
      return mode;
    });

    /* -------------------------------------------------------------- repl aid */
    def('reset-world!', function (seedStr) {
      if (host.reset) host.reset(seedStr === undefined || seedStr === null ? null : String(seedStr));
      return world().seedStr;
    });
    def('host-info', function () {
      return {
        seed: world().seedStr, width: world().w, height: world().h,
        species: eco().species.length, population: eco().totalPop,
        daysPerYear: world().daysPerYear, cellCount: world().grid.size
      };
    });

    return env;
  }

  global.HX = global.HX || {};
  global.HX.stdlib = { install: install };

})(typeof window !== 'undefined' ? window : globalThis);