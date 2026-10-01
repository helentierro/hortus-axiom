/* ============================================================================
 * HORTUS / world/brain.js
 *
 * A tiny feed-forward network: IN -> H -> OUT, tanh throughout, laid out as a
 * flat run of weights appended to the agent's genome.
 *
 *   offset 0                 bias for hidden layer   (H)
 *   offset H                 hidden -> input weights (H * IN)
 *   offset H + H*IN          bias for output layer   (OUT)
 *   offset H + H*IN + OUT    output -> hidden weights (OUT * H)
 *
 * Why a network at all, when a rule-based agent would "work" too? Because the
 * point of HORTUS is to watch selection act on behaviour. The network is not
 * required for the ecology to function — every creature also carries an
 * instinct bias — but it is what lets fitness improvements come from *policy*
 * rather than only from better bodies.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;

  var IN = 12;
  var H = 10;
  var OUT = 8;

  var OFF_B1 = 0;
  var OFF_W1 = OFF_B1 + H;                 /* H */
  var OFF_B2 = OFF_W1 + H * IN;            /* H + H*IN */
  var OFF_W2 = OFF_B2 + OUT;               /* H + H*IN + OUT */
  var LEN = OFF_W2 + OUT * H;

  /* The twelve sensory channels, in weight-matrix order.
   *
   * Three of them (gradE, gradN, gradX) are *directional* gradients rather
   * than scalars. That is deliberate: a scalar "food nearby" signal cannot
   * tell the network which way to turn, so a policy has to be blind to
   * direction and no amount of training fixes it. Giving the network the three
   * independent components of the local food gradient is what makes the
   * evolved controller capable of something the hand-written instinct is only
   * approximating. */
  var INPUT_NAMES = [
    'hunger', 'forage', 'gradE', 'gradN', 'gradX',
    'shore', 'crowd', 'thermal', 'threat', 'mates',
    'day', 'noise'
  ];

  /* Output semantics, in the same order as the hex directions. */
  var OUT_DIR = [0, 1, 2, 3, 4, 5];   /* E NE NW W SW SE */
  var OUT_REST = 6;
  var OUT_SEEK = 7;                    /* seek mate / pursue prey */

  /* -------------------------------------------------------------- layout */

  function layout() {
    return { IN: IN, H: H, OUT: OUT, len: LEN, offB1: OFF_B1, offW1: OFF_W1, offB2: OFF_B2, offW2: OFF_W2 };
  }

  /* Crossover segments, as [start, end) ranges relative to the brain block. */
  function segments() {
    return [[OFF_B1, OFF_W1], [OFF_W1, OFF_B2], [OFF_B2, OFF_W2], [OFF_W2, LEN]];
  }

  function randomWeights(rng, sigma) {
    sigma = sigma === undefined ? 0.55 : sigma;
    var w = new Float32Array(LEN);
    for (var i = 0; i < LEN; i++) w[i] = rng.gauss(0, sigma);
    return w;
  }

  /* Scale a set of weights down toward zero (used by AXIOM's `(calm ...)`). */
  function scaleWeights(w, k) { for (var i = 0; i < w.length; i++) w[i] *= k; return w; }

  /* ------------------------------------------------------------ inference */

  /* tanh via the standard rational approximation; cheaper than Math.tanh in
   * V8 and accurate to ~1e-7 over the range that matters here. */
  function ftanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    var x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  var hidden = new Float32Array(H);
  var outputs = new Float32Array(OUT);

  /*
   * w is a Float32Array view of the brain block of a genome.
   * `inp` is a Float32Array(IN) the caller fills (reused between agents).
   * Result is written into `outBuf` (also reused) and returned.
   */
  function forward(w, inp, outBuf) {
    outBuf = outBuf || outputs;
    var i, j, s;

    for (j = 0; j < H; j++) {
      s = w[OFF_B1 + j];
      var base = OFF_W1 + j * IN;
      for (i = 0; i < IN; i++) s += w[base + i] * inp[i];
      hidden[j] = ftanh(s);
    }
    for (j = 0; j < OUT; j++) {
      s = w[OFF_B2 + j];
      var base2 = OFF_W2 + j * H;
      for (i = 0; i < H; i++) s += w[base2 + i] * hidden[i];
      outBuf[j] = ftanh(s);
    }
    return outBuf;
  }

  /* --------------------------------------------------------------- weight
   * maps, used by the inspector's brain heat-map. Maps a weight index to a
   * human-readable source: destination neuron and input label. */
  function describeWeights(w) {
    var rows = [], i, j;
    for (j = 0; j < H; j++) {
      var row = { to: 'h' + j, bias: w[OFF_B1 + j], from: [] };
      for (i = 0; i < IN; i++) row.from.push({ label: INPUT_NAMES[i], w: w[OFF_W1 + j * IN + i] });
      rows.push(row);
    }
    for (j = 0; j < OUT; j++) {
      var row2 = { to: OUT_NAMES[j], bias: w[OFF_B2 + j], from: [] };
      for (i = 0; i < H; i++) row2.from.push({ label: 'h' + i, w: w[OFF_W2 + j * H + i] });
      rows.push(row2);
    }
    return rows;
  }

  var OUT_NAMES = ['east', 'north-east', 'north-west', 'west', 'south-west', 'south-east', 'hold', 'seek'];

  /* Which inputs a given output is most sensitive to — a cheap heuristic used
   * by the inspector to caption an evolved policy in words. */
  function caption(w, outIdx) {
    var base = OFF_W2 + outIdx * H;
    var best = -1, bestI = 0, mag = 0;
    for (var i = 0; i < H; i++) {
      var v = Math.abs(w[base + i]);
      if (v > mag) { mag = v; bestI = i; }
    }
    if (best < 0) return '—';
    var bidx = U.argmax([1, 2, 3, 4, 5, 6, 7, 8].map(function (k) {
      return Math.abs(w[OFF_W1 + bestI * IN + k]);
    }));
    return OUT_NAMES[outIdx] + ' \u2190 ' + INPUT_NAMES[bidx];
  }

  global.HX = global.HX || {};
  global.HX.Brain = {
    IN: IN, H: H, OUT: OUT, LEN: LEN,
    INPUT_NAMES: INPUT_NAMES,
    OUT_NAMES: OUT_NAMES,
    OUT_DIR: OUT_DIR,
    OUT_REST: OUT_REST,
    OUT_SEEK: OUT_SEEK,
    layout: layout,
    segments: segments,
    randomWeights: randomWeights,
    scaleWeights: scaleWeights,
    forward: forward,
    describeWeights: describeWeights,
    caption: caption
  };

})(typeof window !== 'undefined' ? window : globalThis);