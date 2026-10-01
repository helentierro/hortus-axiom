/* ============================================================================
 * HORTUS / ui/panels.js
 *
 * Instrument panels. Each one is a small class with a `update(data)` method
 * and a `draw()` for anything canvas-based.
 *
 * The rule for all of them: never lay out from scratch every frame. Panels
 * throttle to ~8 Hz and only touch the DOM when a value has actually changed,
 * because a dozen panels rebuilding their innerHTML at 60 Hz is the single
 * easiest way to make a smooth simulation feel like it is stuttering.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;
  var G = global.HX.Genome;
  var Palette = global.HX.Palette;

  /* ---------------------------------------------------------------- utils */

  function fitCanvas(canvas, dprCap) {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(global.devicePixelRatio || 1, dprCap || 2);
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: rect.width, h: rect.height, dpr: dpr };
  }

  function fmt(n, dp) { return U.fmt(n, dp); }

  /* ================================================================ Chart */

  /*
   * A multi-series line chart with a shared time axis. Written by hand rather
   * than with a library because the interesting part is the interaction: the
   * crosshair reports the value of every series at the hovered sample, which is
   * how you actually read a boom-bust cycle.
   */
  function Chart(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.series = [];
    this.samples = [];
    this.xKey = opts.xKey || 'day';
    this.yMax = opts.yMax || 100;
    this.yMin = 0;
    this.autoMax = opts.autoMax !== false;
    this.hover = null;
    this.onHover = opts.onHover || null;
    this.yLabel = opts.yLabel || '';
    this._bind();
  }

  /* Named handlers and a dispose(). Every world reset builds four new Chart
     * objects on the SAME four canvases, so without this the canvases accumulate
     * 2 listeners per reset, and each one redraws its own now-orphaned chart on
     * hover — so moving the mouse over a chart costs one draw per world the user
     * has ever loaded. */
  Chart.prototype._bind = function () {
    var self = this;
    this._onMove = function (e) {
      var r = self.canvas.getBoundingClientRect();
      self.hover = U.clamp01((e.clientX - r.left) / r.width);
      if (self.onHover) self.onHover(self.hoverX());
      self.draw();
    };
    this._onLeave = function () {
      self.hover = null;
      if (self.onHover) self.onHover(null);
      self.draw();
    };
    this.canvas.addEventListener('mousemove', this._onMove);
    this.canvas.addEventListener('mouseleave', this._onLeave);
  };

  Chart.prototype.dispose = function () {
    if (!this._onMove) return;
    this.canvas.removeEventListener('mousemove', this._onMove);
    this.canvas.removeEventListener('mouseleave', this._onLeave);
    this._onMove = null;
    this._onLeave = null;
  };

  Chart.prototype.setSeries = function (series) { this.series = series; };
  Chart.prototype.setSamples = function (s) { this.samples = s; };

  Chart.prototype.hoverX = function () {
    if (!this.samples.length || this.hover === null) return null;
    var i = Math.round(this.hover * (this.samples.length - 1));
    return this.samples[U.clamp(i, 0, this.samples.length - 1)];
  };

  Chart.prototype.draw = function () {
    var f = fitCanvas(this.canvas);
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);

    var padL = 34, padR = 8, padT = 8, padB = 16;
    var iw = w - padL - padR, ih = h - padT - padB;
    if (iw <= 0 || ih <= 0) return;

    /* y range */
    var max = this.yMax, min = this.yMin;
    if (this.autoMax) {
      max = 0.0001;
      for (var s = 0; s < this.samples.length; s++) {
        var smp = this.samples[s];
        for (var k = 0; k < this.series.length; k++) {
          var v = smp[this.series[k].key];
          if (typeof v === 'number' && v > max) max = v;
        }
      }
      max *= 1.12;
    }

    /* grid */
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var g = 0; g <= 4; g++) {
      var y = padT + ih * (g / 4);
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(padL + iw, y + 0.5);
    }
    for (var gx = 0; gx <= 4; gx++) {
      var x = padL + iw * (gx / 4);
      ctx.moveTo(x + 0.5, padT);
      ctx.lineTo(x + 0.5, padT + ih);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(190,205,230,0.5)';
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmt(max), padL - 4, padT + 4);
    ctx.fillText(fmt(min), padL - 4, padT + ih - 4);

    if (!this.samples.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(190,205,230,0.28)';
      ctx.fillText('awaiting data', padL + iw / 2, padT + ih / 2);
      return;
    }

    var n = this.samples.length;
    var X = function (i) { return padL + iw * (n === 1 ? 0.5 : i / (n - 1)); };
    var Y = function (v) { return padT + ih * (1 - (v - min) / (max - min)); };

    /* season bands behind the lines */
    if (this.showSeasons) {
      for (var i2 = 0; i2 < n; i2++) {
        var sn = this.samples[i2];
        if (i2 === 0 || sn.season !== this.samples[i2 - 1].season) {
          var bw = i2 === n - 1 ? X(n - 1) - X(i2) : X(i2 + 1) - X(i2);
          ctx.fillStyle = ['rgba(140,200,140,0.05)', 'rgba(220,200,110,0.05)',
                           'rgba(200,140,90,0.05)', 'rgba(120,150,220,0.06)'][sn.season] || 'rgba(255,255,255,0.02)';
          ctx.fillRect(X(i2), padT, Math.max(0, bw), ih);
        }
      }
    }

    for (var si = 0; si < this.series.length; si++) {
      var ser = this.series[si];
      ctx.beginPath();
      var started = false;
      for (var j = 0; j < n; j++) {
        var val = this.samples[j][ser.key];
        if (typeof val !== 'number') continue;
        var px = X(j), py = Y(U.clamp(val, min, max));
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = ser.colour;
      ctx.lineWidth = ser.width || 1.6;
      ctx.lineJoin = 'round';
      if (ser.fill) {
        ctx.lineTo(X(n - 1), padT + ih);
        ctx.lineTo(X(0), padT + ih);
        ctx.closePath();
        ctx.fillStyle = ser.fill;
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }

    /* crosshair */
    if (this.hover !== null && n > 1) {
      var hi = U.clamp(Math.round(this.hover * (n - 1)), 0, n - 1);
      var hx = X(hi);
      ctx.strokeStyle = 'rgba(160,230,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx + 0.5, padT);
      ctx.lineTo(hx + 0.5, padT + ih);
      ctx.stroke();
      for (var si2 = 0; si2 < this.series.length; si2++) {
        var ser2 = this.series[si2];
        var v2 = this.samples[hi][ser2.key];
        if (typeof v2 !== 'number') continue;
        ctx.beginPath();
        ctx.arc(hx, Y(U.clamp(v2, min, max)), 2.6, 0, Math.PI * 2);
        ctx.fillStyle = ser2.colour;
        ctx.fill();
      }
    }
  };

  /* =============================================================== Species */

  function SpeciesPanel(root, onSelect) {
    this.root = root;
    this.onSelect = onSelect || function () {};
    this.cards = [];
    this._lastKey = '';
  }

  SpeciesPanel.prototype.update = function (eco, world) {
    var key = eco.species.map(function (s) {
      return s.id + ':' + s.count + ':' + s.generation + ':' + s.revivals;
    }).join('|') + '#' + eco.totalPop + '#' + eco.maxGeneration;
    if (key === this._lastKey) return;
    this._lastKey = key;

    var html = '';
    for (var i = 0; i < eco.species.length; i++) {
      var s = eco.species[i];
      var col = Palette.speciesCss(s.id);
      var maxPeak = 1;
      for (var j = 0; j < eco.species.length; j++) maxPeak = Math.max(maxPeak, eco.species[j].peakPop);
      var pct = Math.round(s.count / maxPeak * 100);
      var extinct = s.count === 0;
      html += '<div class="sp-card' + (extinct ? ' extinct' : '') + '" data-sp="' + s.id + '">' +
        '<div class="sp-dot" style="background:' + col + '"></div>' +
        '<div class="sp-body">' +
        '<div class="sp-name">' + U.truncate(s.name, 22) +
          '<span class="sp-kind">' + global.HX.KIND_NAMES[s.kind] + '</span></div>' +
        '<div class="sp-row"><span class="sp-pop">' + s.count + '</span>' +
          '<span class="sp-meta">peak ' + s.peakPop +
          ' &middot; gen ' + s.generation +
          (s.revivals ? ' &middot; returned ' + s.revivals + '\u00d7' : '') +
          '</span></div>' +
        '<div class="sp-bar"><i style="width:' + pct + '%;background:' + col + '"></i></div>' +
        '</div></div>';
    }
    this.root.innerHTML = html;
    var self = this;
    U.$$('.sp-card', this.root).forEach(function (el) {
      el.addEventListener('click', function () { self.onSelect(parseInt(el.dataset.sp, 10)); });
    });
  };

  /* ============================================================= Inspector */

  /* Shows one agent: identity, body, genome against its species mean, and the
     brain's weight map. The "against the species mean" framing is the whole
     point — a trait value alone tells you nothing; whether it is unusually
     large for its lineage is the interesting question. */
  function Inspector(root) {
    this.root = root;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'insp-brain';
    root.appendChild(this.canvas);
    this.brainCtx = this.canvas.getContext('2d');
    this.agent = null;
    this._lastKey = '';
  }

  Inspector.prototype.setAgent = function (agent, eco, world) {
    this.agent = agent;
    this.eco = eco;
    this.world = world;
    this._lastKey = '';
    this.render();
  };

  Inspector.prototype.refresh = function () {
    var a = this.agent;
    if (!a) return;
    var key = a.id + ':' + a.id + ':' + Math.round(a.energy) + ':' + a.age.toFixed(0) +
      ':' + a.state + ':' + a.cell;
    if (key === this._lastKey) return;
    this._lastKey = key;
    this.render();
  };

  Inspector.prototype.render = function () {
    var a = this.agent;
    var body = this.root;
    if (!a) {
      body.innerHTML = '<div class="empty">Click a creature to inspect it.</div>';
      this.canvas.style.display = 'none';
      return;
    }
    this.canvas.style.display = 'block';
    var eco = this.eco, world = this.world;
    var sp = eco.species[a.sp];
    var cell = world.cell(a.cell);
    var col = Palette.speciesCss(a.sp);

    /* species mean, for the comparison bars */
    var sums = {}, n = 0;
    for (var i = 0; i < eco.agents.length; i++) {
      var o = eco.agents[i];
      if (!o.alive || o.sp !== a.sp) continue;
      n++;
      for (var t = 0; t < G.TRAITS.length; t++) {
        sums[G.TRAITS[t].name] = (sums[G.TRAITS[t].name] || 0) + o.genome[t];
      }
    }

    var html = '<div class="insp-head">' +
      '<span class="insp-dot" style="background:' + col + '"></span>' +
      '<div><div class="insp-name">' + a.name + '</div>' +
      '<div class="insp-sub">' + global.HX.KIND_NAMES[a.kind] + ' &middot; ' + U.truncate(sp.name, 18) +
      ' &middot; generation ' + a.generation + '</div></div></div>';

    html += '<div class="insp-stats">' +
      stat('energy', a.energy.toFixed(0), ' / ' + eco.cfg.energyCap) +
      stat('age', a.age.toFixed(0), ' / ' + a.maxAge.toFixed(0)) +
      stat('offspring', a.offspring, '') +
      stat('kills', a.kills, '') +
      stat('meals', a.meals, '') +
      stat('fitness', a.score.toFixed(0), '') +
      '</div>';

    html += '<div class="insp-where">' +
      'at ' + cell.col + ',' + cell.row +
      ' &middot; ' + cell.biomeName +
      ' &middot; ' + U.fmt(cell.elev * 1000) + ' m' +
      ' &middot; ' + U.fmt(cell.temp * 30) + '&deg;C' +
      ' &middot; veg ' + U.fmt(cell.veg * 100, 0) + '%' +
      ' &middot; ' + a.state +
      '</div>';

    html += '<div class="insp-section">genome &mdash; bar shows this animal against its species mean</div><div class="trait-list">';
    for (var g = 0; g < G.TRAITS.length; g++) {
      var tr = G.TRAITS[g];
      var val = a.genome[g];
      var mean = n ? (sums[tr.name] / n) : val;
      var delta = val - mean;
      var dev = Math.abs(delta) > 0.22 ? (delta > 0 ? 'up' : 'down') : '';
      html += '<div class="trait" title="' + tr.grp + '">' +
        '<span class="trait-name">' + tr.name + '</span>' +
        '<span class="trait-bar"><i class="me" style="width:' + (mean * 100).toFixed(1) + '%"></i>' +
        '<i class="v" style="width:' + (val * 100).toFixed(1) + '%;background:' + col + '"></i></span>' +
        '<span class="trait-val ' + dev + '">' + (val).toFixed(2) + '</span>' +
        '</div>';
    }
    html += '</div>';

    html += '<div class="insp-section">controller &mdash; policy weights</div>';
    body.innerHTML = html;
    this.canvas.className = 'insp-brain';
    this.root.appendChild(this.canvas);
    this.drawBrain(a);
  };

  function stat(label, value, suffix) {
    return '<div class="stat"><div class="stat-v">' + value +
      '<span class="stat-s">' + suffix + '</span></div><div class="stat-l">' + label + '</div></div>';
  }

  Inspector.prototype.drawBrain = function (a) {
    var f = fitCanvas(this.canvas, 2);
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    if (w < 40 || h < 20) return;

    var Brain = global.HX.Brain;
    var L = Brain.layout();
    var pad = 6;
    var layerX = [pad + 4, w * 0.5, w - pad - 60];
    var inputH = h - pad * 2;
    var hiddenY = [], outY = [];
    for (var i = 0; i < L.IN; i++) hiddenY.push(pad + (i + 0.5) * inputH / L.IN);
    for (var j = 0; j < L.H; j++) outY.push(pad + (j + 0.5) * inputH / L.H);
    var nodeR = Math.min(3.2, inputH / L.IN * 0.34);

    /* input nodes */
    ctx.font = '8px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (var k = 0; k < L.IN; k++) {
      var y = hiddenY[k];
      ctx.fillStyle = 'rgba(190,210,235,0.55)';
      ctx.beginPath();
      ctx.arc(layerX[0], y, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(180,200,225,0.42)';
      ctx.fillText(Brain.INPUT_NAMES[k], layerX[0] - nodeR - 3, y);
    }
    /* hidden nodes */
    for (var m = 0; m < L.H; m++) {
      ctx.fillStyle = 'rgba(150,200,240,0.7)';
      ctx.beginPath();
      ctx.arc(layerX[1], outY[m], nodeR * 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
    /* output nodes */
    ctx.textAlign = 'left';
    for (var n2 = 0; n2 < L.OUT; n2++) {
      var oy = outY[n2];
      ctx.fillStyle = 'rgba(255,190,120,0.75)';
      ctx.beginPath();
      ctx.arc(layerX[2], oy, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(230,200,170,0.42)';
      ctx.fillText(Brain.OUT_NAMES[n2], layerX[2] + nodeR + 3, oy);
    }

    /* weights: positive warm, negative cool. Only edges above a magnitude
       threshold are drawn, or the diagram is a solid block of colour. */
    var bw = a.brain;
    ctx.lineCap = 'round';
    function edge(x1, y1, x2, y2, v) {
      var mag = Math.min(1, Math.abs(v) / 1.6);
      if (mag < 0.06) return;
      ctx.strokeStyle = v >= 0
        ? 'rgba(255,170,90,' + (mag * 0.50).toFixed(3) + ')'
        : 'rgba(90,180,255,' + (mag * 0.50).toFixed(3) + ')';
      ctx.lineWidth = 0.4 + mag * 1.9;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    for (var hh = 0; hh < L.H; hh++) {
      for (var ii = 0; ii < L.IN; ii++) {
        edge(layerX[0] + nodeR, hiddenY[ii], layerX[1] - nodeR * 1.15, outY[hh],
          bw[L.offW1 + hh * L.IN + ii]);
      }
    }
    for (var oo = 0; oo < L.OUT; oo++) {
      for (var m2 = 0; m2 < L.H; m2++) {
        edge(layerX[1] + nodeR * 1.15, outY[m2], layerX[2] - nodeR, outY[oo],
          bw[L.offW2 + oo * L.H + m2]);
      }
    }
  };

  /* =============================================================== Lineage */

  /*
   * A lineage plot: one lane per species, x = day, y = population, with a dot
   * wherever that species set a new fitness record. Gaps are where a species
   * died. This is the view that makes extinction events legible as part of a
   * story rather than as a line ending.
   */
  function Lineage(canvas, eco) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.eco = eco;
    this.log = [];      /* one entry per sample: {day, species:[counts], records:[]} */
    this.max = 4000;
    this.seenBest = null;
  }

  /* Which species improved their all-time fitness score since the previous
     sample. The history sample itself carries no per-species record, so the
     only place this can be known is here, while `bestScore` is still current. */
  Lineage.prototype._records = function () {
    var out = [];
    var species = this.eco.species;
    if (!this.seenBest || this.seenBest.length !== species.length) {
      this.seenBest = species.map(function (s) { return s.bestScore || 0; });
      return out;
    }
    for (var i = 0; i < species.length; i++) {
      var now = species[i].bestScore || 0;
      if (now > this.seenBest[i]) out.push(now);
      else out.push(0);
      this.seenBest[i] = now;
    }
    return out;
  };

  Lineage.prototype.push = function (sample) {
    this.log.push({
      day: sample.day,
      species: sample.species,
      records: this._records()
    });
    if (this.log.length > this.max) this.log.splice(0, 500);
  };

  Lineage.prototype.draw = function () {
    var f = fitCanvas(this.canvas);
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var log = this.log;
    if (log.length < 2) {
      ctx.fillStyle = 'rgba(190,205,230,0.3)';
      ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('lineage appears as the world is played', w / 2, h / 2);
      return;
    }
    var padL = 8, padR = 8, padT = 10, padB = 14;
    var iw = w - padL - padR, ih = h - padT - padB;
    var maxPop = 10;
    var dayMin = Infinity, dayMax = -Infinity;
    for (var i = 0; i < log.length; i++) {
      if (log[i].day < dayMin) dayMin = log[i].day;
      if (log[i].day > dayMax) dayMax = log[i].day;
      for (var j = 0; j < log[i].species.length; j++) maxPop = Math.max(maxPop, log[i].species[j]);
    }
    maxPop *= 1.1;
    var daySpan = Math.max(1, dayMax - dayMin);

    /* x is DAY, not array index. Positioning by index was fine while the plot
     * was never drawn, which is exactly why it went unnoticed: the sample
     * cadence is regular, so index and day happen to agree until an event
     * duplicates an entry — and then the axis silently stretches and the plot
     * stops meaning what its own caption claims it means. */
    var xOf = function (sample) {
      return padL + iw * U.clamp((sample.day - dayMin) / daySpan, 0, 1);
    };

    /* Season boundaries. The old condition was `(log[s].gen % 1) === 0 &&
     * s % 8 === 0`, and gen is always an integer, so `% 1 === 0` was always
     * true: the "season rules" were just "every eighth sample", and the
     * lastSeason variable it tested was never updated. Rules are now placed
     * where the year actually turns over. */
    var perYear = this.eco.world ? this.eco.world.daysPerYear : 160;
    if (perYear > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      var firstYear = Math.ceil(dayMin / perYear) * perYear;
      for (var yb = firstYear; yb <= dayMax; yb += perYear) {
        var bx = Math.round(padL + iw * (yb - dayMin) / daySpan) + 0.5;
        ctx.moveTo(bx, padT);
        ctx.lineTo(bx, padT + ih);
      }
      ctx.stroke();
    }

    var nSp = this.eco.species.length;
    for (var sp = 0; sp < nSp; sp++) {
      ctx.strokeStyle = Palette.speciesCss(sp, 0.85);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      var pen = false;
      for (var k = 0; k < log.length; k++) {
        var v = log[k].species[sp] || 0;
        var x = xOf(log[k]);
        var y = padT + ih * (1 - v / maxPop);
        if (v === 0) { pen = false; continue; }
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      /* A dot wherever this species set a new fitness record — the thing the
       * header comment above has always promised. */
      for (var m = 0; m < log.length; m++) {
        var rec = log[m].records && log[m].records[sp];
        if (!rec) continue;
        ctx.fillStyle = Palette.speciesCss(sp);
        ctx.beginPath();
        ctx.arc(xOf(log[m]), padT + ih * (1 - (log[m].species[sp] || 0) / maxPop), 2, 0, Math.PI * 2);
        ctx.fill();
      }
      /* label at the right edge */
      var last = log[log.length - 1].species[sp] || 0;
      if (last > 0) {
        ctx.fillStyle = Palette.speciesCss(sp);
        ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(U.truncate(this.eco.species[sp].name, 12), w - 2, padT + ih * (1 - last / maxPop) - 3);
      }
    }

    ctx.fillStyle = 'rgba(180,200,225,0.45)';
    ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('day ' + log[0].day, padL, h - 3);
    ctx.textAlign = 'right';
    ctx.fillText('day ' + log[log.length - 1].day, w - padR, h - 3);
    ctx.textAlign = 'left';
    ctx.fillText('peak ' + Math.round(maxPop / 1.1), padL, padT + 7);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(180,200,225,0.30)';
    ctx.fillText('dot = new record', w - padR, padT + 7);
  };

  /* ================================================================== Log */

  function LogPanel(root, eco) {
    this.root = root;
    this.eco = eco;
    this.count = 0;
  }

  LogPanel.prototype.push = function (entry) {
    var el = document.createElement('div');
    el.className = 'log-row log-' + entry.kind;
    var day = String(entry.day);
    el.innerHTML = '<span class="log-day">d' + day + '</span>' +
      '<span class="log-text">' + U.truncate(entry.text, 90) + '</span>';
    this.root.appendChild(el);
    this.count++;
    while (this.root.children.length > 90) this.root.removeChild(this.root.firstChild);
    this.root.scrollTop = this.root.scrollHeight;
  };

  global.HX = global.HX || {};
  global.HX.ui = global.HX.ui || {};
  global.HX.ui.Chart = Chart;
  global.HX.ui.SpeciesPanel = SpeciesPanel;
  global.HX.ui.Inspector = Inspector;
  global.HX.ui.Lineage = Lineage;
  global.HX.ui.LogPanel = LogPanel;
  global.HX.ui.fitCanvas = fitCanvas;

})(typeof window !== 'undefined' ? window : globalThis);