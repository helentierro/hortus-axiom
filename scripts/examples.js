/* ============================================================================
 * HORTUS / scripts/examples.js
 *
 * The programs offered in the console. Each is a real program that does
 * something to the running simulation, not a syntax demo.
 *
 * Kept as a module rather than files fetched at runtime so the page works from
 * a file:// URL with no server and no network.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var EXAMPLES = [
    {
      id: 'genesis',
      title: 'Genesis',
      tag: 'report',
      desc: 'Prints a census of the world: who lives here, how much there is to eat, and which ' +
        'biome is winning. Runs instantly; useful for orienting yourself in a fresh world.',
      src: [
        '; What kind of world is this?',
        '(define s (stats))',
        '',
        '(println "seed          " (seed-string))',
        '(println "day / year    " (day) "/" (year))',
        '(println "population    " s.population)',
        '(println "  grazers     " s.grazers)',
        '(println "  stalkers    " s.stalkers)',
        '(println "generation    " s.generation)',
        '(println "vegetation    " (number->string s.vegetation 3))',
        '(println "  saturated   " (number->string s.vegetationSaturation 2))',
        '(println "land fraction " (number->string s.landFraction 2))',
        '(println "dominant      " s.dominantBiome)',
        '(println "rivers        " s.rivers " cells")',
        '',
        '(println "lineages:")',
        '(each (species)',
        '  (fn (sp) (println "  " sp.name',
        '                     "(" (kind-name sp.kind) ")"',
        '                     sp.count " alive, peak" sp.peak',
        '                     ", generation" sp.generation)))',
        '',
        '(define c (climate))',
        '(println "climate       " (number->string c.meanTemp 2) " warm,"',
        '                    (number->string c.meanMoisture 2) " wet,"',
        '                    (number->string c.rain 2) " rain")'
      ].join('\n')
    },

    {
      id: 'five-winters',
      title: 'Five Winters',
      tag: 'macro-ecology',
      desc: 'Forces five consecutive winters, each more brutal than the last, and reports the ' +
        'toll. Watch the population curve afterwards &mdash; this is the strongest selection ' +
        'pressure in the whole simulation.',
      src: [
        '; Five winters, each colder than the last.',
        '; Each one culls whoever cannot pay for thermoregulation.',
        '',
        '(define before (population))',
        '(define gens (list (generation)))',
        '',
        '(define (measure label)',
        '  (println label',
        '           "| pop" (population)',
        '           "graze" (agent-count nil 0)',
        '           "stalk" (agent-count nil 1)',
        '           "gen" (generation)',
        '           "veg" (number->string (field (stats) "vegetation") 3)))',
        '',
        '(println "starting:" before "alive, generation" (generation))',
        '',
        '(repeat 5',
        '  (set-season! "winter")',
        '  (set-weather! "rain" (random 0.0 0.4))',
        '  (println "-- wintering --")',
        '  (advance! 55)',
        '  (measure "   after"))',
        '',
        '(set-season! "summer")',
        '(println "thawing")',
        '(advance! 90)',
        '(measure "final ")',
        '',
        '(say! "five winters have passed")',
        '(println)',
        '(println "population change:" (- (population) before))'
      ].join('\n')
    },

    {
      id: 'breed-the-swift',
      title: 'Breed the Swift',
      tag: 'artificial selection',
      desc: 'An explicit eugenic programme: over sixty days, preferentially cull the slowest ' +
        'grazers and let the fastest breed freely. Reports how far the speed gene actually moves ' +
        '&mdash; which is usually less than you would hope.',
      src: [
        '; Select for speed, against the grain.',
        '; Note that the speed gene is already near its ceiling here,',
        '; so the honest answer is usually "not much".',
        '',
        '(define speed-of (fn (a) (if (nil? (gene a "speed")) 0 (gene a "speed"))))',
        '(define grazers (agents nil 0))',
        '',
        '(define baseline (mean (map speed-of grazers)))',
        '(println "start: mean speed gene" baseline)',
        '(println "      grazers" (length grazers))',
        '',
        '(define culled 0)',
        '(define spared 0)',
        '',
        '(repeat 30',
        '  ; cull the slowest tenth of mature grazers.',
        '  ; NOTE: the list is re-fetched every round, because killing an agent',
        '  ; and ticking the world releases its genome back to the pool — a',
        '  ; captured list of agents goes stale the moment anything dies.',
        '  (define sorted (sort (agents nil 0) speed-of))',
        '  (define floor-cut',
        '    (if (> (length sorted) 4)',
        '        (speed-of (nth sorted (max 0 (- (length sorted) (floor (/ (length sorted) 10))))))',
        '        0))',
        '  (each sorted',
        '    (fn (a)',
        '      (when (and (< (speed-of a) floor-cut)',
        '                 (>= (agent-field a "energy") 22))',
        '        (kill! a)',
        '        (set! culled (+ culled 1)))',
        '      (set! spared (+ spared 1))))',
        '  (advance! 2))',
        '',
        '(define after (mean (map speed-of (agents nil 0))))',
        '(println)',
        '(println "culled        " culled)',
        '(println "spared        " spared)',
        '(println "end: mean speed gene" after)',
        '(println "shift         " (number->string (- after baseline) 4))',
        '(println "population now" (population))',
        '',
        '(say! "the swift have been preferred")'
      ].join('\n')
    },

    {
      id: 'mass-bloom',
      title: 'Mass Bloom',
      tag: 'terraforming',
      desc: 'Sweeps the map and raises vegetation everywhere fertile, then reports the biomass ' +
      'before and after. Watch the mass gain decay as the grazers find it.',
      src: [
        '; Push the whole map into a green age, and watch it come back down.',
        '',
        '(define before (fold-cells (fn (s c) (+ s c.veg)) 0))',
        '(println "biomass before:" (number->string before 0))',
        '',
        '(define n 0)',
        '(fold-cells',
        '  (fn (acc c)',
        '    (when (> c.fert 0.4)',
        '      (set-field! c "veg" (+ c.veg (random 0.15 0.5)))',
        '      (set! n (+ n 1)))',
        '    acc)',
        '  0)',
        '(println "bloomed" n "cells")',
        '(println "biomass now: " (number->string (fold-cells (fn (s c) (+ s c.veg)) 0) 0))',
        '',
        '(advance! 25)',
        '(println "after 25 days:" (number->string (fold-cells (fn (s c) (+ s c.veg)) 0) 0)',
        '         "population" (population))',
        '',
        '(say! "a green age, briefly")'
      ].join('\n')
    },

    {
      id: 'blight-wave',
      title: 'Blight Wave',
      tag: 'catastrophe',
      desc: 'Scours a band of blight across the map and follows it. The vegetation does not ' +
        'recover instantly: the seed-bank floor means barren ground creeps back at the speed of ' +
        'logistic growth, which is the whole point of that floor.',
      src: [
        '; Walk a blight front across the continent.',
        '',
        '(define col (random 0 (world-w)))',
        '(println "front starts at column" col)',
        '',
        '(repeat 14',
        '  (let ((c (cell (mod col (world-w)) (random 0 (world-h - 1)))))',
        '    (scorch! c 3 0.95)',
        '    (set! col (+ col 1))))',
        '',
        '(println "biomass now:"',
        '         (number->string (fold-cells (fn (s c) (+ s c.veg)) 0) 0))',
        '(println "burnt cells:" (length (scattered-events)))',
        '',
        '(say! "the blight front has passed")',
        '',
        '(println "watch the biomass chart while it grows back.")'
      ].join('\n')
    },

    {
      id: 'lineage-divergence',
      title: 'Lineage Divergence',
      tag: 'analysis',
      desc: 'Measures how far each competing species has drifted from its own founder, which is a ' +
        'direct read on how hard selection is actually pushing.',
      src: [
        '; How far has each lineage travelled from where it started?',
        '',
        '(define founders',
        '  (map (fn (sp) (genome-hash sp.founder)) (species)))',
        '',
        '(println "founder genomes:")',
        '(each (enumerate founders)',
        '  (fn (pair) (println "  species" (nth pair 0) (nth pair 1))))',
        '',
        '(println "lineage            kind      count   gen  divergence")',
        '(println "----------------------------------------------------")',
        '',
        '(each (enumerate (species))',
        '  (fn (pair)',
        '    (let ((i (nth pair 0)) (sp (nth pair 1)))',
        '      (define living (agents i))',
        '      (define d (mean (map (fn (a) (genome-distance (genome a) sp.founder)) living)))',
        '      (println (pad-left (number->string i) 2)',
        '               (pad-left (truncate sp.name 20) 20)',
        '               (pad-left (kind-name sp.kind) 9)',
        '               (pad-left (length living) 6)',
        '               (pad-left sp.generation 5)',
        '               (if (or (nil? d) (nan? d)) "  --  "',
        '                   (number->string d 4))))))',
        '',
        '(println)',
        '(println "divergence is mean per-gene distance from the founder genome.")',
        '(println "a lineage under no pressure stays near zero.")'
      ].join('\n')
    },

    {
      id: 'germline',
      title: 'Germline',
      tag: 'direct manipulation',
      desc: 'Writes a genome directly: sets a trait on every grazer and lets the population respond. ' +
        'This is the fastest way to see which genes the ecology actually cares about.',
      src: [
        '; Edit bodies, then watch selection undo you.',
        '',
        '(println "grazers:" (agent-count nil 0))',
        '',
        '; make everyone cold-tolerant and slow',
        '(each (agents nil 0)',
        '  (fn (a)',
        '    (set-trait! a "cold" 0.95)',
        '    (set-trait! a "heat" 0.10)',
        '    (set-trait! a "speed" 0.30)))',
        '',
        '(println "temperatures, now:")',
        '(println "  cold gene" (mean (map (fn (a) (gene a "cold")) (agents nil 0))))',
        '(println "  speed gene" (mean (map (fn (a) (gene a "speed")) (agents nil 0))))',
        '',
        '(advance! 120)',
        '',
        '(define after (agents nil 0))',
        '(println "after 120 days:")',
        '(println "  cold gene" (mean (map (fn (a) (gene a "cold")) after)))',
        '(println "  speed gene" (mean (map (fn (a) (gene a "speed")) after)))',
        '(println "  population" (population))',
        '(println)',
        '(println "compare with the numbers above.")'
      ].join('\n')
    },

    {
      id: 'predator-policy',
      title: 'Predator Policy',
      tag: 'management',
      desc: 'A cull of the stalkers, followed by a census. Removes them entirely and measures what ' +
        'the grazers do with the space.',
      src: [
        '; Remove every stalker and measure the release.',
        '',
        '(define stalkers (agents nil 1))',
        '(println "stalkers before:" (length stalkers))',
        '(println "grazers before: " (agent-count nil 0))',
        '',
        '(each stalkers (fn (s) (kill! s)))',
        '',
        '(say! "the stalkers have been removed")',
        '(advance! 30)',
        '',
        '(define g1 (agent-count nil 0))',
        '(println "after 30 days: grazers" g1)',
        '(advance! 60)',
        '(define g2 (agent-count nil 0))',
        '(println "after 90 days: grazers" g2)',
        '(println "biomass:" (number->string (fold-cells (fn (s c) (+ s c.veg)) 0) 0))',
        '(println)',
        '(println "watch what happens when the grazers hit the ceiling.")'
      ].join('\n')
    },

    {
      id: 'map-portrait',
      title: 'Map Portrait',
      tag: 'analysis',
      desc: 'Walks the map and prints an ASCII cross-section down the middle column. Crude, ' +
        'but it makes the mountain belts and the shoreline legible in a way that a number is not.',
      src: [
        '; A cross-section through the middle of the map.',
        '',
        '(define mid (/ (world-h) 2))',
        '(define ramp " .:-=+*#%@")',
        '(define land (list))',
        '(define sea (list))',
        '',
        '(define (glyph v)',
        '  (if (>= v 0.5)',
        '      "~~~~~~~~~~"',
        '      (string (nth ramp (min 9 (floor (* v 10)))))))',
        '',
        '(each (range 0 (world-w))',
        '  (fn (c)',
        '    (let ((cell (cell c mid)))',
        '      (if (> cell.water 0.02)',
        '          (set! sea (push! sea (string (glyph cell.water) " ")))',
        '          (set! land (push! land (string (glyph cell.elev) " ")))))))',
        '',
        '(println "elevation, column 0 -> " (world-w))',
        '(println (apply concat-str land))',
        '(println)',
        '(println "water depth along the same line:")',
        '(println (apply concat-str sea))',
        '',
        '(println "dominant biome:" (dominant-biome))'
      ].join('\n')
    },

    {
      id: 'night-shift',
      title: 'Night Shift',
      tag: 'atmosphere',
      desc: 'Drives the diurnal cycle fast, so you can watch the lighting sweep and the pulse ' +
        'chase it. Also the fastest way to see the seasons turn.',
      src: [
        '; Run the clock hard. Watch the light sweep across the map.',
        '',
        '(define (watch label)',
        '  (println label',
        '           "| day" (day)',
        '           "season" (season-name)',
        '           "sun" (number->string (field (climate) "meanTemp") 2)',
        '           "pop" (population)',
        '           "veg" (number->string (fold-cells (fn (s c) (+ s c.veg)) 0) 0)))',
        '',
        '(each (list "spring" "summer" "autumn" "winter")',
        '  (fn (name)',
        '    (set-season! name)',
        '    (println "=== " name " ===")',
        '    (repeat 4',
        '      (advance! 24)',
        '      (watch "  day"))))',
        '',
        '(say! "a full turn of the year")'
      ].join('\n')
    }
  ];

  global.HX = global.HX || {};
  global.HX.EXAMPLES = EXAMPLES;

})(typeof window !== 'undefined' ? window : globalThis);