/* ============================================================================
 * HORTUS / ui/manual.js
 *
 * The manual, written as data so it can be rendered into the modal.
 *
 * It is unusually long on purpose. HORTUS is an instrument with a language
 * attached, and a machine you cannot read is just a screensaver.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var MANUAL = [
    ['h', 'What this is'],
    ['p', 'HORTUS grows a world from a seed and then lets evolution happen inside it. ' +
      'Terrain, rivers, climate and biomes are generated deterministically; animals with genomes and ' +
      'neural controllers are born, eat, hunt, reproduce and die; and you can interfere at any point ' +
      'by writing <code>AXIOM</code>, a small Lisp that reaches into the running simulation.'],
    ['p', 'Every world has a seed string, and everything after that seed &mdash; the terrain, the ' +
      'rivers, the weather, every genome and every death &mdash; is drawn from it alone. So a seed ' +
      'reproduces a world exactly, including the eventual extinction of whichever lineage happened ' +
      'to lose. The one thing not derived from the seed is the seed itself: opening the page with no ' +
      '<code>?seed=</code> in the address bar picks a new one, so every visit is somewhere new.'],

    ['h', 'The world'],
    ['ul', [
      '<b>Tectonics.</b> Domain-warped fractal noise for the continents, ridged noise for mountain ' +
      'belts, and a handful of island arcs. Sea level is chosen as an elevation quantile so every ' +
      'world is about half land.',
      '<b>Hydrology.</b> Rain is dropped on every land cell and routed downhill, processing cells in ' +
      'strictly descending elevation. Because upstream contributions always arrive before a cell is ' +
      'routed, one pass produces exact flow accumulation &mdash; and rivers fall out of it for free, ' +
      'with correct mouths and correct drainage.',
      '<b>Rain shadows.</b> Each cell takes a sky-view factor: the maximum horizon angle in six ' +
      'directions. The lee side of a range dries out, and the wet side does not.',
      '<b>Temperature.</b> Latitude, minus an elevation lapse rate, moderated by proximity to the sea, ' +
      'then swung seasonally by an amount that grows with latitude.',
      '<b>Biomes.</b> Classified from <em>quantiles</em> of the land\'s own elevation, moisture and ' +
      'temperature distributions rather than from fixed cut-offs. Fixed thresholds give you a world ' +
      'that is all alpine in one seed and all swamp in another; quantiles guarantee a legible spread ' +
      'of every biome on every map.'
    ]],

    ['h', 'The creatures'],
    ['p', 'Each animal carries a genome: fourteen body genes and a small neural network, all in one ' +
      'flat array. Body genes are stored normalised to <code>[0,1]</code> and mapped to real ranges when ' +
      'read, so a mutation always means the same fraction of a trait\'s range.'],
    ['pre', 'speed   sense   metabolism  size   fertility  aggression  discipline\n' +
      'cold    heat    amphibious     social curiosity longevity  camouflage\n' +
      '          |---- 12 -> 10 -> 8 network weights ----|'],
    ['ul', [
      '<b>Every animal also has instinct.</b> A hard-wired bias vector grazes up the vegetation ' +
      'gradient, flees stalkers and stalks prey. It is blended with the network according to the ' +
      'gene <code>discipline</code>. A neural-only agent dies of nothing within a few generations; ' +
      'the blend means selection can still improve <em>behaviour</em>, while the ecology stays alive ' +
      'long enough to be worth watching.',
      '<b>Maintenance scales as mass<sup>3/4</sup></b> (Kleiber\'s law) rather than linearly. With a ' +
      'linear cost, intake and cost both rise with body size and larger is simply better for ' +
      'everything at once &mdash; the <code>size</code> gene hits its ceiling within a dozen generations ' +
      'and the evolution becomes boring. At the three-quarter exponent the two scale together, and ' +
      'body size is driven instead by predation risk, crowding and agility.',
      '<b>Vegetation follows logistic growth</b> with a seed-bank floor of 4% of carrying capacity. ' +
      'Pure logistic growth has an absorbing state at zero &mdash; one cell a grazer strips bare ' +
      'stays bare forever, and a single overgrazed patch will poison a whole region while the rest ' +
      'of the map sits untouched. That one line is the difference between a simulation and a ' +
      'landslide.',
      '<b>Extinction is recoverable.</b> A species that reaches zero keeps its founder genome and is ' +
      're-seeded, mutated, after a grace period. Watch the lineage plot for the gaps.'
    ]],

    ['h', 'AXIOM'],
    ['p', 'A Lisp with proper lexical scope, <code>let</code>/<code>let*</code>, variadic functions, ' +
      'dictionaries, <code>defmacro</code>, and hygiene via <code>gensym</code>. Evaluation is budgeted: ' +
      'a runaway loop raises a readable error instead of freezing the tab, and the simulation is left ' +
      'in whatever consistent state it had reached.'],
    ['pre', "; a comment\n" +
      "(define (mean v) (/ (reduce + 0 v) (length v)))\n\n" +
      "(define grazers (agents nil 0))\n" +
      "(println \"grazers:\" (length grazers))\n" +
      "(println \"mean energy:\" (mean (map (fn (a) a.energy) grazers)))\n\n" +
      "; and a world that responds to it\n" +
      "(each (sample 40 grazers)\n" +
      "  (fn (a) (bloom! (cell-at (agent-field a \"cell\")) 2 0.6)))\n" +
      "(say! \"the herd left a trail\")"],
    ['h3', 'Special forms'],
    ['table', [
      ['<code>(define x v)</code>', 'bind a global; <code>(define (f a) ...)</code> binds a function'],
      ['<code>(defn f (a) ...)</code>', 'same thing, reads better'],
      ['<code>(set! x v)</code>', 'assign an existing binding'],
      ['<code>(let ((a 1) (b 2)) ...)</code>', 'fresh bindings, parallel'],
      ['<code>(let* ((a 1) (b a)) ...)</code>', 'fresh bindings, sequential'],
      ['<code>(if c a b)</code> <code>(cond ...)</code>', 'no <code>else</code> keyword needed; it exists'],
      ['<code>(when c ...)</code> <code>(unless c ...)</code>', 'body of zero or more forms'],
      ['<code>(do ...)</code>', 'evaluate in order, return the last'],
      ['<code>(fn (a b &amp;rest) ...)</code>', 'closure; <code>&amp;rest</code> collects the remainder'],
      ['<code>(while c ...)</code> <code>(repeat n ...)</code> <code>(each coll fn)</code>', 'iteration'],
      ['<code>(and ...)</code> <code>(or ...)</code> <code>(not x)</code>', 'short-circuit'],
      ['<code>\'x</code> <code>``(a ,b ,@c)</code>', 'quote and quasiquote; <code>,@</code> splices'],
      ['<code>(defmacro m (x) ...)</code>', 'compile-time expansion; use <code>(gensym)</code> for locals']
    ]],
    ['p', 'Callbacks receive the element index as a <em>second</em> argument when they declare ' +
      'two parameters or more, but not when they declare only one. That is deliberate for ' +
      '<code>map</code>, <code>filter</code> and <code>reduce</code>: <code>(map + xs)</code> must ' +
      'not quietly add each element to its own index. ' +
      '<code>each</code>, <code>scan-cells</code> and <code>fold-cells</code> are the exception &mdash; ' +
      'they always pass the index, so <code>(each xs +)</code> really does sum element plus index.'],
    ['h3', 'Reaching into the world'],
    ['table', [
      ['<code>(day)</code> <code>(year)</code> <code>(season)</code> <code>(season-name)</code>', 'the clock'],
      ['<code>(advance! n)</code>', 'run <code>n</code> simulated days, right now'],
      ['<code>(set-season! "winter")</code>', 'skip to a season'],
      ['<code>(cell x y)</code> <code>(cell-at i)</code>', 'a live cell reference'],
      ['<code>c.veg</code> <code>(field c "veg")</code>', 'read a field &mdash; both are live'],
      ['<code>(set-field! c "veg" 0.8)</code>', 'write a field'],
      ['<code>(biome-name c)</code> <code>(biome-id "FOREST")</code>', 'the biome table'],
      ['<code>(around c 2)</code> <code>(around-sum c "veg" 2)</code>', 'neighbourhood queries'],
      ['<code>(scan-cells fn)</code> <code>(fold-cells fn init)</code>', 'whole-map folds'],
      ['<code>(bloom! c 3 0.8)</code> <code>(scorch! c 2 0.9)</code> <code>(quake! c 4 0.1)</code>', 'events'],
      ['<code>(agents)</code> <code>(agents nil 1)</code> <code>(agent-count)</code>', 'the population'],
      ['<code>a.energy</code> <code>(agent-field a "generation")</code>', 'agent fields, live'],
      ['<code>(trait a "speed")</code> <code>(set-trait! a "speed" 0.9)</code>', 'edit a genome'],
      ['<code>(mutate! a 0.3 0.2)</code> <code>(crossover-genome a b)</code>', 'drive evolution by hand'],
      ['<code>(spawn! c nil 0)</code> <code>(kill! a)</code> <code>(heal! a 40)</code>', 'direct intervention'],
      ['<code>(history)</code> <code>(best)</code> <code>(chapters)</code>', 'the record of what happened'],
      ['<code>(stats)</code> <code>(species)</code> <code>(seed-string)</code>', 'overview']
    ]],

    ['h', 'Keys'],
    ['table', [
      ['<kbd>Space</kbd>', 'pause / resume'],
      ['<kbd>Ctrl</kbd>+<kbd>Enter</kbd>', 'run the program'],
      ['<kbd>Ctrl</kbd>+<kbd>/</kbd>', 'comment the current line'],
      ['<kbd>1</kbd> &ndash; <kbd>6</kbd>', 'view mode'],
      ['<kbd>F</kbd>', 'fit the whole world'],
      ['<kbd>M</kbd>', 'mute'],
      ['<kbd>.</kbd>', 'advance one day'],
      ['<kbd>?</kbd>', 'this manual'],
      ['<kbd>Esc</kbd>', 'close this, or leave the field you are in'],
      ['<kbd>drag</kbd> / <kbd>wheel</kbd> / <kbd>pinch</kbd>', 'pan, zoom, zoom']
    ]],
    ['p', 'The keys other than <kbd>Ctrl</kbd>+<kbd>Enter</kbd> and ' +
      '<kbd>Ctrl</kbd>+<kbd>/</kbd> are ignored while a text field has focus, so typing ' +
      '<code>(print 1)</code> in the editor does not also toggle the view.'],

    ['h', 'Things to try'],
    ['ol', [
      'Leave it running for a thousand days and watch the lineage plot. Every gap is an extinction ' +
      'that recovered.',
      'Open a fresh world and watch <code>discipline</code> climb. Selection is choosing to use the ' +
      'brains.',
      'Run <em>Five Winters</em> from the examples panel, then compare the population curve with ' +
      'the default one.',
      'Write a policy that culls the slowest ten percent of grazers every generation. Compare ' +
      '<code>(mean (map (fn (a) (trait a "speed")) (agents)))</code> before and after.',
      'Paint blight with the &#9679; tool, or run <code>(fold-cells ...)</code> to bury half the ' +
      'map in it, and watch the biomass graph fall.',
      'Turn on the &#127757; button in the top right, then reload: the same world comes back. ' +
      'Off by default, because the point of a new visit is somewhere new.'
    ]],

    ['h', 'Honesty about the edges'],
    ['ul', [
      'The renderer falls back to Canvas2D if WebGL2 is unavailable or a shader fails to compile. ' +
      'You will be told which happened, in the corner of the view. The two renderers show the same ' +
      'world and the same view modes, but the GPU path has relief shading, water surfaces, bloom and ' +
      'grain that the CPU path approximates rather than matches. Force the fallback with ' +
      '<code>?renderer=canvas2d</code> if you want to compare.',
      'The audio is synthesised from oscillators and filtered noise. There is no soundtrack and ' +
      'nothing loops.',
      'Body size, metabolism and the neural networks are not derived from real biology. The ' +
      'allometric exponent is borrowed because it produces a stable, interesting simulation &mdash; ' +
      'not because mass<sup>3/4</sup> is being claimed to model a real animal.',
      'The simulation is deterministic given a seed, but a world you have grown is not stored ' +
      'anywhere. The seed is all you get: it reproduces the starting world exactly, not the state ' +
      'you reached. Use the &#128340; button to keep the seed across a reload, and ' +
      '<code>?seed=</code> in the address bar to return to one later.',
      'Above about 24 simulated days per frame the work per frame is capped so a slow renderer ' +
      'cannot spiral. The remainder is carried, so the day counter still keeps up with the slider.'
    ]]
  ];

  /* ------------------------------------------------------------- render */

  function esc(s) { return String(s); }

  function toHtml(node) {
    if (typeof node === 'string') return esc(node);
    var kind = node[0], body = node[1];
    switch (kind) {
      case 'h': return '<h3>' + body + '</h3>';
      case 'p': return '<p>' + body + '</p>';
      case 'ul': return '<ul>' + body.map(function (li) { return '<li>' + li + '</li>'; }).join('') + '</ul>';
      case 'ol': return '<ol>' + body.map(function (li) { return '<li>' + li + '</li>'; }).join('') + '</ol>';
      case 'pre': return '<pre>' + body + '</pre>';
      case 'table': return '<table>' + body.map(function (row) {
        return '<tr>' + row.map(function (cell, i) {
          return i === 0 ? '<th>' + cell + '</th>' : '<td>' + cell + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</table>';
      default: return '';
    }
  }

  function render(root) {
    root.innerHTML = MANUAL.map(toHtml).join('');
  }

  global.HX = global.HX || {};
  global.HX.MANUAL = { render: render, nodes: MANUAL };

})(typeof window !== 'undefined' ? window : globalThis);