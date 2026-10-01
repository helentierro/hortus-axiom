/* ============================================================================
 * HORTUS / render/canvas2d.js
 *
 * The fallback path, and the reference for what the GPU version is supposed to
 * look like. It runs on the same world arrays and the same palette module, so
 * a machine without WebGL2 sees a coherent, if flatter, world rather than a
 * degraded one.
 *
 * Strategy: render the hex lattice into an ImageData at world resolution, then
 * blit it scaled with smoothing on. That is one putImageData plus one drawImage
 * regardless of zoom, which is far cheaper than drawing 30,000 hexes per frame.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;
  var Palette = global.HX.Palette;

  function Renderer2D(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ok = !!this.ctx;
    this.error = this.ok ? null : new Error('2D canvas unavailable');
    this.dpr = 1;
    this.width = 1; this.height = 1;
    this.camera = { x: 0, y: 0, scale: 6 };
    this.settings = {
      mode: 0, grid: 0, contour: 0, shade: 0.9, pointScale: 7,
      selection: null
    };
    this.buffer = null;
    this.bufferCtx = null;
    this.bufferW = 0; this.bufferH = 0;
    this.lastBiome = null;
    this.imageData = null;
    this.stats = { draws: 0, agents: 0 };
  }

  Renderer2D.prototype.resize = function () {
    /* Guarded, unlike the first version. Reassigning canvas.width reallocates
     * the backing store and clears it, and this is called every frame — the GPU
     * renderer has had this guard since the start (webgl.js resize). */
    var rect = this.canvas.getBoundingClientRect();
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (w === this.width && h === this.height && this.dpr === dpr) return;
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
  };

  Renderer2D.prototype.fitWorld = function (world) {
    var wU = world.w;
    var hU = (world.h - 1) * 0.75 + 1;
    this.camera.scale = Math.min(this.width / (wU + 2), this.height / (hU + 2));
    this.camera.x = wU * 0.5;
    this.camera.y = hU * 0.5;
  };

  Renderer2D.prototype.centreOn = function (x, y, scale) {
    if (scale) this.camera.scale = U.clamp(scale, 0.6, 120);
    this.camera.x = x;
    this.camera.y = y;
  };

  Renderer2D.prototype.zoomAt = function (factor, sx, sy) {
    var before = this.screenToWorld(sx, sy);
    this.camera.scale = U.clamp(this.camera.scale * factor, 0.6, 120);
    var after = this.screenToWorld(sx, sy);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
  };

  Renderer2D.prototype.screenToWorld = function (sx, sy) {
    var px = sx * this.dpr;
    var py = this.height - sy * this.dpr;
    return {
      x: this.camera.x + (px - this.width * 0.5) / this.camera.scale,
      y: this.camera.y + (py - this.height * 0.5) / this.camera.scale
    };
  };

  Renderer2D.prototype.worldToCell = function (wx, wy) {
    var row = Math.round(wy / 0.75);
    return { col: Math.round(wx - (row & 1) * 0.5), row: row };
  };

  Renderer2D.prototype._ensureBuffer = function (world) {
    /* The buffer is world.w + 1 columns wide, not world.w. Odd rows of an
       odd-r hex lattice sit half a cell to the right of even rows, and every
       other part of this renderer already places things at
       `col + 0.5 * (row & 1)` — the agent dots, the grid overlay and the
       selection ring. Baking the same half-cell offset into the image is what
       the GPU path does in _ensureShearMap; without it the terrain and the
       overlay are a half-cell apart everywhere, which reads as a rendering bug
       only if you know to look for it. */
    var W = world.w + 1;
    if (this.bufferW === W && this.bufferH === world.h) return;
    this.bufferW = W;
    this.bufferH = world.h;
    var c = global.document.createElement('canvas');
    c.width = W; c.height = world.h;
    this.buffer = c;
    this.bufferCtx = c.getContext('2d');
    this.imageData = this.bufferCtx.createImageData(W, world.h);
    this._colours = new Uint8ClampedArray(W * world.h * 3);
  };

  /* Bilinear-free: the image is at world resolution and scaled up with the
     browser's own smoothing, which is exactly the right filter for terrain. */
  Renderer2D.prototype.draw = function (world, eco, opts) {
    if (!this.ok) return;
    opts = opts || {};
    var ctx = this.ctx;
    var W = world.w, H = world.h;
    this._ensureBuffer(world);
    /* buffer width is w+1; cell (i,j) is written at column i + 0.5*(j&1) */
    var BW = this.bufferW;

    var px = this.imageData.data;
    var i, j, k, bx;

    /* Shade the world once, into a scratch array, because the same cell colour
       is needed for the blit and for the contour overlay. */
    var colours = this._colours;
    var mode = this.settings.mode | 0;
    var sun = Palette.Sun;
    var dayl = 0.28 + sun.daylight * 0.72;
    /* Mode 1 is "Chart": flat cartographic biomes with no relief shading and
       no vegetation tint. It used to fall through to the terrain branch, which
       made view 2 on this renderer pixel-identical to view 1 — and Palette.VIEWS
       lists Terrain then Chart, so the second view button did nothing at all.
       The shader gives it its own flat treatment, so match that. */
    var chart = mode === 1;
    /* Stress view must agree with shaders.js: scorch is weighted 0.9, not 1.0,
       and crowding contributes 0.25 — the fallback was missing it entirely. */
    var contourOn = this.settings.contour > 0.001 && mode === 1;
    var levels = 12;
    var elevMin = 1, elevMax = -1;
    if (contourOn) {
      for (i = 0; i < W * H; i++) {
        if (world.water[i] > 0.02) continue;
        var e = world.elev[i];
        if (e < elevMin) elevMin = e;
        if (e > elevMax) elevMax = e;
      }
      if (elevMax <= elevMin) { elevMax = elevMin + 1e-3; contourOn = false; }
    }

    for (i = 0; i < W; i++) {
      for (j = 0; j < H; j++) {
        k = i + j * W;
        bx = i + ((j & 1) ? 1 : 0) + j * BW;
        var rgb;
        if (mode >= 2) {
          rgb = Palette.rampColour(
            mode === 2 ? 'vegetation' : mode === 3 ? 'thermal' : mode === 4 ? 'water' : 'stress',
            mode === 2 ? world.veg[k] : mode === 3 ? (world.tempNow[k] || world.temp[k]) :
            mode === 4 ? world.water[k] :
            U.clamp01(world.flux[k] * 0.7 + world.scorch[k] * 0.9 + world.crowd[k] * 0.25)
          );
        } else if (world.water[k] > 0.02) {
          if (chart) {
            rgb = [16, 46, 78];
          } else {
            var d = world.water[k];
            rgb = [
              U.lerp(22, 4, U.smoothstep(0.05, 0.95, d)),
              U.lerp(62, 14, U.smoothstep(0.05, 0.95, d)),
              U.lerp(76, 34, U.smoothstep(0.05, 0.95, d))
            ];
          }
        } else if (chart) {
          var bc = Palette.BIOME_COLOURS[world.biome[k]] || Palette.BIOME_COLOURS[0];
          rgb = [bc.base[0], bc.base[1], bc.base[2]];
          if (world.snow[k] > 0.3) {
            var sa = world.snow[k] * 0.85;
            rgb = [U.lerp(rgb[0], 226, sa), U.lerp(rgb[1], 234, sa), U.lerp(rgb[2], 246, sa)];
          }
        } else {
          rgb = Palette.biomeShaded(world.biome[k], world.elev[k], world.veg[k]);
          if (world.snow[k] > 0.3) {
            var a = world.snow[k] * 0.85;
            rgb = [U.lerp(rgb[0], 226, a), U.lerp(rgb[1], 234, a), U.lerp(rgb[2], 246, a)];
          }
          if (world.flux[k] > 0.15) {
            rgb = [U.lerp(rgb[0], 130, 0.5), U.lerp(rgb[1], 190, 0.5), U.lerp(rgb[2], 210, 0.5)];
          }
        }
        if (contourOn) {
          /* darken on exact level crossings, quantised to `levels` bands */
          var frac = (world.elev[k] - elevMin) / (elevMax - elevMin) * levels;
          frac -= Math.floor(frac);
          if (frac < 0.12 || frac > 0.88) rgb = [rgb[0] * 0.72, rgb[1] * 0.72, rgb[2] * 0.72];
        }
        var g = Palette.grade(rgb, dayl, sun.ambient);
        colours[bx * 3] = g[0];
        colours[bx * 3 + 1] = g[1];
        colours[bx * 3 + 2] = g[2];
      }
    }

    /* blit */
    var out = px;
    for (i = 0, k = 0; i < BW * H; i++, k += 4) {
      out[k] = colours[i * 3];
      out[k + 1] = colours[i * 3 + 1];
      out[k + 2] = colours[i * 3 + 2];
      out[k + 3] = 255;
    }
    this.bufferCtx.putImageData(this.imageData, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, this.width, this.height);

    /* One place sets the camera transform, and every world-space draw goes
       through it. Previously the transform was applied to the blit, then
       restore() put the context back to identity, and the grid and the
       creatures were drawn with world coordinates interpreted as device
       pixels — so the entire population collapsed into a few dozen pixels in
       the top-left corner while the map looked fine. */
    var sc = this.camera.scale;
    this._camera(ctx);

    /* The buffer rows are already sheared; they are 0.75 apart in world units. */
    ctx.drawImage(this.buffer, 0, 0, BW, H * 0.75, 0, 0, BW, H * 0.75);

    /* hex grid overlay */
    if (this.settings.grid > 0.01 && sc > 6) {
      this._drawGrid(ctx, world, sc);
    }

    /* agents */
    this._drawAgents(ctx, eco, world, sc, opts.highlight);

    /* selection ring */
    if (this.settings.selection) {
      var sel = this.settings.selection;
      ctx.strokeStyle = 'rgba(140,230,255,0.95)';
      ctx.lineWidth = 2 / sc;
      ctx.beginPath();
      this._hexPath(ctx, sel.col + 0.5 * (sel.row & 1), sel.row * 0.75, 0.52);
      ctx.stroke();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.stats.draws++;
  };

  /* world units -> device pixels, y flipped.
     *
     * This must be the exact inverse of screenToWorld above, or a click maps to
     * a different cell than the one under the cursor. Inverting both axes:
     *
     *     sx = sc*(worldX - camera.x) + width/2      -> e = width/2 - sc*camera.x
     *     sy = sc*(camera.y - worldY) + height/2     -> f = height/2 + sc*camera.y
     *
     * Both terms were wrong before: e used `sc*camera.x - width/2`, which is the
     * negative of the correct value, and f used `1.5*height - sc*camera.y`,
     * a whole extra canvas height of offset. Note the y signs genuinely differ
     * from the x ones — that asymmetry is the y flip, not a typo. */
  Renderer2D.prototype._camera = function (ctx) {
    var sc = this.camera.scale;
    ctx.setTransform(sc, 0, 0, -sc,
      this.width * 0.5 - this.camera.x * sc,
      this.height * 0.5 + this.camera.y * sc);
  };

  Renderer2D.prototype._hexPath = function (ctx, cx, cy, r) {
    for (var i = 0; i < 6; i++) {
      var a = (Math.PI / 3) * i + Math.PI / 6;
      var x = cx + Math.cos(a) * r;
      var y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };

  /* The camera transform is already in force — draw() applies it once and this
     * runs inside that. It used to set its own transform here and restore()
     * afterwards, which is what silently discarded it. */
  Renderer2D.prototype._drawGrid = function (ctx, world, sc) {
    var W = world.w, H = world.h;
    var view = this._viewBounds(W, H, sc);
    ctx.strokeStyle = 'rgba(255,255,255,' + (this.settings.grid * 0.16) + ')';
    ctx.lineWidth = 1 / sc;
    ctx.beginPath();
    var r, c, x, y;
    /* every row owns every column: the odd-r shear shifts odd rows by half a
     * cell, it does not make them sparser. Stepping c by 2 skipped half of each
     * odd row's hexes. */
    for (r = view.r0; r <= view.r1; r++) {
      var par = r & 1;
      for (c = view.c0; c <= view.c1; c++) {
        x = c + 0.5 * par;
        y = r * 0.75;
        for (var i = 0; i < 6; i++) {
          var a = (Math.PI / 3) * i + Math.PI / 6;
          var px = x + Math.cos(a) * 0.5;
          var py = y + Math.sin(a) * 0.5;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();
  };

  Renderer2D.prototype._viewBounds = function (W, H, sc) {
    var halfW = this.width * 0.5 / sc;
    var halfH = this.height * 0.5 / sc;
    var c0 = Math.max(0, Math.floor(this.camera.x - halfW) - 1);
    var c1 = Math.min(W - 1, Math.ceil(this.camera.x + halfW) + 1);
    var r0 = Math.max(0, Math.floor((this.camera.y - halfH) / 0.75) - 1);
    var r1 = Math.min(H - 1, Math.ceil((this.camera.y + halfH) / 0.75) + 1);
    return { c0: c0, c1: c1, r0: r0, r1: r1 };
  };

  Renderer2D.prototype._drawAgents = function (ctx, eco, world, sc, highlight) {
    var grid = world.grid;
    var agents = eco.agents;
    var view = this._viewBounds(world.w, world.h, sc);
    var n = 0;
    /* Radii are in WORLD units, because the camera transform is in force. A
     * radius of 0.03 world units is a third of a hundredth of a pixel at the
     * default fit-the-whole-world zoom, so the population was invisible even
     * once the transform was fixed. Express it as a fraction of a cell: a hex
     * spans 1.0 unit, so 0.18 is a small but legible dot. */
    var pt = this.settings.pointScale;
    var base = U.clamp(0.10 + pt * 0.012, 0.06, 0.34);

    /* one pass per species so overlapping creatures blend rather than overwrite */
    for (var sp = 0; sp < eco.species.length; sp++) {
      ctx.fillStyle = Palette.speciesCss(sp, 0.9);
      ctx.beginPath();
      for (var i = 0; i < agents.length; i++) {
        var a = agents[i];
        if (!a.alive || a.sp !== sp) continue;
        var col = grid.col[a.cell], row = grid.row[a.cell];
        if (col < view.c0 || col > view.c1 || row < view.r0 || row > view.r1) continue;
        var x = col + 0.5 * (row & 1);
        var y = row * 0.75;
        var eFrac = U.clamp01(a.energy / eco.cfg.energyCap);
        var rr = base * (0.62 + eFrac * 0.38) * U.clamp(0.72 + a.tSize * 0.28, 0.6, 1.5);
        ctx.moveTo(x + rr, y);
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        n++;
      }
      ctx.fill();
    }
    this.stats.agents = n;

    if (highlight && highlight.alive) {
      var col2 = grid.col[highlight.cell], row2 = grid.row[highlight.cell];
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 / sc;
      ctx.beginPath();
      this._hexPath(ctx, col2 + 0.5 * (row2 & 1), row2 * 0.75, 0.55);
      ctx.stroke();
    }
  };

  Renderer2D.prototype.screenshot = function () {
    try { return this.canvas.toDataURL('image/png'); } catch (e) { return null; }
  };

  Renderer2D.prototype.dispose = function () {};

  global.HX = global.HX || {};
  global.HX.Renderer2D = Renderer2D;

})(typeof window !== 'undefined' ? window : globalThis);