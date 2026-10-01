/* ============================================================================
 * HORTUS / world/ecosystem.js
 *
 * The population dynamics. Agents are metabolic creatures with genomes and a
 * small neural controller; selection acts on both.
 *
 * Design notes that matter:
 *
 *  - INSTINCT IS NOT OPTIONAL. Every agent computes a heuristic bias vector
 *    (graze uphill on the vegetation gradient, flee threats, stalk prey) and
 *    blends it with the network output according to the `discipline` gene. A
 *    neural-only agent dies of nothing within a few generations, which would
 *    make the whole apparatus a curiosity cabinet. Blending means selection
 *    still improves behaviour, but the ecology stays alive long enough to be
 *    worth watching.
 *
 *  - COMBAT IS TERRITORIAL, NOT SCRIPTED. A carnivore that steps onto a cell
 *    occupied by prey attacks it. Nothing decides "carnivores hunt"; crowding
 *    plus a mis-step does.
 *
 *  - EXTINCTION IS RECOVERABLE. Species carry a founder genome; after a grace
 *    period a remnant is re-seeded from it, mutated. This keeps the world from
 *    flat-lining in a ten-minute session.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;
  var G = global.HX.Genome;
  var Brain = global.HX.Brain;
  var Names = global.HX.Names;

  var KIND_NAMES = ['Grazer', 'Stalker', 'Omnivore'];
  var KIND_GLYPH = ['H', 'C', 'O'];

  /* ---- tunables ------------------------------------------------------- */
  var CFG = {
    maxPerSpecies: 340,
    maxTotal: 1000,
    energyCap: 100,
    starveTax: 1.05,           /* energy per day at rest, before modifiers   */
    grazeRate: 0.30,           /* vegetation removed per unit mass per day   */
    grazeYield: 9.5,           /* energy per unit vegetation                */
    killBase: 27,              /* energy from a kill, scaled by mass^0.85   */
    maturityBase: 8,
    birthCost: 34,
    breedCooldown: 5,
    maxAgeBase: 130,
    seekRing: 3,
    extinctionGraceDays: 40,
    reviveCount: 6,
    historyEvery: 6,           /* days between history samples             */
    livingStep: 0.5           /* days per vegetation/climate update       */
  };

  /* ==================================================================== */

  function Ecosystem(world, opts) {
    opts = opts || {};
    this.world = world;
    this.cfg = Object.assign({}, CFG, opts.config || {});
    this.rng = new global.HX.Rng(world.seedStr + ':eco');
    this.namer = Names.Namer(this.rng.fork('names'));
    this.emitter = world.emitter;
    this.log = [];

    this.species = [];
    this.agents = [];
    this.freeAgents = [];
    this.nextAgentId = 1;

    this.tickCount = 0;
    this.dayCount = 0;
    this.livingAcc = 0;
    this.historyAcc = 0;

    this.counts = [0, 0, 0];
    this.totalPop = 0;
    this.births = 0;
    this.deaths = 0;
    this.kills = 0;
    this.extinctions = 0;
    this.revivals = 0;
    this.maxGeneration = 0;
    this.bestEver = null;

    this.history = [];
    this.chapters = [];

    /* scratch buffers — the hot loop must not allocate */
    this._inp = new Float32Array(Brain.IN);
    this._out = new Float32Array(Brain.OUT);
    this._bias = new Float64Array(6);
    this._touch = new Int32Array(this.cfg.maxTotal + 256);
    this._touchCount = 0;
    this._lastTouchCount = 0;

    world.recomputeTemps();

    if (opts.seed !== false) this.seed(opts.speciesCount || 5, opts.population || 520);
    this.rebuildIdIndex();
  }

  /* ----------------------------------------------------------- species */

  Ecosystem.prototype.addSpecies = function (kind, founderGenome, name) {
    var id = this.species.length;
    var sp = {
      id: id,
      kind: kind,
      name: name || Names.species(this.rng),
      founder: founderGenome,
      colour: null,               /* assigned by the palette module */
      count: 0,
      generation: 0,
      extinctSince: -1,
      revivals: 0,
      peakPop: 0,
      totalBirths: 0,
      totalDeaths: 0,
      bestScore: 0,
      record: null,
      fitnessSeries: [],
      popSeries: [],
      history: []
    };
    this.species.push(sp);
    return sp;
  };

  Ecosystem.prototype.seed = function (speciesCount, population) {
    var i, k;
    /* roughly two thirds grazers, one third stalkers */
    for (i = 0; i < speciesCount; i++) {
      var kind = (i % 3 === 2 && speciesCount >= 4) ? 1 : (this.rng.chance(0.62) ? 0 : 1);
      var g = G.roleGenome(this.rng, kind);
      this.addSpecies(kind, g);
    }

    var perSpecies = Math.max(20, Math.floor(population / this.species.length));
    for (i = 0; i < this.species.length; i++) {
      var sp = this.species[i];
      var n = Math.floor(perSpecies * (sp.kind === 1 ? 0.62 : 1.0));
      for (k = 0; k < n; k++) this.spawn(sp, null, -1);
    }
    this.pushChapter('Genesis');
    this.tally();
    this.rebuildIdIndex();
    this.emit('seeded', this.species.length);
  };

  /* A genome is immutable for the whole of its owner's life, so every trait
   * derived from it is computed exactly once and cached on the agent. The hot
   * loops then read plain numbers instead of doing two string-keyed array
   * lookups and a Math.pow per trait per tick. This is also re-run whenever
   * AXIOM edits a genome in place, which is the only way the cache can stay
   * honest. */
  Ecosystem.prototype.derive = function (a) {
    var g = a.genome;
    var t = this.cfg;

    a.comfort = U.clamp01(U.lerp(0.16, 0.72, G.geneOf(g, 'heat')) + (0.5 - G.geneOf(g, 'cold')) * 0.22);
    a.maxAge = t.maxAgeBase * G.traitOf(g, 'longevity');

    /* Derive the reproductive schedule from the expressed fertility trait.
     *
     * The sign here matters more than it looks. Breeding cost and threshold
     * must both FALL as fertility rises. Get that backwards (threshold rising
     * with the fertility gene) and selection reliably drives the gene to its
     * ceiling within a few dozen generations — at which point `breedAt`
     * exceeds the energy cap and the entire population quietly stops
     * reproducing and dies of old age. It looks exactly like a broken
     * simulator. */
    var f = G.traitOf(g, 'fertility');            /* 0.45 .. 1.70 */
    var fNorm = (f - 0.45) / 1.25;                /* 0 .. 1 */
    a.maturity = 6 + (1 - fNorm) * 18;
    a.breedAt = 34 + 26 * (1 - fNorm);           /* 34 .. 60 */
    var sizeNorm = (G.traitOf(g, 'size') - 0.55) / 1.30;
    a.birthCost = 20 + 26 * sizeNorm;            /* 20 .. 46 */
    a.tFert = f;
    a.tLong = G.traitOf(g, 'longevity');         /* 0.55 .. 2.40 */

    a.tSize = G.traitOf(g, 'size');
    a.tMass = Math.pow(a.tSize, 0.75);
    a.tSpeed = G.traitOf(g, 'speed');
    a.tSense = G.traitOf(g, 'sense');
    a.tMetab = G.traitOf(g, 'metabolism');
    a.tAggr = G.geneOf(g, 'aggression');
    a.tDisc = G.geneOf(g, 'discipline');
    a.tCuri = G.geneOf(g, 'curiosity');
    a.tSocial = G.geneOf(g, 'social');
    a.tAmph = G.geneOf(g, 'amphibious');
    a.tCamo = G.geneOf(g, 'camouflage');
    a.tCold = G.geneOf(g, 'cold');
    a.tHeat = G.geneOf(g, 'heat');
    /* Effective ground speed. Body size costs agility — the classic
     * predator/prey trade-off — so a large grazer is easier to catch. */
    a.tSpeedEff = a.tSpeed * (1.40 - 0.62 * sizeNorm);
    /* Weights for blending the evolved policy with the hard-wired instinct. */
    a.wBrain = 0.45 + a.tDisc * 1.35;
    a.wInst = 1.05 - a.tDisc * 0.45;
    a.noise = (1 - a.tDisc * 0.5) * 0.26 * (0.3 + a.tCuri);
    /* Precomputed thermoregulation coefficients. */
    a.coldCoef = (1 - a.tCold * 0.85) * (1.85 - a.tMetab * 0.70);
    a.heatCoef = (1 - a.tHeat * 0.85) * (0.70 + a.tMetab * 0.50);
    /* A free trait has no equilibrium. Only metabolism and mass used to carry a
     * price, so the 0..1 traits — which all sit well below 1.0 at birth — were
     * bought for nothing, and after 800 days of selection every one of them had
     * drifted into the top decile of its range: aggression, discipline, social,
     * curiosity and camouflage all averaged above 0.85. A trait every lineage
     * agrees on is a trait carrying no information, which is the one thing a
     * selection simulation must never produce. Charging upkeep for senses that
     * never switch off, and for the extra tissue a long life and a large clutch
     * need, brings them back off the ceiling without making the world unlivable:
     * discipline and aggression each dropped by roughly half a trait unit. */
    var activity = 0.72 + a.tSpeed * 0.26 + a.tSense * 0.020 + a.tAggr * 0.14;
    var upkeep = 1 + (a.tFert - 0.45) * 0.30 + (a.tLong - 0.55) * 0.17
                   + a.tSocial * 0.12 + a.tCuri * 0.08 + a.tDisc * 0.06;
    a.costBase = t.starveTax * (0.42 + a.tMetab * 0.72) * (0.55 + a.tMass * 0.68)
               * activity * upkeep;
    return a;
  };

  /* ------------------------------------------------------------- spawning */

  /* Find a cell that suits this species. Herbivores want biomass; stalkers
   * want somewhere prey actually is. */
  Ecosystem.prototype.findSpot = function (sp, rng, nearCell) {
    var world = this.world;
    var best = -1, bestScore = -Infinity, tries;
    var wantVeg = sp.kind === 1 ? 0.16 : 0.32;

    if (nearCell >= 0) {
      var ring = world.grid.disc(nearCell, 4);
      for (tries = 0; tries < ring.length; tries++) {
        var c = ring[tries];
        if (!world.passable(c)) continue;
        var s = world.veg[c] * 2 + rng.float(0, 0.4);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (best >= 0 && bestScore > wantVeg * 0.8) return best;
    }

    for (tries = 0; tries < 2500; tries++) {
      var i = rng.below(world.grid.size);
      if (!world.passable(i)) continue;
      var score = world.veg[i] - Math.abs(world.elev[i] - 0.10) * 0.8;
      score += rng.float(0, 0.25);
      if (score > bestScore) { bestScore = score; best = i; }
      if (bestScore > 0.9) break;
    }
    if (best < 0) best = world.randomLand(rng);
    return best;
  };

  Ecosystem.prototype.spawn = function (sp, genome, generation, nearCell, parents) {
    var world = this.world;
    var rng = this.rng;
    var cell = this.findSpot(sp, rng, nearCell === undefined ? -1 : nearCell);
    if (cell < 0) return null;

    var g = genome || (function () {
      var base = sp.founder;
      var m = G.mutate(base, rng, 0.55, 0.30);
      return m;
    })();

    var a = this.freeAgents.length ? this.freeAgents.pop() : this._blankAgent();
    a.id = this.nextAgentId++;
    a.sp = sp.id;
    a.kind = sp.kind;
    a.alive = true;
    a.genome = g;
    a.brain = g.subarray(G.NG);
    a.cell = cell;
    a.prevCell = cell;
    a.energy = this.cfg.energyCap * rng.float(0.62, 0.92);
    a.age = 0;
    a.generation = generation === undefined || generation < 0 ? 0 : generation;
    a.parents = parents || null;
    a.score = 0;
    a.offspring = 0;
    a.kills = 0;
    a.meals = 0;
    a.bornDay = this.dayCount;
    a.diedDay = -1;
    a.cause = null;
    a.state = 'wander';
    a.target = -1;
    a.dir = 0;
    a.restTimer = 0;
    a.breedTimer = 0;
    a.goal = -1;
    a.distMoved = 0;
    a.comfort = 0;
    a.lastDir = 3;
    a.name = this.namer.next();
    this.derive(a);

    this.agents.push(a);
    sp.totalBirths++;
    if (a.generation > sp.generation) sp.generation = a.generation;
    if (a.generation > this.maxGeneration) this.maxGeneration = a.generation;
    this.births++;
    return a;
  };

  Ecosystem.prototype._blankAgent = function () {
    return {
      id: 0, sp: 0, kind: 0, alive: false, genome: null, brain: null,
      cell: -1, prevCell: -1, energy: 0, age: 0, generation: 0, parents: null,
      score: 0, offspring: 0, kills: 0, meals: 0, bornDay: 0, diedDay: -1,
      cause: null, state: 'wander', target: -1, dir: 0, restTimer: 0,
      breedTimer: 0, goal: -1, distMoved: 0, comfort: 0.5, lastDir: 3, name: '—',
      maxAge: 100, maturity: 10, breedAt: 50, birthCost: 30,
      tSize: 1, tMass: 1, tSpeed: 1, tSense: 1, tMetab: 1, tAggr: 0.3,
      tDisc: 0.3, tCuri: 0.5, tSocial: 0.4, tAmph: 0, tCamo: 0,
      tCold: 0.5, tHeat: 0.5, tSpeedEff: 1, wBrain: 0.9, wInst: 0.9,
      noise: 0.2, coldCoef: 1, heatCoef: 1, costBase: 1.5
    };
  };

  /* ------------------------------------------------------------- lookup */

  Ecosystem.prototype.agentById = function (id) {
    if (id < 0) return null;
    for (var i = 0; i < this.agents.length; i++) if (this.agents[i].id === id) return this.agents[i];
    return null;
  };

  /* ------------------------------------------------------------- events */

  Ecosystem.prototype.emit = function (type, data) { this.emitter.emit(type, data); };

  Ecosystem.prototype.logEvent = function (text, kind, sp) {
    var entry = {
      day: this.dayCount,
      tick: this.tickCount,
      text: text,
      kind: kind || 'info',
      t: this.dayCount,
      /* species index, where the event has one. The audio engine pitches the
       * birth bell by species so the population's mix is audible; without this
       * it had nothing to pitch by. */
      sp: sp === undefined ? -1 : sp
    };
    this.log.push(entry);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this.emit('log', entry);
    return entry;
  };

  Ecosystem.prototype.pushChapter = function (title) {
    var ch = { day: this.dayCount, title: title, id: this.chapters.length };
    this.chapters.push(ch);
    this.emit('chapter', ch);
    return ch;
  };

  /* ====================================================================
   * MAIN LOOP
   * ================================================================== */

  Ecosystem.prototype.tick = function (days) {
    days = days === undefined ? 1 : days;
    var world = this.world;

    this.tickCount++;
    this.dayCount += days;

    world.advanceTime(days);
    world.rollWeather(days);

    /* climate and vegetation are expensive (a full grid sweep) and slow, so
     * they run on a coarser clock than the agents */
    this.livingAcc += days;
    if (this.livingAcc >= this.cfg.livingStep) {
      var d = this.livingAcc;
      this.livingAcc = 0;
      world.recomputeTemps();
      world.stepLiving(d);
    }

    this.clearOccupancy();
    this.act();
    this.metabolise(days);
    this.reproduce();
    this.cull();
    this.tally();
    this.checkExtinctions();
    this.recordHistory(days);
  };

  /* ---------------------------------------------------------- occupancy */

  Ecosystem.prototype.clearOccupancy = function () {
    var world = this.world;
    var occ = world.occ, crowd = world.crowd;
    var touch = this._touch, cap = touch.length, n = 0;
    var agents = this.agents;
    /* only clear what we actually wrote last tick */
    for (var k = 0; k < this._lastTouchCount; k++) {
      var c = touch[k];
      occ[c] = -1; crowd[c] = 0;
    }
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a.alive) continue;
      var cell = a.cell;
      if (occ[cell] < 0) {
        if (n < cap) touch[n++] = cell;
      }
      occ[cell] = a.id;
      crowd[cell]++;
    }
    this._lastTouchCount = n;
    this._touchCount = n;
  };

  /* ------------------------------------------------------------ act */

Ecosystem.prototype.act = function () {
    var world = this.world;
    var grid = world.grid;
    var agents = this.agents;
    var inp = this._inp, outv = this._out, bias = this._bias;
    var veg = world.veg, water = world.water, occ = world.occ, crowd = world.crowd;
    var cfg = this.cfg;
    var nbr = grid.nbr;
    var rng = this.rng;
    var n = agents.length;

    for (var i = 0; i < n; i++) {
      var a = agents[i];
      if (!a.alive) continue;

      var sense = a.tSense;
      var discipline = a.tDisc;
      var aggression = a.tAggr;
      var social = a.tSocial;
      var amphibious = a.tAmph;
      var camouflage = a.tCamo;

      var cell = a.cell;
      var d, nb, k, j;
      var here0 = world.tempNow[cell];
      var thermal = Math.abs(here0 - a.comfort);
      var hunger = U.clamp01(1 - a.energy / cfg.energyCap);
      var shore = U.clamp01(1 - world.dWater[cell] / 9);

      /* ---------------- sensory array ----------------
       * Directional food gradients are kept as three components of the hex
       * lattice — east-west, north-south and diagonal — rather than a single
       * "how much food is around" scalar. Both the network and the instinct
       * need to know WHICH WAY, and the hex basis is the natural one to
       * express that in. */
      var vegE = 0, vegW = 0, vegNE = 0, vegNW = 0, vegSW = 0, vegSE = 0;
      var bestVeg = 0, bestVegDir = -1, bestCell = -1, vegHere = veg[cell];
      var threat = 0, prey = 0, mates = 0, crowdCount = 0;
      var waterDir = -1;
      var occHere = occ[cell];

      for (d = 0; d < 6; d++) {
        nb = nbr[cell * 6 + d];
        if (nb < 0) continue;
        var v = veg[nb];
        if (d === 0) vegE = v; else if (d === 1) vegNE = v; else if (d === 2) vegNW = v;
        else if (d === 3) vegW = v; else if (d === 4) vegSW = v; else vegSE = v;
        if (v > bestVeg) { bestVeg = v; bestVegDir = d; }
        if (water[nb] > 0.02) waterDir = d;
        var oid = occ[nb];
        if (oid > 0) {
          crowdCount++;
          var other = this._agentByIdFast(oid);
          if (other !== null) {
            if (other.sp !== a.sp) {
              if (other.kind === 1 && a.kind !== 1) threat++;
              else if (a.kind === 1 && other.kind === 0) prey++;
            } else if (other.energy > other.breedAt * 0.7) {
              mates++;
            }
          }
        }
      }
      /* wider rings at higher sense, and further still when hungry: a well-fed
         * grazer is content with local information, a starving one must be
         * willing to walk */
      var ringR = sense * 0.8 + (hunger > 0.55 ? 1 : 0);
      ringR = ringR < 1 ? 1 : (ringR > 4 ? 4 : ringR | 0);
      if (ringR > 1) {
        var slice = grid.ringSlice(cell, ringR);
        for (k = 0; k < slice.length; k++) {
          j = slice[k];
          if (j < 0 || j === cell) continue;
          var dv = veg[j];
          /* Track the winning CELL, not the direction. Converting cell to
           * direction is comparatively expensive, and recomputing it on every
           * marginal improvement made this the hottest line in the loop. */
          if (dv > bestVeg * 1.12) { bestVeg = dv; bestCell = j; }
          var oid2 = occ[j];
          if (oid2 > 0) {
            var o2 = this._agentByIdFast(oid2);
            if (o2 !== null && o2.sp !== a.sp) {
              if (o2.kind === 1 && a.kind !== 1) threat += 0.5;
              else if (a.kind === 1 && o2.kind === 0) prey += 0.5;
            }
          }
        }
        if (bestCell >= 0) bestVegDir = grid.approxDirection(cell, bestCell);
      }

      inp[0] = hunger;
      inp[1] = U.clamp01(vegHere * (a.kind === 1 ? 0.8 : 1.5));
      inp[2] = vegE - vegW;
      inp[3] = (vegNE + vegSE) - (vegNW + vegSW);
      inp[4] = (vegNE + vegNW) - (vegSE + vegSW);
      inp[5] = shore;
      inp[6] = U.clamp01(crowdCount / 4);
      inp[7] = U.clamp01(thermal * 2.6);
      inp[8] = U.clamp01(threat * (1 - camouflage * 0.45));
      inp[9] = U.clamp01(mates / 3 + (a.kind === 1 ? prey / 3 : 0));
      inp[10] = world.time.dayFrac;
      inp[11] = rng.float(0, 1);

      Brain.forward(a.brain, inp, outv);

      /* ---------------- instinct blend ----------------
       * `discipline` is the switch between a hard-wired policy and the evolved
       * one. Both weights stay positive so neither can ever be switched off
       * entirely — a population that stops using its brains entirely is not
       * an interesting outcome to be able to produce by accident. */
      var wBrain = a.wBrain;
      var wInst = a.wInst;

      for (d = 0; d < 6; d++) bias[d] = 0;

      if (a.kind !== 1) {
        /* Gradient ascent, but relative: leave a cell only when a neighbour is
         * meaningfully better. A fixed "leave if below 6% biomass" threshold
         * strands grazers on stripped ground next to untouched grass. */
        if (bestVegDir >= 0 && (vegHere < bestVeg * 0.62 || vegHere < 0.05)) {
          bias[bestVegDir] += 1.35 * U.clamp01((bestVeg - vegHere) * 3.0 + 0.25);
        }
        /* cold-blooded comfort seeking */
        if (thermal > 0.26 && waterDir >= 0) {
          bias[here0 < a.comfort ? waterDir : grid.opposite(waterDir)] += 0.85;
        }
      } else {
        /* stalkers: close on prey, avoid larger rivals */
        if (prey > 0 && a.target >= 0) {
          var td = grid.approxDirection(cell, a.target);
          if (td >= 0) bias[td] += 1.7 * aggression;
        }
        for (d = 0; d < 6; d++) {
          nb = nbr[cell * 6 + d];
          if (nb < 0) continue;
          var oid3 = occ[nb];
          var o3 = oid3 > 0 ? this._agentByIdFast(oid3) : null;
          if (o3 !== null && o3.kind === 1 && o3.sp !== a.sp && o3.energy > a.energy * 1.25) bias[d] -= 0.9;
        }
        if (a.energy < 0.5 * cfg.energyCap && bestVegDir >= 0) {
          bias[bestVegDir] += 0.5; /* scavenge */
        }
      }

      /* flocking */
      if (social > 0.3) {
        for (d = 0; d < 6; d++) {
          nb = nbr[cell * 6 + d];
          if (nb < 0) continue;
          if (crowd[nb] > 0) bias[d] += social * 0.30;
        }
      }

      /* ---------------- choose an action ----------------
       * Uniform jitter rather than Gaussian: at this amplitude the
       * distributions are indistinguishable and the uniform branch is far
       * cheaper than a Box-Muller pair per direction per agent per tick. */
      var bestScore = -Infinity, bestDir = a.lastDir;
      var noise = a.noise;
      for (d = 0; d < 6; d++) {
        var s = outv[d] * wBrain + bias[d] * wInst + (rng.float(0, 1) - 0.5) * 2 * noise;
        if (s > bestScore) { bestScore = s; bestDir = d; }
      }
      var restScore = outv[Brain.OUT_REST] * wBrain + (a.energy > 70 ? 0.45 : -0.25);
      /* a grazer standing on good biomass will happily stay and eat: grazing
         * is continuous, so "rest" here really means "feed in place" */
      if (a.kind !== 1 && vegHere > 0.20) restScore += 0.5 * U.clamp01(vegHere * 2);
      var seekScore = outv[Brain.OUT_SEEK] * wBrain +
                      (a.kind === 1 ? prey * 0.55 : mates * 0.5) +
                      (a.energy > a.breedAt ? 0.5 : -0.6);

      a.state = 'wander';
      var move = false;
      if (restScore > bestScore && restScore > 0.35 && a.energy > 60) {
        a.state = 'rest';
        a.restTimer += 1;
      } else if (seekScore > bestScore && seekScore > 0.3) {
        a.state = 'seek';
        move = true;
        if (a.goal < 0 || world.grid.distance(cell, a.goal) > cfg.seekRing) {
          a.goal = this._findGoal(a, cfg.seekRing);
        }
        if (a.goal >= 0 && a.goal !== cell) {
          var gd = grid.approxDirection(cell, a.goal);
          if (gd >= 0) bestDir = gd;
        }
      } else {
        a.state = a.kind === 1 ? 'hunt' : 'forage';
        move = true;
      }

      if (!move) {
        a.restTimer = 0;
        a.target = -1;
        continue;
      }
      a.restTimer = 0;

      /* ---------------- execute the step ---------------- */
      var effSpeed = a.tSpeedEff;
      var steps = this.rng.chance(0.55 * (effSpeed - 0.5)) ? (effSpeed > 1.0 && this.rng.chance(0.35) ? 2 : 1) : 1;

      /* MIGRATION. A grazer standing on stripped ground with nothing in the
       * next few rings will starve next to it if the world's carrying capacity
       * is not being reached locally. Without a long-range option the
       * population strips a region, starves inside it, and the boom-bust
       * cycle never recovers even when the rest of the map is lush. This is
       * the dispersal mechanism; it costs extra energy and is only available
       * to genuinely desperate animals. */
      var migrating = false;
      if (a.kind !== 1 && vegHere < 0.05 && hunger > 0.5) {
        migrating = true;
        steps = 3 + this.rng.below(4);
      } else if (a.kind === 1 && a.energy < 0.3 * cfg.energyCap) {
        migrating = true;
        steps = 3;
      }
      if (migrating) a.state = 'migrate';

      if (this.rng.chance(0.18)) {
        var alt = (bestDir + (this.rng.chance(0.5) ? 1 : 5)) % 6;
        if (bias[bestDir] < 0.5) bestDir = alt;
      }

      var cur = cell;
      for (var s = 0; s < steps; s++) {
        var target = grid.nbr[cur * 6 + bestDir];
        if (target < 0) { bestDir = grid.opposite(bestDir); target = grid.nbr[cur * 6 + bestDir]; }
        if (target < 0) break;
        var wet = world.water[target];
        if (wet > 0.05 && amphibious < wet * 1.2 && a.kind !== 1) { bestDir = grid.opposite(bestDir); break; }
        if (world.snow[target] > 0.95) break;

        /* territorial combat */
        var oid4 = world.occ[target];
        if (oid4 > 0 && oid4 !== a.id) {
          var victim = this._agentByIdFast(oid4);
          if (victim && victim.sp !== a.sp) {
            var isPredation = (a.kind === 1 && victim.kind !== 1);
            if (isPredation) {
              var sizeA = G.traitOf(a.genome, 'size');
              var sizeV = G.traitOf(victim.genome, 'size');
              var win = U.clamp01(0.74 + (sizeA - sizeV) * 0.55 + aggression * 0.18 - camouflage * 0.10);
              if (this.rng.chance(win)) {
                var lost = victim.energy;
                this.killAgent(victim, 'predation');
                this._feedOn(a, victim, lost);
                a.kills++;
                a.target = target;
                this.kills++;
              } else {
                a.energy -= this.cfg.killBase * 0.22;
                a.state = 'retreat';
              }
            } else {
              /* Same-tier encounters are mostly shoving. A fight to the death
               * between two grazers is a population sink tied to no resource,
               * and at one cell-step per agent per day it wipes out the
               * herbivores regardless of how much food there is. */
              if (this.rng.chance(0.012 + aggression * 0.085)) {
                var w2 = U.clamp01(0.42 + ((a.energy - victim.energy) / this.cfg.energyCap) * 0.9);
                if (this.rng.chance(w2)) {
                  var lost2 = victim.energy;
                  this.killAgent(victim, 'conflict');
                  a.energy = Math.min(cfg.energyCap, a.energy + lost2 * 0.18);
                  a.score += lost2 * 0.18;
                } else {
                  a.energy -= 3;
                }
              } else {
                a.energy -= 1.2;
                a.state = 'displace';
              }
            }
            break;
          }
        }
        cur = target;
      }
      if (cur !== cell) {
        a.prevCell = cell;
        a.cell = cur;
        a.distMoved += grid.distance(cell, cur);
        a.lastDir = bestDir;
      }
    }
  };

  /* Fast id lookup: agents are kept in a dense array and ids are small, so a
   * direct-index table beats scanning. Rebuilt only when the array changes
   * shape (every spawn/death), never per agent per tick. */
  Ecosystem.prototype.rebuildIdIndex = function () {
    var n = this.nextAgentId;
    var idx = this._idIndex && this._idIndex.length >= n ? this._idIndex : (this._idIndex = new Int32Array(Math.max(64, n * 2)));
    idx.fill(-1);
    for (var i = 0; i < this.agents.length; i++) {
      var a = this.agents[i];
      if (a.id < idx.length) idx[a.id] = a.alive ? i : -1;
    }
    this._idIndexDirty = false;
  };

  Ecosystem.prototype._agentByIdFast = function (id) {
    var idx = this._idIndex;
    if (!idx || id >= idx.length) return null;
    var i = idx[id];
    if (i < 0) return null;
    var a = this.agents[i];
    return (a && a.alive) ? a : null;
  };

  /* Find a goal cell for the current mode: a mate, or prey. */
  Ecosystem.prototype._findGoal = function (a, radius) {
    var world = this.world, grid = world.grid;
    var ring = grid.disc(a.cell, Math.min(radius, 4));
    var best = -1, bestScore = -Infinity;
    for (var k = 0; k < ring.length; k++) {
      var j = ring[k];
      if (j < 0 || j === a.cell) continue;
      var oid = world.occ[j];
      if (oid <= 0) continue;
      var o = this._agentByIdFast(oid);
      if (!o || o.sp === a.sp) continue;
      if (a.kind === 1) {
        if (o.kind === 1) continue;
        var s = (1 - grid.distance(a.cell, j) / 6) + o.energy / 100 * 0.4;
        if (s > bestScore) { bestScore = s; best = j; }
      } else {
        continue;
      }
    }
    if (best < 0 && a.kind !== 1) {
      /* herbivores look for their own kind */
      for (var m = 0; m < ring.length; m++) {
        var c = ring[m];
        if (c < 0 || c === a.cell) continue;
        var id2 = world.occ[c];
        if (id2 <= 0) continue;
        var o2 = this._agentByIdFast(id2);
        if (o2 && o2.sp === a.sp && o2.energy > a.breedAt * 0.75) { best = c; break; }
      }
    }
    a.target = best;
    return best;
  };

  /* --------------------------------------------------------- metabolism */

  /* Maintenance cost in energy per day.
   *
   * Basal cost scales with mass^0.75 (Kleiber's law), not linearly. This one
   * detail prevents the entire simulation from degenerating: with a linear
   * cost, a grazer's intake also grows with body size, so bigger is strictly
   * better for every purpose at once and selection marches the `size` gene to
   * its ceiling within a dozen generations. With the 3/4 exponent, intake and
   * cost scale together, and body size becomes genuinely neutral in the energy
   * budget — which means size is then free to be driven by predation risk and
   * crowding, and lands wherever the trade-offs actually put it.
   */
  Ecosystem.prototype.maintenance = function (a, crowd) {
    var world = this.world;
    var cost = a.costBase;

    /* Thermal tolerance is a BAND, not a point. There is a ~0.22-wide plateau
     * of ambient temperature that costs nothing; outside it, cost ramps up.
     * A point tolerance makes every cell in the world lethal to somebody and
     * turns the whole map into a tax the population cannot pay. */
    var dev = (world.tempNow[a.cell] || 0) - a.comfort;
    if (dev < -0.22) {
      cost *= 1 + U.clamp01(((-dev - 0.22) / 0.60) * a.coldCoef) * 1.35;
    } else if (dev > 0.22) {
      cost *= 1 + U.clamp01(((dev - 0.22) / 0.60) * a.heatCoef) * 1.35;
    }

    /* Footprint. Large creatures suffer disproportionately in a crowd, which
     * is the pressure that stops body size running away. */
    if (crowd > 1) cost *= 1 + (crowd - 1) * 0.30 * a.tMass;

    return cost;
  };

  Ecosystem.prototype.metabolise = function (days) {
    var world = this.world;
    var cfg = this.cfg;
    var crowdField = world.crowd;
    var agents = this.agents;
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a.alive) continue;
      a.energy -= this.maintenance(a, crowdField[a.cell]) * days;
      a.age += days;

      /* grazers feed continuously; stalkers only scavenge when they are
       * running low, and convert food poorly */
      var hungry = a.kind === 0 ? true : a.energy < 45;
      if (hungry) this.graze(a);

      a.breedTimer = Math.max(0, a.breedTimer - days);
    }
  };

  /* ------------------------------------------------------------- eating */

  /* Herbivores convert vegetation to energy at full efficiency; stalkers
   * digest plants poorly, which is what keeps them dependent on meat. */
  var GRAZE_EFFICIENCY = [1.0, 0.42, 0.7];

  Ecosystem.prototype._feedOn = function (a, victim, energyLost) {
    var cfg = this.cfg;
    /* Scaled by tMass (size^0.75), matching the exponent on the upkeep bill, so
     * that a bigger predator takes more from a kill but never pays less for it
     * proportionally. It used to be pow(tSize, 0.85). */
    var gain = cfg.killBase * a.tMass * U.clamp01(0.5 + energyLost / cfg.energyCap);
    a.energy = Math.min(cfg.energyCap, a.energy + gain);
    a.score += gain;
    a.meals++;
    a.lastMealDay = this.dayCount;
    return gain;
  };

  Ecosystem.prototype.graze = function (a) {
    var world = this.world, cfg = this.cfg;
    var cell = a.cell;
    var take = Math.min(world.veg[cell], cfg.grazeRate * a.tMass);
    if (take <= 0.0005) return 0;
    world.veg[cell] -= take;
    world.graze[cell] += take;
    var gain = take * cfg.grazeYield * GRAZE_EFFICIENCY[a.kind];
    a.energy = Math.min(cfg.energyCap, a.energy + gain);
    a.score += gain;
    a.meals++;
    return gain;
  };

  /* -------------------------------------------------------- reproduction */

  Ecosystem.prototype.reproduce = function () {
    var world = this.world, cfg = this.cfg;
    var grid = world.grid;
    var agents = this.agents;
    var rng = this.rng;
    var newborns = [];

    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a.alive) continue;
      if (a.age < a.maturity) continue;
      if (a.energy < a.breedAt) continue;
      if (a.breedTimer > 0) continue;
      var sp = this.species[a.sp];
      if (sp.count >= cfg.maxPerSpecies) continue;
      if (this.totalPop >= cfg.maxTotal) continue;
      if (a.energy < a.birthCost + 12) continue;

      /* Mate search scans up to 37 cells, so it is gated: only animals that
       * are both reproductively ready and energetically comfortable go
       * looking, and even then only some of them on any given tick. */
      var mate = (a.tSocial > 0.25 && rng.chance(0.30 + a.tSocial * 0.4))
        ? this._findMate(a) : null;
      var g, gen;
      if (mate) {
        g = G.crossover(a.genome, mate.genome, rng);
        g = G.mutate(g, rng, 0.13, 0.16);
        gen = Math.max(a.generation, mate.generation) + 1;
        a.energy -= a.birthCost; mate.energy -= a.birthCost * 0.6;
        mate.breedTimer = cfg.breedCooldown * 1.6;
        a.parents = [a.id, mate.id];
      } else {
        /* asexual: costlier and much noisier, which is exactly what you want
         * a founder to be able to do when no mate is reachable */
        if (!rng.chance(0.22 * (1 - G.geneOf(a.genome, 'fertility')) + 0.04)) continue;
        g = G.mutate(a.genome, rng, 0.22, 0.20);
        gen = a.generation + 1;
        a.energy -= a.birthCost * 1.25;
        a.parents = [a.id, -1];
      }
      a.breedTimer = cfg.breedCooldown;
      a.offspring++;
      a.score += 12;
      newborns.push({
        parent: a,
        genome: g,
        generation: gen,
        cell: a.cell,
        parents: [a.parents[0], a.parents[1]]
      });
    }

    for (var b = 0; b < newborns.length; b++) {
      var nb = newborns[b];
      var child = this.spawn(this.species[nb.parent.sp], nb.genome, nb.generation, nb.cell, nb.parents);
      if (child) child.age = 0;
    }
  };

  Ecosystem.prototype._findMate = function (a) {
    var world = this.world, grid = world.grid;
    var ring = grid.disc(a.cell, 3);
    for (var k = 0; k < ring.length; k++) {
      var j = ring[k];
      if (j < 0 || j === a.cell) continue;
      var oid = world.occ[j];
      if (oid <= 0 || oid === a.id) continue;
      var o = this._agentByIdFast(oid);
      if (!o || o.sp !== a.sp) continue;
      if (o.age < o.maturity || o.energy < o.breedAt * 0.7 || o.breedTimer > 0) continue;
      if (!this.rng.chance(0.22 + G.geneOf(a.genome, 'social') * 0.5)) continue;
      return o;
    }
    return null;
  };

  /* --------------------------------------------------------------- death */

  Ecosystem.prototype.killAgent = function (a, cause) {
    if (!a.alive) return;
    a.alive = false;
    a.diedDay = this.dayCount;
    a.cause = cause;
    this.deaths++;
    this.species[a.sp].totalDeaths++;
    if (this.world.occ[a.cell] === a.id) this.world.occ[a.cell] = -1;
    if (a.score > 0) this._recordIfBest(a);
    this.emit('death', a);
  };

  Ecosystem.prototype._recordIfBest = function (a) {
    var sp = this.species[a.sp];
    if (a.score <= sp.bestScore) return;
    sp.bestScore = a.score;
    sp.record = {
      name: a.name,
      score: a.score,
      generation: a.generation,
      day: this.dayCount,
      age: a.age,
      offspring: a.offspring,
      kills: a.kills,
      cause: a.cause,
      genome: a.genome.slice(0),
      epithet: Names.epithet(this.rng)
    };
    this.emit('record', sp.record);
  };

  Ecosystem.prototype.cull = function () {
    var agents = this.agents;
    var cfg = this.cfg;
    var write = 0;
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a.alive) {
        /* return the record to the pool */
        if (a.genome) { a.genome = null; a.brain = null; }
        this.freeAgents.push(a);
        continue;
      }
      if (a.energy <= 0) { this.killAgent(a, 'starvation'); this.freeAgents.push(a); a.genome = null; a.brain = null; continue; }
      if (a.age > a.maxAge) { this.killAgent(a, 'old age'); this.freeAgents.push(a); a.genome = null; a.brain = null; continue; }
      if (a.age > a.maxAge * 0.62 && this.rng.chance(0.02)) { this.killAgent(a, 'waning'); this.freeAgents.push(a); a.genome = null; a.brain = null; continue; }
      agents[write] = a;
      write++;
    }
    agents.length = write;
    this.rebuildIdIndex();
  };

  /* ---------------------------------------------------------- extinction */

  Ecosystem.prototype.checkExtinctions = function () {
    for (var i = 0; i < this.species.length; i++) {
      var sp = this.species[i];
      if (sp.count > 0) { sp.extinctSince = -1; continue; }
      if (sp.extinctSince < 0) {
        sp.extinctSince = this.dayCount;
        this.extinctions++;
        var hazard = Names.hazard(this.rng);
        this.logEvent(sp.name + ' is extinct.', 'extinct');
        this.pushChapter('Extinction ' + hazard);
        this.emit('extinct', sp);
      } else if (this.dayCount - sp.extinctSince > this.cfg.extinctionGraceDays) {
        this.revive(sp);
      }
    }
  };

  Ecosystem.prototype.revive = function (sp) {
    var n = this.cfg.reviveCount;
    sp.revivals++;
    sp.extinctSince = -1;
    this.revivals++;
    for (var k = 0; k < n; k++) {
      var g = G.mutate(sp.founder, this.rng, 0.7, 0.26);
      this.spawn(sp, g, Math.max(0, sp.generation), -1, [-1, -1]);
    }
    this.logEvent(sp.name + ' returns (' + sp.revivals + ').', 'revive');
    this.emit('revive', sp);
  };

  /* -------------------------------------------------------------- census */

  Ecosystem.prototype.tally = function () {
    var agents = this.agents;
    this.counts[0] = this.counts[1] = this.counts[2] = 0;
    var total = 0;
    for (var i = 0; i < this.species.length; i++) this.species[i].count = 0;
    for (var a = 0; a < agents.length; a++) {
      var ag = agents[a];
      if (!ag.alive) continue;
      this.species[ag.sp].count++;
      this.counts[ag.kind]++;
      total++;
    }
    this.totalPop = total;
    for (var s = 0; s < this.species.length; s++) {
      var sp = this.species[s];
      if (sp.count > sp.peakPop) sp.peakPop = sp.count;
    }
  };

  /* ------------------------------------------------------------- history */

  Ecosystem.prototype.recordHistory = function (days) {
    this.historyAcc += days;
    if (this.historyAcc < this.cfg.historyEvery) return;
    this.historyAcc = 0;

    var agents = this.agents;
    var energy = 0, count = 0, bestGen = 0, scoreSum = 0;
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a.alive) continue;
      energy += a.energy; count++; scoreSum += a.score;
      if (a.generation > bestGen) bestGen = a.generation;
    }
    var world = this.world;
    /* one sweep gives the biomass and temperature series for the graphs */
    var vegSum = 0, tempSum = 0, land = 0, n = world.grid.size;
    for (var w2 = 0; w2 < n; w2++) {
      if (world.water[w2] > 0.02) continue;
      vegSum += world.veg[w2];
      tempSum += world.tempNow[w2];
      land++;
    }
    world.vegMean = land ? vegSum / land : 0;
    world.tempMean = land ? tempSum / land : 0;
    world.vegTotal = vegSum;
    var sample = {
      day: this.dayCount,
      tick: this.tickCount,
      season: world.time.season,
      seasonName: world.time.seasonName,
      year: world.time.year,
      pop: this.totalPop,
      grazers: this.counts[0],
      stalkers: this.counts[1],
      energy: count ? energy / count : 0,
      score: count ? scoreSum / count : 0,
      generation: bestGen,
      biomass: vegSum,
      veg: world.vegMean,
      temp: world.tempMean,
      rain: world.weather.rain,
      species: this.species.map(function (s) { return s.count; })
    };
    this.history.push(sample);
    if (this.history.length > 4000) this.history.splice(0, 1000);

    for (var s = 0; s < this.species.length; s++) {
      var sp = this.species[s];
      sp.popSeries.push(sp.count);
      if (sp.popSeries.length > 4000) sp.popSeries.splice(0, 1000);
      var eAvg = 0, c2 = 0;
      for (var j = 0; j < agents.length; j++) {
        if (agents[j].alive && agents[j].sp === s) { eAvg += agents[j].energy; c2++; }
      }
      var fit = c2 ? eAvg / c2 : 0;
      sp.fitnessSeries.push(fit);
      if (sp.fitnessSeries.length > 4000) sp.fitnessSeries.splice(0, 1000);
    }

    if (this.bestEver === null || sample.score > this.bestEver.score) {
      this.bestEver = { score: sample.score, day: this.dayCount, generation: bestGen };
    }
    this.emit('history', sample);
  };

  /* --------------------------------------------------------------- stats */

  Ecosystem.prototype.snapshot = function () {
    var agents = this.agents;
    var byKind = { 0: 0, 1: 0, 2: 0 };
    var energyByKind = { 0: 0, 1: 0, 2: 0 };
    var genByKind = { 0: 0, 1: 0, 2: 0 };
    var i, a;
    for (i = 0; i < agents.length; i++) {
      a = agents[i];
      if (!a.alive) continue;
      byKind[a.kind]++;
      energyByKind[a.kind] += a.energy;
      if (a.generation > genByKind[a.kind]) genByKind[a.kind] = a.generation;
    }
    var st = this.world.stats();
    return {
      pop: this.totalPop,
      byKind: byKind,
      energy: energyByKind,
      generation: genByKind,
      meanEnergy: {
        0: byKind[0] ? energyByKind[0] / byKind[0] : 0,
        1: byKind[1] ? energyByKind[1] / byKind[1] : 0,
        2: byKind[2] ? energyByKind[2] / byKind[2] : 0
      },
      births: this.births,
      deaths: this.deaths,
      kills: this.kills,
      extinctions: this.extinctions,
      revivals: this.revivals,
      maxGeneration: this.maxGeneration,
      world: st
    };
  };

  /* Locate the agent nearest to a pixel position — used by the inspector. */
  Ecosystem.prototype.pick = function (col, row) {
    var world = this.world;
    var i = world.grid.idx(col, row);
    if (i < 0) return null;
    var id = world.occ[i];
    if (id > 0) {
      var a = this._agentByIdFast(id);
      if (a) return a;
    }
    /* widen the search a ring or two */
    var ring = world.grid.disc(i, 3);
    var best = null, bestD = Infinity;
    for (var k = 0; k < ring.length; k++) {
      var j = ring[k];
      if (j < 0) continue;
      var oid = world.occ[j];
      if (oid <= 0) continue;
      var o = this._agentByIdFast(oid);
      if (!o) continue;
      var d = world.grid.distance(i, j);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  };

  Ecosystem.KIND_NAMES = KIND_NAMES;
  Ecosystem.KIND_GLYPH = KIND_GLYPH;
  Ecosystem.CFG = CFG;

  global.HX = global.HX || {};
  global.HX.Ecosystem = Ecosystem;
  global.HX.KIND_NAMES = KIND_NAMES;

})(typeof window !== 'undefined' ? window : globalThis);
