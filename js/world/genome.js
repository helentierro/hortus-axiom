/* ============================================================================
 * HORTUS / world/genome.js
 *
 * The heritable substrate of an agent. A genome is a flat Float32Array:
 *
 *   [ 0 .. NG-1 ]        body genes   (speed, sense, metabolism, ...)
 *   [ NG .. NG+NW-1 ]    brain weights, stored contiguously
 *
 * A flat array (rather than an object) means crossover is a slice and a
 * concat, mutation is a loop over a typed array, and serialising an agent is
 * `Array.from(genome)` — no framework, no allocation churn in the hot loop.
 *
 * Every gene is normalised to [0,1] on the wire and mapped to a real range at
 * read time. That keeps mutations scale-free: a 5% mutation always means 5%
 * of the trait's range, never 5% of an arbitrary unit.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;

  /* ---------------------------------------------------------------- traits
   * `lo`/`hi` bound the expressed value; `neutral` is a sensible starting point
   * that also biases freshly randomised genomes toward viable phenotypes.
   */
  var TRAITS = [
    { name: 'speed',      lo: 0.35, hi: 1.45, neutral: 0.72, grp: 'locomotion' },
    { name: 'sense',      lo: 1,    hi: 5,    neutral: 0.45, grp: 'sensory' },
    { name: 'metabolism', lo: 0.45, hi: 1.85, neutral: 0.42, grp: 'energy' },
    { name: 'size',       lo: 0.55, hi: 1.85, neutral: 0.34, grp: 'morphology' },
    { name: 'fertility',  lo: 0.45, hi: 1.70, neutral: 0.46, grp: 'reproduction' },
    { name: 'aggression', lo: 0,    hi: 1,    neutral: 0.30, grp: 'behaviour' },
    { name: 'discipline', lo: 0,    hi: 1,    neutral: 0.30, grp: 'cognition' },
    { name: 'cold',       lo: 0,    hi: 1,    neutral: 0.42, grp: 'tolerance' },
    { name: 'heat',       lo: 0,    hi: 1,    neutral: 0.55, grp: 'tolerance' },
    { name: 'amphibious', lo: 0,    hi: 1,    neutral: 0.05, grp: 'locomotion' },
    { name: 'social',     lo: 0,    hi: 1,    neutral: 0.45, grp: 'behaviour' },
    { name: 'curiosity',  lo: 0,    hi: 1,    neutral: 0.50, grp: 'cognition' },
    { name: 'longevity',  lo: 0.55, hi: 2.40, neutral: 0.36, grp: 'morphology' },
    { name: 'camouflage', lo: 0,    hi: 1,    neutral: 0.25, grp: 'morphology' }
  ];

  var NG = TRAITS.length;
  var GENE_INDEX = {};
  for (var ti = 0; ti < NG; ti++) GENE_INDEX[TRAITS[ti].name] = ti;

  /* --------------------------------------------------------------- stats */

  function geneOf(genome, name) { return genome[GENE_INDEX[name]]; }

  function traitOf(genome, name) {
    var t = TRAITS[GENE_INDEX[name]];
    return t.lo + (t.hi - t.lo) * genome[GENE_INDEX[name]];
  }

  /* Trait values for the inspector UI. */
  function describe(genome) {
    var out = [];
    for (var i = 0; i < NG; i++) {
      out.push({
        name: TRAITS[i].name,
        group: TRAITS[i].grp,
        raw: genome[i],
        value: TRAITS[i].lo + (TRAITS[i].hi - TRAITS[i].lo) * genome[i],
        lo: TRAITS[i].lo,
        hi: TRAITS[i].hi,
        neutral: TRAITS[i].neutral
      });
    }
    return out;
  }

  /* ------------------------------------------------------------ generation */

  /* Full genome length: body genes followed by the brain block. The brain
   * module may not be loaded yet when this file is evaluated, so the length is
   * resolved at call time rather than at module scope. */
  function brainLen() { return global.HX.Brain ? global.HX.Brain.LEN : 0; }
  function totalLen() { return NG + brainLen(); }

  function blank() { return new Float32Array(totalLen()); }

  /* A complete genome with randomised body traits and brain weights. */
  function randomGenome(rng, spread) {
    spread = spread === undefined ? 1 : spread;
    var g = blank();
    for (var i = 0; i < NG; i++) {
      var t = TRAITS[i];
      /* Box-Muller around the neutral point, then clamped — random genomes
       * cluster near viability instead of being uniformly random. */
      var v = t.neutral + rng.gauss(0, 0.26) * spread;
      g[i] = U.clamp01(v);
      if (i === GENE_INDEX.amphibious) g[i] = Math.min(g[i], 0.25 * spread);
    }
    var Brain = global.HX.Brain;
    if (Brain) {
      var w = Brain.randomWeights(rng, 0.55 * spread);
      g.set(w, NG);
    }
    return g;
  }

  /* A genome biased toward a role (herbivore / carnivore / drifter). */
  function roleGenome(rng, kind, lineage) {
    var g = randomGenome(rng, 1);
    function set(name, v) { g[GENE_INDEX[name]] = U.clamp01(v); }
    if (kind === 0) {              /* HERBIVORE */
      set('aggression', 0.12);
      set('speed', 0.62);
      set('size', 0.42);
      set('metabolism', 0.40);
      set('social', 0.62);
    } else if (kind === 1) {       /* CARNIVORE */
      set('aggression', 0.78);
      set('speed', 0.74);
      set('size', 0.62);
      set('metabolism', 0.55);
      set('social', 0.22);
      set('fertility', 0.46);
    } else {                       /* OMNIVORE */
      set('aggression', 0.50);
      set('speed', 0.70);
      set('size', 0.52);
      set('social', 0.40);
    }
    if (lineage) blendInto(g, lineage);
    return g;
  }

  /* Nudge a random genome toward a lineage so re-seeded species stay related. */
  function blendInto(g, lineage, amount) {
    amount = amount === undefined ? 0.65 : amount;
    for (var i = 0; i < NG; i++) {
      g[i] = U.clamp01(U.lerp(g[i], lineage[i], amount));
    }
    return g;
  }

  /* ------------------------------------------------------------ mutation */

  /* Gaussian mutation with a heavy zero-inflation: most offspring differ from
   * a parent by a handful of genes, which is what keeps evolution tractable
   * instead of degenerating into noise. `rate` is the PER-GENE probability. */
  function mutate(src, rng, rate, strength) {
    rate = rate === undefined ? 0.10 : rate;
    strength = strength === undefined ? 0.18 : strength;
    if (rate > 0.9) rate = 0.9;
    var out = new Float32Array(src.length);
    out.set(src);
    for (var i = 0; i < out.length; i++) {
      if (rng.chance(rate)) {
        /* logarithmic scale choice: small steps are far more common */
        var step = (rng.chance(0.82) ? 1 : 4) * strength * Math.abs(rng.gauss(0, 1));
        out[i] = U.clamp01(out[i] + step);
      }
    }
    /* trait-aware repair: keep body plans inside viable envelopes */
    if (out[GENE_INDEX.amphibious] > 0.55) out[GENE_INDEX.amphibious] = rng.float(0.2, 0.55);
    if (out[GENE_INDEX.aggression] > 0.92 && out[GENE_INDEX.size] < 0.3) {
      out[GENE_INDEX.size] = rng.float(0.3, 0.5);
    }
    return out;
  }

/* ------------------------------------------------------------ crossover */

  /* Uniform crossover over body genes. The brain is mixed one LAYER at a time
   * rather than weight by weight: interpolating individual weights between two
   * unrelated networks yields a gradient of nonsense, whereas choosing whole
   * layers yields one functional network or the other — which is what makes
   * whole-layer recombination useful instead of merely destructive. */
  function crossover(a, b, rng) {
    var out = new Float32Array(a.length);
    var i;
    for (i = 0; i < NG; i++) out[i] = rng.chance(0.5) ? a[i] : b[i];

    var Brain = global.HX.Brain;
    if (!Brain) return out;

    var segs = Brain.segments();
    for (var s = 0; s < segs.length; s++) {
      var from = NG + segs[s][0];
      var to = NG + segs[s][1];
      var src = rng.chance(0.5) ? a : b;
      for (i = from; i < to; i++) out[i] = src[i];
      /* 18% of the time, swap one random weight inside the chosen layer —
       * gives recombination a little local search on top of macro mixing */
      if (rng.chance(0.18) && to > from) {
        var k = from + rng.below(to - from);
        out[k] = rng.chance(0.5) ? a[k] : b[k];
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- io */

  function serialize(genome) {
    var out = new Array(genome.length);
    for (var i = 0; i < genome.length; i++) out[i] = Math.round(genome[i] * 10000) / 10000;
    return out;
  }

  function deserialize(arr) {
    var g = new Float32Array(arr.length);
    for (var i = 0; i < arr.length; i++) g[i] = U.clamp01(arr[i]);
    return g;
  }

  /* Hamming-like distance between two genomes, for lineage divergence. */
  function distance(a, b) {
    var n = Math.min(a.length, b.length);
    var s = 0;
    for (var i = 0; i < n; i++) { var d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s / n);
  }

  function hash(genome) {
    var h = 0x811c9dc5;
    for (var i = 0; i < genome.length; i++) {
      var q = Math.round(genome[i] * 255) & 255;
      h ^= q; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  global.HX = global.HX || {};
  global.HX.Genome = {
    TRAITS: TRAITS,
    NG: NG,
    GENE_INDEX: GENE_INDEX,
    totalLen: totalLen,
    blank: blank,
    geneOf: geneOf,
    traitOf: traitOf,
    describe: describe,
    randomGenome: randomGenome,
    roleGenome: roleGenome,
    blendInto: blendInto,
    mutate: mutate,
    crossover: crossover,
    serialize: serialize,
    deserialize: deserialize,
    distance: distance,
    hash: hash
  };

})(typeof window !== 'undefined' ? window : globalThis);