/* ============================================================================
 * HORTUS / app.js
 *
 * The conductor. Owns the world, the ecosystem, the renderer, the language and
 * the panels, and runs one requestAnimationFrame loop.
 *
 * Two decisions shape the loop:
 *
 *  - THE SIMULATION RUNS ON AN ACCUMULATOR, NOT ON THE FRAME. Simulated time is
 *    advanced by however many days the speed setting calls for, with a hard cap
 *    per frame. That keeps a slow machine honest (it runs fewer days, it does
 *    not spiral) and keeps a fast machine from being unable to catch up.
 *
 *  - PANELS UPDATE ON THEIR OWN CLOCK. Instruments at 8 Hz, charts at 4 Hz,
 *    renderer at 60 Hz. Rebuilding a dozen panels every frame is how a smooth
 *    simulation ends up feeling like a slideshow.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var HX = global.HX;
  var U = HX.U;
  var G = HX.Genome;
  var Palette = HX.Palette;
  var R = HX.Reader;

  var App = {
    running: true,
    speed: 8,              /* simulated days per second */
    dayAccum: 0,
    maxDaysPerFrame: 24,
    /* Days that may be left over from a frame that was capped. Anything beyond
     * maxDaysPerFrame in a single frame used to be subtracted from dayAccum and
     * then thrown away, so above roughly 24 days/frame the world silently ran
     * slower than the slider said — drag to 60/d and it would do about 30. The
     * surplus is now carried, bounded, so the control means what it says and a
     * slow frame does not lose time. */
    maxCarry: 240,
    tool: 'pan',
    selection: null,
    highlight: null,
    started: false
  };

  /* ═══════════════════════════════════════════════════════════ boot */

  function camel(id) {
    return id.replace(/-([a-z0-9])/g, function (_, c) { return c.toUpperCase(); });
  }

  App.boot = function () {
    /* Idempotent on purpose. The boot button's Enter shortcut used to remove
     * its own document listener only inside the Enter branch, so starting with
     * the mouse left the listener armed for the rest of the session; the next
     * Enter anywhere — including inside the AXIOM editor, which only calls
     * preventDefault — clicked the button again and booted a SECOND copy of
     * everything: a second requestAnimationFrame loop (so the world ran at
     * double rate), a second AudioContext that was never closed, a second
     * Editor appended into #editor, duplicate listeners on every control, and
     * another season timer. */
    if (App.started) {
      if (global.console) global.console.warn('[HORTUS] boot() called twice; ignoring the second call');
      return;
    }
    App.started = true;
    /* Collect every element with an id once, exposing it under both its raw
     * id and a camelCase alias. Deriving the alias instead of hand-listing it
     * means a new element cannot be wired up wrong — the failure mode becomes
     * "null" in one obvious place rather than a mystery TypeError later. */
    var all = document.querySelectorAll('[id]');
    var dom = {};
    for (var n = 0; n < all.length; n++) {
      var id = all[n].id;
      dom[id] = all[n];
      dom[camel(id)] = all[n];
    }
    /* a couple of aliases the rest of the file uses for readability */
    dom.editor = dom['editor'];
    dom.programOut = dom['program-out'];
    dom.replField = dom['repl-field'];
    dom.exampleSelect = dom['example-select'];
    dom.speedOut = dom['speed-out'];
    dom.paneInst = dom['pane-inst'];
    dom.viewOverlay = dom['view-overlay'];
    dom.viewWrap = dom['view-wrap'];
    dom.tabProgram = dom['tab-program'];
    dom.tabRepl = dom['tab-repl'];
    dom.tabExamples = dom['tab-examples'];
    dom.chartPop = dom['chart-pop'];
    dom.chartVeg = dom['chart-veg'];
    dom.chartEnergy = dom['chart-energy'];
    dom.chartBiome = dom['chart-biome'];
    App.dom = dom;

    this.clock = new U.Clock();
    this.replLines = this.replLines || [];
    this.bindStaticUI();
    this.newWorld(readSeedFromUrl());
    requestAnimationFrame(this.loop);
  };

  function readSeedFromUrl() {
    var m = /[?&]seed=([^&]+)/.exec(location.search);
    if (m) return decodeURIComponent(m[1]);
    /* Returning to the world you were last in, if you asked to be. The seed was
     * written to localStorage on every save and never read back, so a reload
     * always produced a brand new world and any world you had grown was gone
     * with no way back to it except the address bar. Opt in, because the whole
     * point of the default is that every visit is somewhere new. */
    try {
      if (localStorage.getItem('hortus.remember') === '1') {
        var saved = localStorage.getItem('hortus.seed');
        if (saved) return saved;
      }
    } catch (e) { /* private mode */ }
    /* A fresh seed per visit, but still shown and still reproducible. */
    var words = ['hortus', 'terra', 'abyss', 'mycelium', 'vellum', 'orchard', 'lumen', 'silt',
                 'thallus', 'cinder', 'brine', 'sable', 'lichen', 'moraine', 'estuary'];
    var w = words[Math.floor(Math.random() * words.length)];
    return w + '-' + Math.floor(Math.random() * 900 + 100);
  }

  /* ═══════════════════════════════════════════════════════ world setup */

  App.newWorld = function (seed, opts) {
    opts = opts || {};
    var t0 = performance.now();
    App.seed = seed;

    /* remembered so preserveUserBindings can rescue the user's own defines
     * after the new interpreter is built (see the note there) */
    App._prevInterp = App.interp;

    App.world = new HX.World({ seed: seed, w: opts.w || 220, h: opts.h || 140 });
    App.eco = new HX.Ecosystem(App.world, {
      speciesCount: opts.speciesCount || 5,
      population: opts.population || 480
    });

    /* The set of names a freshly-installed interpreter has before the user has
     * typed anything. Cached after the first install; builtins and stdlib are
     * deterministic, so this is stable for the life of the program.
     *
     * The bindings live in Env.vars, NOT on the Env object itself — iterating
     * the Env with for..in yields its internals (parent, vars) and never a user
     * binding, and assigning to it creates a property that no lookup will ever
     * see. Getting this wrong looks exactly like "the feature does nothing". */
  var _baselineVars = null;

  /* Carry the user's own (define ...) bindings across a world reset.
   *
   * Every reset used to build a brand-new interpreter, which silently threw
   * away everything the user had defined — the `(reset-world! "x")` call in one
   * of the bundled examples does exactly that, so following it silently
   * unbroke your own program.
   *
   * Copying EVERY binding would be much worse: the stdlib closures captured the
   * old world and eco, so `(day)` would keep reporting the clock of a world that
   * no longer exists while everything else referred to the new one. Only names
   * the baseline does not contain are the user's, and those are safe to move. */
  App.preserveUserBindings = function (from, to) {
    if (!from || !from.global || !from.global.vars) return 0;
    var src = from.global.vars, kept = 0;
    for (var name in src) {
      if (_baselineVars && Object.prototype.hasOwnProperty.call(_baselineVars, name)) continue;
      to.global.define(name, src[name]);
      kept++;
    }
    return kept;
  };

  App.interp = new HX.Interp({ stepBudget: 4000000 });
    HX.builtins.install(App.interp);
    HX.stdlib.install(App.interp, {
      world: App.world,
      eco: App.eco,
      focus: function (x, y, z) { App.focusOn(x, y, z); },
      highlight: function (a) { App.highlight = a; },
      setChannel: function (m) {
        var idx = Palette.VIEWS.map(function (v) { return v.key; }).indexOf(m);
        if (idx >= 0) App.setView(idx);
      },
      reset: function (s) { App.newWorld(s || App.seed); }
    });
    if (!_baselineVars) {
      _baselineVars = {};
      var srcVars = App.interp.global.vars || {};
      for (var bk in srcVars) {
        if (Object.prototype.hasOwnProperty.call(srcVars, bk)) _baselineVars[bk] = 1;
      }
    } else {
      App.preserveUserBindings(App._prevInterp, App.interp);
    }
    App._prevInterp = null;
    App.editor.setEnv(App.interp.global);

    App.hookEvents();
    App.genMs = Math.round(performance.now() - t0);

    if (!App.renderer) App.initRenderer();
    App.applyUrlSettings();
    App.renderer.resize();
    App.renderer.fitWorld(App.world);

    /* Release everything bound to the world being replaced, BEFORE building the new
     * one. The four chart canvases are reused across worlds, so the previous
     * charts must let go of their hover listeners or the count grows by two per
     * reset and every mouse move over a chart redraws one stale chart per world
     * ever loaded. */
    if (App.charts) {
      for (var ck in App.charts) if (App.charts[ck].dispose) App.charts[ck].dispose();
    }
    App.lineage = new HX.ui.Lineage(App.dom.lineage, App.eco);
    App.charts = {
      pop: new HX.ui.Chart(App.dom.chartPop, { showSeasons: true }),
      veg: new HX.ui.Chart(App.dom.chartVeg, { showSeasons: true }),
      energy: new HX.ui.Chart(App.dom.chartEnergy, {}),
      biome: new HX.ui.Chart(App.dom.chartBiome, { yMax: 1 })
    };
    App.charts.pop.setSeries([
      { key: 'grazers', colour: '#7ef0c8', width: 1.7 },
      { key: 'stalkers', colour: '#ff6b5c', width: 1.7 },
      { key: 'pop', colour: 'rgba(160,180,215,0.45)', width: 1, fill: 'rgba(120,150,200,0.06)' }
    ]);
    App.charts.veg.setSeries([
      { key: 'veg', colour: '#8fd46a', width: 1.7, fill: 'rgba(120,200,90,0.10)' },
      { key: 'rain', colour: '#6cd0ff', width: 1.2 }
    ]);
    App.charts.energy.setSeries([
      { key: 'energy', colour: '#ffb05c', width: 1.7 },
      { key: 'score', colour: '#b48cff', width: 1.2 }
    ]);
    App.charts.biome.setSeries([]);

    App.speciesPanel = new HX.ui.SpeciesPanel(App.dom.species, function (id) {
      App.focusSpecies(id);
    });
    /* Stale per-world state. `highlight` is an Agent from the world being thrown
     * away, and the renderers only check highlight.alive — which is still true
     * — so the old world's highlight kept drawing a ring on a meaningless cell of
     * the new one. The selection ring and the log panel had the same problem:
     * the previous world's rows stayed above the new world's forever. */
    App.highlight = null;
    App.renderer.settings.selection = null;
    App.dom.log.innerHTML = '';
    App.logPanel = new HX.ui.LogPanel(App.dom.log, App.eco);
    App.inspector = new HX.ui.Inspector(App.dom.inspector);
    App.inspector.render();

    App.dom.hudSeed.textContent = 'seed ' + seed;
    /* Deliberately NOT clearing viewOverlay here. initRenderer runs earlier in
     * this same call and writes the "WebGL2 unavailable — using Canvas2D"
     * notice into that element; newWorld used to wipe it about thirty lines
     * later, so the message was destroyed before it could ever be painted, and
     * the manual's promise that you "will be told which happened" was false.
     * initRenderer clears the overlay itself when WebGL2 is available. */

    App.refreshBiomeChart();
    App.uiDirty = true;
    App.pushNote('world "' + seed + '" generated in ' + App.genMs + ' ms');
  };

  /* ═══════════════════════════════════════════════════════ renderer */

  App.initRenderer = function () {
    var canvas = App.dom.view;
    /* ?renderer=canvas2d forces the fallback. Two reasons it exists: the CPU
       path is a claimed feature ("fully simulated either way"), so it has to be
       reachable on demand to be worth the maintenance, and there is otherwise
       no way to look at it on a machine where WebGL2 happens to work. */
    var forced = /[?&]renderer=canvas2d/.test(location.search);
    var r = forced ? { ok: false, error: new Error('forced by ?renderer=canvas2d') }
                   : new HX.Renderer(canvas);
    if (r.ok) {
      App.renderer = r;
      App.rendererKind = 'webgl2';
      /* clear any notice a previous fallback attempt or fatal error left behind */
      App.dom.viewOverlay.classList.remove('is-shown', 'is-fatal');
      App.dom.viewOverlay.textContent = '';
      return;
    }
    /* fall back, and say so */
    var r2 = new HX.Renderer2D(canvas);
    App.renderer = r2;
    App.rendererKind = 'canvas2d';
    var msg = 'WebGL2 unavailable — using the Canvas2D renderer.\n\n' +
      (r.error ? r.error.message : 'unknown reason') + '\n\nThe world is fully simulated either way.';
    App.dom.viewOverlay.textContent = msg;
    App.dom.viewOverlay.classList.add('is-shown');
    if (global.console) console.warn('[HORTUS]', msg);
  };

  /* ═══════════════════════════════════════════════════════ events */

  App.hookEvents = function () {
    var eco = App.eco;
    /* The log panel takes log events. The lineage plot does NOT: it used to push
     * the newest history sample here as well as on the 'history' event, so
     * every sample arrived twice, and since the plot positioned points by array
     * index rather than by day the duplicated entries stretched the time axis
     * non-linearly and manufactured flat runs — which a viewer reads as
     * "extinction gaps". The manual's central claim about that plot was
     * unsupportable because of this line. */
    eco.emitter.on('log', function (e) {
      App.logPanel.push(e);
    });
    eco.emitter.on('extinct', function (sp) {
      App.audio && App.audio.extinction();
      App.toast(sp.name + ' is extinct');
    });
    eco.emitter.on('revive', function (sp) {
      App.audio && App.audio.revival();
      App.toast(sp.name + ' returns');
    });
    /* A new fitness record is worth hearing immediately. It also has to mark the
     * hall of fame dirty, or the sidebar keeps showing the previous best until
     * the user happens to resize the window. */
    eco.emitter.on('record', function () {
      App.audio && App.audio.blip(660, 0.2, 'sine', 0.02);
      App.uiDirty = true;
    });
    eco.emitter.on('history', function (s) {
      App.lineage.push(s);
    });
    var prevSeason = eco.world.time.season;
    /* There is no 'season' event — nothing in world.js emits one — so the season
     * change is polled. Polling needs a lifetime, or N world resets leave N live
     * 400ms timers, each holding a stale prevSeason from a world that no longer
     * exists but each reading the CURRENT App.world. Five resets meant five
     * overlapping four-note figures on every season turn. Clear the old one
     * before starting a new one. */
    if (App._seasonWatch) clearInterval(App._seasonWatch);
    App._seasonWatch = setInterval(function () {
      if (!App.world) return;
      var s = App.world.time.season;
      if (s !== prevSeason) {
        prevSeason = s;
        App.audio && App.audio.season(s);
      }
    }, 400);
  };

  /* Renderer settings can be overridden from the query string, e.g.
   *   ?set=grain:0,bloom:0,scanline:0
   * Bisecting a rendering artefact by rebuilding and re-screenshotting is
   * otherwise absurdly slow, and it is a genuinely useful thing to be able to
   * do. Unknown keys are reported rather than silently ignored. */
  App.applyUrlSettings = function () {
    var m = /[?&]set=([^&]*)/.exec(location.search);
    if (!m || !App.renderer || !App.renderer.settings) return;
    var st = App.renderer.settings;
    m[1].split(',').forEach(function (pair) {
      var kv = pair.split(':');
      if (kv.length !== 2) return;
      var k = kv[0], v = parseFloat(kv[1]);
      if (k in st) st[k] = v;
      else if (global.console) console.warn('[HORTUS] unknown renderer setting "' + k + '"');
    });
  };

  /* ═══════════════════════════════════════════════════════ main loop */

  App.loop = function (now) {
    requestAnimationFrame(App.loop);
    var fps = App.clock.tick(now);
    var dt = Math.min(0.1, (now - (App._last || now)) / 1000);
    App._last = now;

    /* ---- simulation ---- */
    if (App.running && App.world) {
      App.dayAccum += App.speed * dt;
      var days = Math.floor(App.dayAccum);
      if (days > 0) {
        App.dayAccum -= days;
        if (days > App.maxDaysPerFrame) {
          /* Cap the work per frame so a slow renderer cannot spiral, but keep
             * the unsimulated remainder instead of discarding it — bounded, so
             * an enormous slider value cannot build an unpayable debt. */
          App.dayAccum = Math.min(App.dayAccum + (days - App.maxDaysPerFrame), App.maxCarry);
          days = App.maxDaysPerFrame;
        }
        /* Capture BEFORE ticking, and sonify AFTER, so the log entries and death
         * counts this frame's ticks just produced are the ones that get played.
         * See replayAudioEvents. */
        var logBefore = App.eco.log.length;
        var deathsBefore = App.eco.deaths;
        var stormBefore = App.world.weather.storm;
        for (var i = 0; i < days; i++) App.eco.tick(1);
        App.replayAudioEvents(logBefore, deathsBefore, stormBefore);
        /* The species list, lineage graph and hall of fame only ever refreshed
         * off uiDirty, which is set by button presses, AXIOM runs and window
         * resizes — never by the simulation itself. The panel therefore showed
         * the state of the world on the first frame for the entire run: after
         * eighteen hundred simulated days the top bar read generation 194 while
         * every species card in the sidebar still said gen 0. Watching evolution
         * is the whole point of the program, so the panels have to follow the
         * sim. update() is already throttled to 0.5s, so this costs nothing. */
        App.uiDirty = true;
      }
    }

    if (!App.world) return;

    /* ---- sun ---- */
    /* stats() sweeps every cell of the map. It used to be called once for the
     * sun and again inside the audio block, two full sweeps of a 30 800-cell
     * grid per frame, both reading the same instant. Measure once. */
    var st = App.world.stats();
    Palette.updateSun(App.world.time.dayFrac, App.world.weather, st.temp);

    /* ---- render ---- */
    if (App.renderer) {
      App.renderer.resize();
      App.renderer.draw(App.world, App.eco, {
        time: now / 1000,
        highlight: App.highlight
      });
    }

    /* ---- audio ---- */
    if (App.audio && App.audio.started) {
      /* snapshot() walks every agent and sweeps the grid again. */
      var snap = App.eco.snapshot();
      /* The mean energy is a 0..energyCap figure, and Audio.update clamps it
       * into 0..1. The old expression multiplied by energyCap and divided by
       * it again, cancelling to a raw 0..100 value that clamped to 1.0
       * permanently — so the population-mood sonification the audio module
       * advertises never varied at all. */
      var eCap = HX.Ecosystem.CFG.energyCap;
      var meanE = (snap.meanEnergy[0] + snap.meanEnergy[1]) * 0.5 / eCap;
      App.audio.update({
        temp: st.temp,
        rain: App.world.weather.rain,
        wind: App.world.weather.wind,
        vegSaturation: st.vegSaturation,
        meanEnergy: snap.pop ? U.clamp01(meanE) : 0.4,
        population: Math.min(1, snap.pop / 700),
        dayFrac: App.world.time.dayFrac,
        night: Palette.Sun.isNight
      }, dt);
      App.audio._resetDeathBudget();
    }

    /* ---- instruments ---- */
    App.uiTimer = (App.uiTimer || 0) + dt;
    if (App.uiTimer > 0.12) {
      App.uiTimer = 0;
      App.updateBar(fps);
      App.drawDial();
    }
    App.chartTimer = (App.chartTimer || 0) + dt;
    if (App.chartTimer > 0.25) {
      App.chartTimer = 0;
      App.updateCharts();
    }
    App.inspTimer = (App.inspTimer || 0) + dt;
    if (App.inspTimer > 0.5) {
      App.inspTimer = 0;
      App.inspector.refresh();
      if (App.uiDirty) { App.speciesPanel.update(App.eco, App.world); App.updateHall(); App.uiDirty = false; }
    }
  };

/* Sonify what just happened. This used to be called with a log length captured
     * immediately BEFORE renderer.draw(), and draw() never appends to eco.log —
     * so log.length === from every frame, the loop never ran, and the birth,
     * death and thunder voices in the audio engine had no call site at all. The
     * audio module advertised "events: births, deaths, seasons, extinctions,
     * lightning" and only seasons and extinctions ever sounded.
   *
   * It has to run right after the ticks, which is where new log entries and new
   * death counts actually appear.
   *
   * Deaths are driven off the counter rather than the log, because nothing ever
   * wrote a log entry for one. Audio.death() throttles itself to three per
   * frame, which is exactly right: a mass extinction should not be a wall of
   * noise. */
  App.replayAudioEvents = function (fromLog, deathsBefore, stormsBefore) {
    if (!App.audio || !App.audio.started) return;
    var log = App.eco.log;
    for (var i = fromLog; i < log.length; i++) {
      var e = log[i];
      if (e.kind !== 'birth') continue;
      /* extinct/revive have their own cues from the emitter hooks; 'program'
       * entries come from the REPL, which already made the sound that caused
       * them, so all three are skipped here */
      App.audio.birth(e.sp < 0 ? 0 : e.sp, 0.6);
    }
    var died = App.eco.deaths - deathsBefore;
    if (died > 0) App.audio.death(died);
    var storm = App.world.weather.storm;
    if (storm > 0.35 && stormsBefore <= 0.35) App.audio.thunder(storm);
  };

  /* ═══════════════════════════════════════════════════════ bar & HUD */

  App.updateBar = function (fps) {
    var w = App.world, eco = App.eco;
    var d = this.dom;
    d.statYear.textContent = 'Y' + w.time.year;
    d.statDay.textContent = 'd' + w.time.day;
    d.statSeason.textContent = w.time.seasonName;
    d.statPop.textContent = eco.totalPop;
    d.statGraze.textContent = eco.counts[0];
    d.statStalk.textContent = eco.counts[1];
    d.statGen.textContent = eco.maxGeneration;
    d.statFps.textContent = Math.round(fps);

    d.hudTile.textContent = (App.renderer ? App.renderer.camera.scale.toFixed(1) : '0') + ' px / cell';
    d.hudAgents.textContent = (App.renderer ? App.renderer.stats.agents : eco.totalPop) + ' creatures';

    var c = App.mouseCell;
    if (c && c.i >= 0) {
      var cell = w.cell(c.i);
      d.hudBiome.textContent = cell.col + ',' + cell.row + ' \u00b7 ' + cell.biomeName;
    } else {
      d.hudBiome.textContent = w.stats().dominantBiomeName + ' dominant';
    }
    var W = w.weather;
    d.hudWeather.textContent = W.rain > 0.55 ? 'storm' : W.rain > 0.25 ? 'rain'
      : W.rain > 0.08 ? 'drizzle' : 'clear';
  };

  /* A small dial showing time of day and season: the sky indicator nobody has
   * to read numbers for. */
  App.drawDial = function () {
    var c = this.dom.dial;
    if (!c) return;
    var ctx = c.getContext('2d');
    var w = c.width, h = c.height;
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 3;
    ctx.clearRect(0, 0, w, h);

    /* outer ring: the year */
    var seasons = ['#7ef0c8', '#ffd76a', '#ff9a5c', '#7fa8ff'];
    for (var i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.strokeStyle = seasons[i];
      ctx.lineWidth = 2;
      ctx.globalAlpha = App.world.time.season === i ? 1 : 0.22;
      ctx.arc(cx, cy, R, -Math.PI / 2 + i * Math.PI / 2 + 0.06, -Math.PI / 2 + (i + 1) * Math.PI / 2 - 0.06);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* inner disc: the sun, arcing across the top by day */
    var f = App.world.time.dayFrac;
    var ang = (f - 0.25) * Math.PI * 2;
    var sx = cx + Math.sin(ang) * R * 0.55;
    var sy = cy - Math.cos(ang) * R * 0.55;
    ctx.beginPath();
    ctx.fillStyle = Palette.Sun.isNight ? '#5a6b9a' : '#ffd76a';
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fill();
    if (!Palette.Sun.isNight) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,215,106,0.18)';
      ctx.arc(sx, sy, 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
    ctx.stroke();
  };

  /* ═══════════════════════════════════════════════════════ charts */

  App.updateCharts = function () {
    var h = App.eco.history;
    var samples = h.length > 1400 ? h.slice(h.length - 1400) : h;

    App.charts.pop.setSamples(samples);
    App.charts.pop.draw();
    App.charts.veg.setSamples(samples);
    App.charts.veg.draw();
    App.charts.energy.setSamples(samples);
    App.charts.energy.draw();
    App.charts.biome.draw();
    /* The lineage plot was constructed and pushed to every frame but never
     * drawn: there was no call site for Lineage.prototype.draw anywhere in the
     * application, so the canvas kept its default 300x150 backing store and was
     * stretched by CSS into a blank rectangle — while the manual twice told the
     * reader to watch it. It belongs in the same 4 Hz refresh as the charts. */
    App.lineage.draw();
  };

  App.refreshBiomeChart = function () {
    var hist = App.world.biomeHistogram();
    var series = [];
    for (var i = 0; i < hist.length; i++) {
      if (hist[i] <= 0) continue;
      var share = hist[i] / App.world.grid.size;
      if (share < 0.005) continue;
      var col = Palette.BIOME_COLOURS[i].accent;
      series.push({
        key: 'b' + i,
        colour: 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')',
        width: Math.max(3, 260 * share)
      });
    }
    /* The bar chart draws itself from drawBiomeBars, so the series only supply the
     * legend colours. The old code also built a `sample` object that was never
     * used, stored `origDraw` that was never called, and assigned
     * App._biomeHist that nothing ever read. */
    App.charts.biome.setSeries(series);
    App.charts.biome.draw = function () { App.drawBiomeBars(); };
  };

  App.drawBiomeBars = function () {
    var c = this.dom.chartBiome;
    var f = HX.ui.fitCanvas(c);
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var hist = App.world.biomeHistogram();
    var total = App.world.grid.size;
    var entries = [];
    for (var i = 0; i < hist.length; i++) {
      if (hist[i] <= 0) continue;
      entries.push({ i: i, n: hist[i], pct: hist[i] / total });
    }
    entries.sort(function (a, b) { return b.n - a.n; });
    var padL = 4, padR = 40, padT = 4, padB = 4;
    var iw = w - padL - padR, ih = h - padT - padB;
    var rowH = Math.max(3, Math.min(11, ih / Math.max(1, entries.length)));
    ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (var k = 0; k < entries.length; k++) {
      var e = entries[k];
      var y = padT + k * rowH;
      var bar = e.pct * iw;
      var col = Palette.BIOME_COLOURS[e.i].base;
      ctx.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')';
      ctx.fillRect(padL, y, Math.max(1, bar), rowH - 1.4);
      ctx.fillStyle = 'rgba(200,215,240,0.62)';
      ctx.textAlign = 'left';
      ctx.fillText(HX.biomeName(e.i), padL + 3, y + (rowH - 1.4) / 2);
      ctx.fillStyle = 'rgba(160,180,215,0.5)';
      ctx.textAlign = 'right';
      ctx.fillText((e.pct * 100).toFixed(1) + '%', w - padR + 34, y + (rowH - 1.4) / 2);
    }
  };

  /* ═══════════════════════════════════════════════════════ hall of fame */

  App.updateHall = function () {
    var eco = App.eco;
    var rows = [];
    for (var i = 0; i < eco.species.length; i++) {
      if (eco.species[i].record) rows.push({ sp: eco.species[i], rec: eco.species[i].record });
    }
    rows.sort(function (a, b) { return b.rec.score - a.rec.score; });
    var html = rows.map(function (r) {
      var col = Palette.speciesCss(r.sp.id);
      return '<div class="hall-row">' +
        '<span class="hall-dot" style="width:6px;height:6px;border-radius:50%;background:' + col + ';display:inline-block"></span>' +
        '<span><span class="hall-name">' + r.rec.name + '</span> ' +
        '<span class="hall-ep">' + r.rec.epithet + '</span>' +
        '<div class="hall-meta">' + U.truncate(r.sp.name, 18) + ' &middot; gen ' + r.rec.generation +
        ' &middot; ' + r.rec.offspring + ' young &middot; ' + r.rec.kills + ' kills' +
        ' &middot; died of ' + (r.rec.cause || 'unknown') + '</div></span>' +
        '<span class="hall-score">' + Math.round(r.rec.score) + '</span>' +
        '</div>';
    }).join('');
    App.dom.hall.innerHTML = html || '<div class="empty">Nothing has died yet. Give it time.</div>';
  };

  /* ═══════════════════════════════════════════════════════ interaction */

  App.setView = function (idx) {
    if (App.renderer && App.renderer.settings) App.renderer.settings.mode = idx;
    U.$$('#views button').forEach(function (b, i) {
      b.classList.toggle('is-on', i === idx);
    });
  };

  App.setTool = function (tool) {
    App.tool = tool;
    U.$$('.tool').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.tool === tool);
    });
    App.dom.view.className = 'tool-' + tool;
  };

  App.focusOn = function (x, y, zoom) {
    var world = App.world;
    var row = Math.round(y);
    var col = Math.round(x);
    App.renderer.centreOn(col + 0.5 * (row & 1), row * 0.75, zoom ? App.renderer.camera.scale * zoom : null);
  };

  App.focusSpecies = function (id) {
    var eco = App.eco;
    var list = eco.agents.filter(function (a) { return a.alive && a.sp === id; });
    if (!list.length) { App.toast('that lineage is extinct'); return; }
    var a = list[Math.floor(list.length / 2)];
    var world = App.world;
    App.focusOn(world.grid.px[a.cell], world.grid.py[a.cell], 2.4);
    App.inspector.setAgent(a, eco, world);
    App.switchInstTab('agent');
  };

  App.bindStaticUI = function () {
    var d = this.dom;

    /* ---- view mode buttons ---- */
    Palette.VIEWS.forEach(function (v, i) {
      var b = document.createElement('button');
      b.textContent = v.name.toUpperCase();
      b.title = v.hint;
      b.addEventListener('click', function () { App.setView(i); });
      d.views.appendChild(b);
    });
    App.setView(0);
    d.views.firstChild.classList.add('is-on');

    /* ---- tools ---- */
    U.$$('.tool').forEach(function (b) {
      b.addEventListener('click', function () {
        App.setTool(b.dataset.tool === 'fit' ? App.tool : b.dataset.tool);
        if (b.dataset.tool === 'fit') App.renderer.fitWorld(App.world);
      });
    });
    App.setTool('pan');

    /* ---- transport ---- */
    var play = document.getElementById('btn-play');
    play.addEventListener('click', function () {
      App.running = !App.running;
      play.innerHTML = App.running ? '&#10074;&#10074;' : '&#9654;';
      play.classList.toggle('is-on', !App.running);
    });
    App.playBtn = play;

    document.getElementById('btn-step').addEventListener('click', function () {
      App.eco.tick(1);
      App.uiDirty = true;
    });

    d.speed.addEventListener('input', function () {
      App.speed = parseInt(d.speed.value, 10);
      d.speedOut.textContent = App.speed + '/d';
    });
    d.speedOut.textContent = App.speed + '/d';

    document.getElementById('btn-run').addEventListener('click', function () { App.runProgram(); });
    document.getElementById('btn-clear').addEventListener('click', function () {
      d.programOut.innerHTML = '';
    });

    /* ---- audio ---- */
    App.audio = new HX.AudioEngine({ volume: 0.5 });
    var ab = document.getElementById('btn-audio');
    ab.addEventListener('click', function () {
      if (!App.audio.started) {
        var ok = App.audio.start();
        App.toast(ok ? 'audio on' : 'audio unavailable in this browser');
      } else {
        App.audio.setMuted(!App.audio.muted);
      }
      ab.classList.toggle('is-on', App.audio.started && !App.audio.muted);
    });

    /* ---- screenshot ---- */
    document.getElementById('btn-shot').addEventListener('click', function () {
      var url = App.renderer && App.renderer.screenshot();
      if (!url) { App.toast('screenshot failed'); return; }
      U.download('hortus-' + App.seed + '-day' + App.world.time.day + '.png', url, 'image/png');
      App.toast('saved a PNG');
    });

    /* ---- keep this world across reloads ----
     * Off by default: every visit generating somewhere new is the point. When
     * switched on, the seed is remembered so a reload returns you to the world
     * you were growing instead of replacing it silently. */
    var keep = document.getElementById('btn-keep');
    var keepOn = false;
    try { keepOn = localStorage.getItem('hortus.remember') === '1'; } catch (err) { keepOn = false; }
    var paintKeep = function () {
      keep.classList.toggle('is-on', keepOn);
      keep.setAttribute('aria-pressed', keepOn ? 'true' : 'false');
      keep.title = keepOn
        ? 'This world will return after a reload. Click to forget it.'
        : 'Keep this world: return to it after a reload';
    };
    paintKeep();
    keep.addEventListener('click', function () {
      keepOn = !keepOn;
      try {
        if (keepOn) { localStorage.setItem('hortus.remember', '1'); localStorage.setItem('hortus.seed', App.seed); }
        else localStorage.removeItem('hortus.remember');
      } catch (err) { /* private mode: the button just does nothing */ }
      paintKeep();
      App.toast(keepOn ? 'this world will return after a reload' : 'each reload will be a new world');
    });

    /* ---- manual ---- */
    HX.MANUAL.render(d.manualBody);
    document.getElementById('btn-manual').addEventListener('click', function () { d.manual.hidden = false; });
    document.getElementById('manual-close').addEventListener('click', function () { d.manual.hidden = true; });
    d.manual.addEventListener('click', function (e) { if (e.target === d.manual) d.manual.hidden = true; });

    /* ---- panels toggle (narrow screens) ---- */
    document.getElementById('btn-panel').addEventListener('click', function () {
      d.paneInst.classList.toggle('is-shown');
    });

    /* ---- tabs ---- */
    U.$$('#code-tabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { App.switchCodeTab(b.dataset.tab); });
    });
    U.$$('#inst-tabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { App.switchInstTab(b.dataset.itab); });
    });

    /* ---- editor ---- */
    App.editor = new HX.Editor({
      root: d.editor,
      onRun: function () { App.runProgram(); },
      onChange: function () { App.saveProgram(); },
      value: EXAMPLES_FIRST()
    });

    /* ---- examples ---- */
    this.bindExamples();

    /* ---- repl ---- */
    d.replField.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { App.replSubmit(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { App.replNav(1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { App.replNav(-1); e.preventDefault(); }
    });

    /* ---- canvas interaction ---- */
    this.bindCanvas();

    /* ---- keys ---- */
    global.addEventListener('keydown', function (e) { App.onKey(e); });
    global.addEventListener('resize', function () {
      App.renderer && App.renderer.resize();
      App.uiDirty = true;
    });
  };

  function EXAMPLES_FIRST() {
    return HX.EXAMPLES.length ? HX.EXAMPLES[0].src : '; AXIOM\n';
  }

  App.bindExamples = function () {
    var sel = this.dom.exampleSelect;
    var list = this.dom.examples;
    HX.EXAMPLES.forEach(function (ex, i) {
      var o = document.createElement('option');
      o.value = ex.id;
      o.textContent = ex.title;
      sel.appendChild(o);

      var card = document.createElement('div');
      card.className = 'ex-card';
      card.innerHTML =
        '<div class="ex-head"><span class="ex-title">' + ex.title + '</span>' +
        '<span class="ex-tag">' + ex.tag + '</span></div>' +
        '<div class="ex-desc">' + ex.desc + '</div>' +
        '<div class="ex-src is-hidden"><pre>' + global.HX.highlight(ex.src, null) + '</pre></div>' +
        '<div class="ex-actions"><button class="btn btn-primary">LOAD</button>' +
        '<button class="btn">RUN</button>' +
        '<button class="btn">COPY</button></div>';
      var src = card.querySelector('.ex-src');
      var head = card.querySelector('.ex-head');
      head.addEventListener('click', function () {
        src.classList.toggle('is-hidden');
        card.classList.toggle('is-open');
      });
      var btns = card.querySelectorAll('.ex-actions .btn');
      btns[0].addEventListener('click', function () {
        App.editor.setValue(ex.src);
        App.saveProgram();
        App.toast('loaded "' + ex.title + '"');
      });
      btns[1].addEventListener('click', function () {
        App.editor.setValue(ex.src);
        App.saveProgram();
        App.runProgram();
      });
      btns[2].addEventListener('click', function () {
        try {
          navigator.clipboard.writeText(ex.src);
          App.toast('copied');
        } catch (err) { App.toast('clipboard blocked'); }
      });
      list.appendChild(card);
    });

    sel.addEventListener('change', function () {
      var ex = HX.EXAMPLES.filter(function (e) { return e.id === sel.value; })[0];
      if (ex) { App.editor.setValue(ex.src); App.saveProgram(); }
    });
  };

  App.switchCodeTab = function (name) {
    U.$$('#code-tabs .tab').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.tab === name);
    });
    this.dom.tabProgram.classList.toggle('is-hidden', name !== 'program');
    this.dom.tabRepl.classList.toggle('is-hidden', name !== 'repl');
    this.dom.tabExamples.classList.toggle('is-hidden', name !== 'examples');
    if (name === 'repl') setTimeout(function () { App.dom.replField.focus(); }, 30);
  };

  App.switchInstTab = function (name) {
    U.$$('#inst-tabs .tab').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.itab === name);
    });
    ['species', 'charts', 'agent', 'log'].forEach(function (k) {
      var el = document.getElementById('itab-' + k);
      if (el) el.classList.toggle('is-hidden', k !== name);
    });
    if (name === 'charts') App.updateCharts();
  };

  /* ═══════════════════════════════════════════════════════ canvas input */

  /* Pointer Events rather than mouse events. bindCanvas used mousedown/mousemove/
     * mouseup, which a touchscreen never fires, so the layout adapted to phone
     * widths while the world view itself was completely inert — the one region
     * of the interface that could not be touched at all. Pointer events cover
     * mouse, touch and pen with one set of handlers, and give us the extra
     * pointers needed for pinch-to-zoom, which wheel zoom has no equivalent of. */
  App.bindCanvas = function () {
    var canvas = this.dom.view;
    var self = this;
    var dragging = false, moved = 0, lastX = 0, lastY = 0;
    var active = {};          /* pointerId -> {x, y} */
    var pinchDist = 0;

    canvas.addEventListener('pointerdown', function (e) {
      active[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(active);
      if (ids.length === 1) {
        dragging = true; moved = 0;
        lastX = e.clientX; lastY = e.clientY;
      } else if (ids.length === 2) {
        /* second finger: start a pinch, and stop treating it as a pan/click */
        dragging = false;
        pinchDist = App._pointerSpan(active);
      }
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      e.preventDefault();
    });

    global.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'touch') self.mouseCell = self.cellAtScreen(e.clientX, e.clientY);
      if (!self.renderer) return;
      if (!active[e.pointerId] && !dragging) return;
      if (active[e.pointerId]) active[e.pointerId] = { x: e.clientX, y: e.clientY };

      var ids = Object.keys(active);
      if (ids.length >= 2 && pinchDist > 0) {
        var span = App._pointerSpan(active);
        if (span > 0 && pinchDist > 0) {
          var r = canvas.getBoundingClientRect();
          var mid = App._pointerMid(active);
          self.renderer.zoomAt(span / pinchDist, mid.x - r.left, mid.y - r.top);
          self.dom.viewHint.classList.add('is-gone');
        }
        pinchDist = span;
        return;
      }

      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX; lastY = e.clientY;
      if (self.tool === 'pan' || (e.buttons & 4)) {
        self.renderer.camera.x -= dx / self.renderer.camera.scale;
        self.renderer.camera.y += dy / self.renderer.camera.scale;
      }
    });

    function endPointer(e) {
      var wasDragging = dragging && Object.keys(active).length === 1;
      delete active[e.pointerId];
      if (Object.keys(active).length < 2) pinchDist = 0;
      if (!wasDragging) { dragging = false; return; }
      dragging = false;
      /* a drag that never really moved is a tap */
      if (moved > 6) return;
      self.onCanvasClick(e);
    }
    global.addEventListener('pointerup', endPointer);
    global.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('wheel', function (e) {
      if (!App.renderer) return;
      e.preventDefault();
      var r = canvas.getBoundingClientRect();
      var f = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      App.renderer.zoomAt(f, e.clientX - r.left, e.clientY - r.top);
      App.dom.viewHint.classList.add('is-gone');
    }, { passive: false });

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  };

  App._pointerSpan = function (active) {
    var ids = Object.keys(active);
    if (ids.length < 2) return 0;
    var a = active[ids[0]], b = active[ids[1]];
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  App._pointerMid = function (active) {
    var ids = Object.keys(active);
    var a = active[ids[0]], b = active[ids[1]];
    return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
  };

  App.cellAtScreen = function (clientX, clientY) {
    if (!App.renderer) return null;
    var r = App.dom.view.getBoundingClientRect();
    var w = App.renderer.screenToWorld(clientX - r.left, clientY - r.top);
    var c = App.renderer.worldToCell(w.x, w.y);
    var i = App.world.grid.idx(c.col, c.row);
    return { i: i, col: c.col, row: c.row, world: w };
  };

  App.onCanvasClick = function (e) {
    var hit = this.cellAtScreen(e.clientX, e.clientY);
    if (!hit || hit.i < 0) return;
    this.dom.viewHint.classList.add('is-gone');
    var world = this.world, eco = this.eco;

    switch (this.tool) {
      case 'inspect': {
        var a = eco.pick(hit.col, hit.row);
        if (a) {
          this.highlight = a;
          this.inspector.setAgent(a, eco, world);
          this.renderer.settings.selection = { col: hit.col, row: hit.row };
          this.switchInstTab('agent');
        } else {
          this.toast(hit.col + ',' + hit.row + ' \u00b7 ' + world.cell(hit.i).biomeName + ' \u00b7 nothing here');
          this.renderer.settings.selection = null;
          this.highlight = null;
        }
        break;
      }
      case 'blight':
        world.scorchAt(hit.i, 2, 0.85);
        eco.emit('event', { type: 'scorch', cell: hit.i });
        eco.logEvent('blight at ' + hit.col + ',' + hit.row, 'program');
        this.renderer.settings.selection = { col: hit.col, row: hit.row };
        break;
      case 'bloom':
        world.bloomAt(hit.i, 2, 0.7);
        eco.logEvent('a bloom at ' + hit.col + ',' + hit.row, 'program');
        this.renderer.settings.selection = { col: hit.col, row: hit.row };
        break;
      case 'quake':
        world.raiseAt(hit.i, 3, 0.10);
        eco.logEvent('the ground lifts at ' + hit.col + ',' + hit.row, 'program');
        this.renderer.settings.selection = { col: hit.col, row: hit.row };
        break;
      default:
        this.renderer.settings.selection = { col: hit.col, row: hit.row };
    }
  };

  /* ═══════════════════════════════════════════════════════ AXIOM */

  App.runProgram = function () {
    var src = this.editor.getValue();
    if (!src.trim()) { this.pushNote('nothing to run'); return; }
    var out = this.dom.programOut;
    this.pushEcho('$ ' + U.truncate(src.trim(), 46).replace(/\n/g, ' ') + (src.split('\n').length > 2 ? '\u2026' : ''));

    var t0 = performance.now();
    var forms, res;
    try {
      forms = R.read(src);
    } catch (e) {
      this.pushError(e.message || String(e));
      return;
    }
    try {
      res = this.interp.run(forms, this.interp.global, { collect: true });
    } catch (e) {
      this.pushError(e.message || String(e));
      return;
    }
    var ms = (performance.now() - t0).toFixed(1);

    if (res.output) {
      out.innerHTML += '<div class="c-ok">' + escapeHtml(res.output) + '</div>';
    }
    var shown = res.results.filter(function (v) { return !this.interp.isSilent(v); }, this);
    if (shown.length) {
      var text = shown.map(function (v) { return R.inspect(v, 4); }).join('\n');
      out.innerHTML += '<div class="c-val">' + escapeHtml(text) + '</div>';
    }
    if (res.error) {
      this.pushError(res.error.message || String(res.error));
      out.innerHTML += '<div class="c-warn">' + res.steps.toLocaleString('en-US') +
        ' evaluations in ' + ms + ' ms' + (res.error.axiom ? '' : ' \u2014 this was an internal error') + '</div>';
      if (global.console) global.console.warn('[AXIOM]', res.error);
    } else {
      this.pushNote(U.fmtInt(res.steps) + ' evaluations in ' + ms + ' ms');
    }
    out.scrollTop = out.scrollHeight;
    this.uiDirty = true;
    this.saveProgram();
  };

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  App.pushEcho = function (s) {
    this.dom.programOut.innerHTML += '<div class="c-echo">' + escapeHtml(s) + '</div>';
    this.dom.programOut.scrollTop = this.dom.programOut.scrollHeight;
  };
  App.pushNote = function (s) {
    this.dom.programOut.innerHTML += '<div class="c-note">' + escapeHtml(s) + '</div>';
  };
  App.pushError = function (s) {
    this.dom.programOut.innerHTML += '<div class="c-err">' + escapeHtml(s) + '</div>';
    this.dom.programOut.scrollTop = this.dom.programOut.scrollHeight;
  };

  App.replSubmit = function () {
    var f = this.dom.replField;
    var src = f.value.trim();
    if (!src) return;
    /* The submitted line goes into replLines, NOT into replNav. Those two used to
     * share one name: replNav was a function, and this code treated it as an
     * array, so replHistory.length read the function's arity (1) and
     * replHistory.splice was undefined. That threw a TypeError *before* the
     * try block below, so every single REPL submission died — while the 68
     * smoke tests passed, because they call interp.run directly and never
     * touch this path. */
    var lines = this.replLines;
    if (this.replIdx === undefined) this.replIdx = lines.length;
    lines.splice(this.replIdx, 0, src);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
    this.replIdx = lines.length;
    f.value = '';

    var line = '<div class="repl-line repl-in">ax&gt; ' + escapeHtml(src) + '</div>';
    this.dom.repl.innerHTML += line;
    var out = this.dom.repl;

    var forms, res;
    var interp = this.interp;
    try {
      forms = R.read(src);
      res = interp.run(forms, interp.global, { collect: true });
    } catch (e) {
      out.innerHTML += '<div class="repl-line repl-err">' + escapeHtml(e.message || String(e)) + '</div>';
      out.scrollTop = out.scrollHeight;
      return;
    }
    if (res.output) {
      out.innerHTML += '<div class="repl-line repl-out">' + escapeHtml(res.output) + '</div>';
    }
    /* `interp`, not the module-global App.interp. The run above is made against
     * the receiver's interpreter, so asking the global one whether a value is
     * silent is a bug waiting for the day anything rebinds. */
    var shown = res.results.filter(function (v) { return !interp.isSilent(v); });
    if (shown.length) {
      out.innerHTML += '<div class="repl-line repl-val">' +
        escapeHtml(shown.map(function (v) { return R.inspect(v, 4); }).join('\n')) + '</div>';
    }
    if (res.error) {
      out.innerHTML += '<div class="repl-line repl-err">' + escapeHtml(res.error.message) + '</div>';
    }
    out.scrollTop = out.scrollHeight;
    this.uiDirty = true;
  };

  /* Arrow-key navigation over previously submitted lines. Reads replLines, writes
   * the cursor into replIdx. */
  App.replNav = function (dir) {
    var f = this.dom.replField;
    var lines = this.replLines;
    if (!lines.length) return;
    var i = (this.replIdx === undefined ? lines.length : this.replIdx) + dir;
    i = U.clamp(i, 0, lines.length);
    this.replIdx = i;
    f.value = lines[i] || '';
    setTimeout(function () {
      f.setSelectionRange(f.value.length, f.value.length);
    }, 0);
  };

  /* ═══════════════════════════════════════════════════════ keys */

  App.onKey = function (e) {
    /* Ctrl+Enter and Ctrl+/ work from anywhere, including the canvas. They are
     * documented as global shortcuts and the RUN button's own tooltip says
     * "Ctrl+Enter", but the modifier guard below used to run first and return,
     * so they only ever fired while the AXIOM textarea happened to have focus.
     * Text fields are excluded from every OTHER binding, not from these. */
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === 'Enter') { e.preventDefault(); App.runProgram(); return; }
      if (e.key === '/') { e.preventDefault(); App.editor.toggleComment(); return; }
    }
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ': e.preventDefault(); this.playBtn.click(); break;
      case '.': this.eco.tick(1); this.uiDirty = true; break;
      case 'f': case 'F': this.renderer && this.renderer.fitWorld(this.world); break;
      case 'm': case 'M': document.getElementById('btn-audio').click(); break;
      case '?': this.dom.manual.hidden = !this.dom.manual.hidden; break;
      case 'Escape': this.dom.manual.hidden = true; break;
      default:
        if (/^[1-6]$/.test(e.key)) this.setView(parseInt(e.key, 10) - 1);
    }
  };

  /* ═══════════════════════════════════════════════════════ misc */

  App.toast = function (msg) {
    var t = this.dom.toast;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    var self = this;
    this._toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  };

  App.saveProgram = U.throttle(function () {
    try {
      localStorage.setItem('hortus.program', App.editor.getValue());
      localStorage.setItem('hortus.seed', App.seed);
    } catch (e) { /* private mode; not important */ }
  }, 900);

  App.loadProgram = function () {
    try {
      var p = localStorage.getItem('hortus.program');
      if (p) App.editor.setValue(p);
      return true;
    } catch (e) { return false; }
  };

  global.HORTUS = App;

  /* ============================================================ failures */

  /*
   * A silent exception in this app is the worst possible outcome: the world
   * would simply stop moving and nobody would know why. Everything that can
   * fail during startup or rendering is surfaced in the middle of the view.
   */
  function fatal(msg, detail) {
    var overlay = document.getElementById('view-overlay');
    if (overlay) {
      overlay.textContent = msg + (detail ? '\n\n' + detail : '');
      /* a dead program warrants the full scrim; a renderer fallback does not */
      overlay.classList.add('is-fatal', 'is-shown');
    }
    if (global.console) global.console.error('[HORTUS]', msg, detail || '');
  }
  global.addEventListener('error', function (e) {
    fatal('runtime error: ' + (e.message || 'unknown'),
      (e.filename || '') + (e.lineno ? ':' + e.lineno : ''));
  });
  global.addEventListener('unhandledrejection', function (e) {
    fatal('unhandled rejection', String(e.reason && e.reason.message || e.reason));
  });

  if (typeof document !== 'undefined' && document.getElementById('boot-go')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { bootSequence(App); });
    } else {
      bootSequence(App);
    }
  }

  /* Exposed so the wiring can be tested. Every bug worth writing a test for
     * lived in this file's glue — the REPL threw on every submission, boot()
     * could run twice, the lineage plot was never drawn — and none of them were
     * reachable from the smoke suite, which exercises the modules directly and
     * never touches App. */
  global.HX = global.HX || {};
  global.HX.App = App;

  /* ═══════════════════════════════════════════════════════ boot text */

  /* Auto-start is used by the headless smoke test, and is also handy for
   embedding the page in a screenshot pipeline. */
  function wantsAutoStart() {
    return /[?&]auto=1/.test(location.search);
  }

  function bootSequence(app) {
    var out = document.getElementById('boot-text');
    var btn = document.getElementById('boot-go');
    var lines = [
      { t: 'HORTUS', c: 'hi' },
      { t: 'a machine for growing worlds', c: 'dim' },
      { t: '' },
      { t: 'initialising...', c: '' }
    ];
    var i = 0;

    function next() {
      if (i >= lines.length) {
        btn.hidden = false;
        return;
      }
      var l = lines[i++];
      var el = document.createElement('span');
      if (l.c) el.className = l.c;
      el.textContent = l.t + '\n';
      out.appendChild(el);
      setTimeout(next, 90);
    }

    function start() {
      try {
        app.boot();
        var loaded = app.loadProgram();
        out.innerHTML += '<span class="dim">seed </span><span class="ok">' + app.seed + '</span>\n';
        out.innerHTML += '<span class="dim">renderer </span><span class="ok">' + app.rendererKind + '</span>\n';
        if (loaded) out.innerHTML += '<span class="dim">program restored from this browser\n</span>';
        out.innerHTML += '<span class="ok">ready. press ? for the manual.</span>\n';
        btn.textContent = 'ENTER THE GARDEN';
        app.started = true;
        /* audio may only start from a gesture */
        app.audio.start();
        document.getElementById('btn-audio').classList.add('is-on');
      } catch (e) {
        out.innerHTML += '\n<span style="color:#ff6b5c">startup failed: ' +
          escapeHtml((e && e.message) || String(e)) + '</span>\n';
        out.innerHTML += '<span class="dim">' + escapeHtml(String((e && e.stack) || '').split('\n').slice(0, 6).join('\n')) + '</span>\n';
        if (global.console) global.console.error(e);
      }
    }

    /* Build the world first so the boot text can report real numbers. */
    setTimeout(function () {
      try {
        var w = new HX.World({ seed: '(warming up)' });
        w.eco = null;
        lines = [
          { t: 'HORTUS', c: 'hi' },
          { t: 'a machine for growing worlds', c: 'dim' },
          { t: '' },
          { t: 'seeded terrain \u2014 ' + (w.w * w.h) + ' cells', c: 'ok' },
          { t: (w.coverage.land * 100).toFixed(0) + '% land, ' + w.riverCells + ' river cells, ' +
               (w.biomeHistogram().filter(function (x) { return x > 0; }).length) + ' biomes', c: '' },
          { t: 'compiling AXIOM', c: 'ok' },
          { t: 'growing ' + '5 lineages', c: '' },
          { t: '' }
        ];
      } catch (e) { /* the real boot will report the failure properly */ }
      next();
    }, 60);

    btn.addEventListener('click', function () {
      btn.hidden = true;
      document.getElementById('boot').classList.add('is-gone');
      setTimeout(function () {
        var b = document.getElementById('boot');
        if (b) b.style.display = 'none';
      }, 800);
      start();
      setTimeout(function () {
        if (!app.dom || !app.dom.viewHint) return;
        app.dom.viewHint.classList.remove('is-gone');
        setTimeout(function () {
          if (app.dom && app.dom.viewHint) app.dom.viewHint.classList.add('is-gone');
        }, 7000);
      }, 900);
    });

    /* Enter key also starts it, for people who never look for buttons.
     * The listener detaches on the FIRST keydown of any kind, not just on an
     * Enter that happens to match — otherwise starting by mouse click left it
     * attached permanently, which is what let a stray Enter re-boot the app. */
    document.addEventListener('keydown', function once(e) {
      document.removeEventListener('keydown', once);
      if (e.key === 'Enter') btn.click();
    });

    if (wantsAutoStart()) setTimeout(function () { btn.click(); }, 700);
  }

})(typeof window !== 'undefined' ? window : globalThis);