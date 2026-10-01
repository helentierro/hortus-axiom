/* ============================================================================
 * HORTUS / render/webgl.js
 *
 * The GPU path. Six programs, four framebuffers, three data textures.
 *
 * Design decisions worth stating:
 *
 *  - WORLD DATA GOES IN AS THREE RGBA8 TEXTURES, rebuilt from the typed
 *    arrays each frame. 220x140 is 123 KB per texture; uploading is cheaper
 *    than any incremental scheme, and it means the renderer never has to know
 *    when the simulation changed.
 *
 *  - AGENTS ARE NOT A TEXTURE. They are real point sprites with a VBO, which
 *    gives free per-point size and colour, correct additive blending, and
 *    participation in the bloom pass without any extra machinery.
 *
 *  - EVERY FAILURE FALLS BACK. If WebGL2 is missing, or a shader fails to
 *    compile, or a framebuffer is incomplete, the renderer reports the reason
 *    and hands control to the Canvas2D path. The simulation must never die
 *    because of a driver.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;
  var S = global.HX.Shaders;
  var Palette = global.HX.Palette;

  /* --------------------------------------------------------------- helpers */

  function compile(gl, type, src, label) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      var lines = src.split('\n');
      var detail = '';
      var m = /ERROR:\s*\d+:(\d+)/.exec(log || '');
      if (m) {
        var ln = parseInt(m[1], 10);
        for (var i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 3); i++) {
          detail += '\n    ' + (i + 1) + ' | ' + lines[i];
        }
      }
      gl.deleteShader(sh);
      throw new Error('shader "' + label + '" failed to compile: ' + log + detail);
    }
    return sh;
  }

  function link(gl, vsSrc, fsSrc, label) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label + '.vert');
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + '.frag');
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('program "' + label + '" failed to link: ' + log);
    }
    /* Cache every active uniform location up front; getUniformLocation per
     * frame is a synchronous driver query and shows up in profiles. */
    var uniforms = {};
    var count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var info = gl.getActiveUniform(prog, i);
      var name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(prog, info.name);
    }
    return { prog: prog, u: uniforms };
  }

  function makeTarget(gl, w, h, filter) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('framebuffer incomplete (0x' + status.toString(16) + ')');
    }
    return { tex: tex, fbo: fbo, w: w, h: h };
  }

  function disposeTarget(gl, t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  /* ========================================================== Renderer ==== */

  function Renderer(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ok = false;
    this.error = null;
    this.dpr = 1;
    this.width = 1;
    this.height = 1;
    this.bloomScale = 4;

    this.camera = { x: 0, y: 0, scale: 6 };
    this.settings = {
      mode: 0,
      bloom: 0.80,
      aberration: 0.22,
      grain: 0.022,
      vignette: 0.52,
      exposure: 1.14,
      scanline: 0.014,
      grid: 0,
      contour: 0.0,
      debug: 0,
      shade: 0.9,
      pointScale: 7.0,
      selection: null
    };
    this.stats = { draws: 0, texUploads: 0, agents: 0, lastError: null };

    try {
      this._init();
      this.ok = true;
    } catch (e) {
      this.ok = false;
      this.error = e;
      if (global.console) console.error('[HORTUS renderer]', e);
    }
  }

  Renderer.prototype._init = function () {
    var gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,          // we do our own AA via the bloom/composite pass
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true   // so toDataURL can screenshot the canvas
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    this.progScene = link(gl, S.SCENE_VS, S.SCENE_FS, 'scene');
    this.progAgent = link(gl, S.AGENT_VS, S.AGENT_FS, 'agents');
    this.progBright = link(gl, S.QUAD_VS, S.BRIGHT_FS, 'bright');
    this.progBlur = link(gl, S.QUAD_VS, S.BLUR_FS, 'blur');
    this.progComposite = link(gl, S.QUAD_VS, S.COMPOSITE_FS, 'composite');

    /* An empty VAO is still required in WebGL2 core profile semantics for the
     * attribute-less full-screen triangle. */
    this.emptyVao = gl.createVertexArray();

    /* agent buffers */
    this.agentCapacity = 4096;
    this.agentPos = new Float32Array(this.agentCapacity * 2);
    this.agentData = new Float32Array(this.agentCapacity * 4);
    this.agentVao = gl.createVertexArray();
    gl.bindVertexArray(this.agentVao);
    this.agentPosBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.agentPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.agentPos.byteLength, gl.DYNAMIC_DRAW);
    var aPos = gl.getAttribLocation(this.progAgent.prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.agentDataBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.agentDataBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.agentData.byteLength, gl.DYNAMIC_DRAW);
    var aData = gl.getAttribLocation(this.progAgent.prog, 'aData');
    gl.enableVertexAttribArray(aData);
    gl.vertexAttribPointer(aData, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    /* species colour LUT */
    this.speciesTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.speciesTex);
    var lut = new Float32Array(16 * 3);
    for (var i = 0; i < 16; i++) {
      var c = Palette.speciesColour(i);
      lut[i * 3] = c[0] / 255;
      lut[i * 3 + 1] = c[1] / 255;
      lut[i * 3 + 2] = c[2] / 255;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 16, 1, 0, gl.RGBA, gl.FLOAT, lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    /* biome palette LUT: row 0 base, row 1 accent */
    this.biomeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.biomeTex);
    var bl = new Uint8Array(32 * 2 * 4);
    for (var b = 0; b < 32; b++) {
      var base = Palette.BIOME_COLOURS[Math.min(b, Palette.BIOME_COLOURS.length - 1)];
      bl[b * 4] = base.base[0]; bl[b * 4 + 1] = base.base[1]; bl[b * 4 + 2] = base.base[2]; bl[b * 4 + 3] = 255;
      var o = (32 + b) * 4;
      bl[o] = base.accent[0]; bl[o + 1] = base.accent[1]; bl[o + 2] = base.accent[2]; bl[o + 3] = 255;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 32, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, bl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.targets = null;
    this.resize();
  };

  /* ------------------------------------------------------------- resizing */

  Renderer.prototype.resize = function () {
    var gl = this.gl;
    if (!gl) return;
    var rect = this.canvas.getBoundingClientRect();
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (w === this.width && h === this.height) return;

    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    disposeTarget(gl, this.tScene);
    disposeTarget(gl, this.tBrightA);
    disposeTarget(gl, this.tBrightB);
    var bw = Math.max(1, Math.floor(w / this.bloomScale));
    var bh = Math.max(1, Math.floor(h / this.bloomScale));
    try {
      this.tScene = makeTarget(gl, w, h, gl.LINEAR);
      this.tBrightA = makeTarget(gl, bw, bh, gl.LINEAR);
      this.tBrightB = makeTarget(gl, bw, bh, gl.LINEAR);
    } catch (e) {
      /* Half-float-free linear filtering is guaranteed in WebGL2, so a failure
       * here means the driver is in a bad state; drop to no post-processing. */
      this.error = e;
      this.tBrightA = null;
      this.tBrightB = null;
      try { this.tScene = this.tScene || makeTarget(gl, w, h, gl.NEAREST); }
      catch (e2) { throw e2; }
    }
  };

  /* ------------------------------------------------------- world textures */

  /*
   * THE SHEAR PROBLEM.
   *
   * Cells in a row are one unit apart; cells in adjacent rows are 0.75 apart in
   * world units AND offset by half a cell horizontally. A texture of W x H
   * cannot represent that with plain bilinear filtering: sampling through the
   * lattice shear gives a half-texel error between rows, and the result is a
   * diagonal weave across the entire map that reads as "the terrain has a
   * pattern" rather than as a sampling bug.
   *
   * The fix is to bake the shear into the texture. Odd rows are written half a
   * texel to the right, into a texture one texel wider, so a world-space
   * lookup lands exactly on the right texel and LINEAR filtering interpolates
   * correctly within the lattice. After that the shader needs no shear maths at
   * all — which is also much cheaper per fragment.
   */
  Renderer.prototype._ensureShearMap = function (world) {
    var w = world.w, h = world.h;
    if (this._shearW === w && this._shearH === h) return;
    var texW = w + 1;
    var map = new Int32Array(w * h);
    for (var row = 0; row < h; row++) {
      var off = (row & 1);
      for (var col = 0; col < w; col++) {
        map[row * w + col] = row * texW + col + off;
      }
    }
    this._shearMap = map;
    this._texW = texW;
    this._shearW = w;
    this._shearH = h;
  };

  Renderer.prototype.uploadWorld = function (world) {
    var gl = this.gl;
    var n = world.grid.size;
    this._ensureShearMap(world);
    var texW = this._texW;
    var map = this._shearMap;
    /* texA is a 4-bytes-per-cell buffer, so the length to compare against is
     * texW * h * 4. The guard used to compare it against texW * h, which can
     * never be equal, so this ran on EVERY draw(): three Uint8Array allocations
     * (about 370 KB for a 220x140 map) plus three gl.createTexture calls per
     * frame, with the previous three textures never deleted. */
    if (!this.texA || this.texA.length !== texW * world.h * 4) {
      this._freeWorldTextures();
      this.texA = new Uint8Array(texW * world.h * 4);
      this.texB = new Uint8Array(texW * world.h * 4);
      this.texC = new Uint8Array(texW * world.h * 4);
      this._makeWorldTextures(world, texW);
    }
    var A = this.texA, B = this.texB, C = this.texC;
    var elev = world.elev, water = world.water, veg = world.veg, snow = world.snow;
    var temp = world.tempNow, moist = world.moist, biome = world.biome;
    var flux = world.flux, scorch = world.scorch, fert = world.fert, crowd = world.crowd;
    var precip = world.precip;
    var i, j;

    for (i = 0; i < n; i++) {
      j = map[i] * 4;
      /* elev is signed (land positive, sea floor negative); pack as 0.5 + e/2 */
      A[j] = (0.5 + elev[i] * 0.5) * 255;
      A[j + 1] = water[i] * 255;
      A[j + 2] = veg[i] * 255;
      A[j + 3] = snow[i] * 255;
      B[j] = (temp[i] || 0) * 255;
      B[j + 1] = biome[i];
      B[j + 2] = flux[i] * 255;
      B[j + 3] = scorch[i] * 255;
      C[j] = moist[i] * 255;
      C[j + 1] = fert[i] * 255;
      C[j + 2] = crowd[i] > 4 ? 255 : crowd[i] * 60;
      C[j + 3] = precip[i] * 255;
    }
    this.stats.texUploads++;
    this._uploadTexture(this.texA, 'texA', world, texW);
    this._uploadTexture(this.texB, 'texB', world, texW);
    this._uploadTexture(this.texC, 'texC', world, texW);
  };

  /* Releasing the GL textures matters exactly once the guard above can actually
     * fire, which is now that it fires at all: changing the world size, or
     * resetting the world, would otherwise orphan three textures every time. */
  Renderer.prototype._freeWorldTextures = function () {
    var gl = this.gl;
    if (!gl) return;
    for (var i = 0; i < 3; i++) {
      var key = ['texA', 'texB', 'texC'][i] + 'Tex';
      if (this[key]) { gl.deleteTexture(this[key]); this[key] = null; }
    }
  };

  Renderer.prototype._makeWorldTextures = function (world, texW) {
    var gl = this.gl;
    var H = world.h;
    var self = this;
    ['texA', 'texB', 'texC'].forEach(function (key) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, texW, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, self[key]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      /* CLAMP matters: without it, sampling past the map edge smears the
         first row all the way across the ocean. */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      self[key + 'Tex'] = t;
    });
  };

  Renderer.prototype._uploadTexture = function (data, key, world, texW) {
    var gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this[key + 'Tex']);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texW, world.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  };

  /* --------------------------------------------------------- agent upload */

  Renderer.prototype.uploadAgents = function (eco, world, highlight) {
    var gl = this.gl;
    var pos = this.agentPos, dat = this.agentData;
    var cap = this.agentCapacity;
    var grid = world.grid;
    var agents = eco.agents;
    var n = 0;
    for (var i = 0; i < agents.length && n < cap; i++) {
      var a = agents[i];
      if (!a.alive) continue;
      var j = n * 2;
      pos[j] = grid.px[a.cell];
      pos[j + 1] = grid.py[a.cell];
      var k = n * 4;
      var energy = a.energy / eco.cfg.energyCap;
      dat[k] = energy;
      dat[k + 1] = a.sp;
      dat[k + 2] = U.clamp01((a.tSize - 0.5) / 1.4);
      dat[k + 3] = (highlight && highlight === a) ? 1 : 0;
      n++;
    }
    this.agentCount = n;
    this.stats.agents = n;
    if (n === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.agentPosBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos, 0, n * 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.agentDataBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, dat, 0, n * 4);
  };

  /* --------------------------------------------------------------- camera */

  Renderer.prototype.fitWorld = function (world) {
    var wUnits = world.w;
    var hUnits = (world.h - 1) * 0.75 + 1;
    var s = Math.min(this.width / (wUnits + 2), this.height / (hUnits + 2));
    this.camera.scale = s;
    this.camera.x = wUnits * 0.5;
    this.camera.y = hUnits * 0.5;
    this.worldUnits = { w: wUnits, h: hUnits };
  };

  Renderer.prototype.centreOn = function (x, y, scale) {
    this.camera.x = x;
    this.camera.y = y;
    if (scale) this.camera.scale = U.clamp(scale, 1, 90);
  };

  Renderer.prototype.zoomAt = function (factor, screenX, screenY) {
    var before = this.screenToWorld(screenX, screenY);
    this.camera.scale = U.clamp(this.camera.scale * factor, 0.6, 120);
    var after = this.screenToWorld(screenX, screenY);
    this.camera.x += before.x - after.x;
    this.camera.y += before.y - after.y;
  };

  /* Screen coordinates are CSS pixels relative to the canvas. */
  Renderer.prototype.screenToWorld = function (sx, sy) {
    var rect = this.canvas.getBoundingClientRect();
    var px = sx * this.dpr;
    var py = this.height - sy * this.dpr;
    return {
      x: this.camera.x + (px - this.width * 0.5) / this.camera.scale,
      y: this.camera.y + (py - this.height * 0.5) / this.camera.scale
    };
  };

  Renderer.prototype.worldToCell = function (wx, wy) {
    var row = Math.round(wy / 0.75);
    var col = Math.round(wx - (row & 1) * 0.5);
    return { col: col, row: row };
  };

  /* --------------------------------------------------------------- drawing */

  Renderer.prototype.draw = function (world, eco, opts) {
    if (!this.ok) return;
    var gl = this.gl;
    opts = opts || {};
    var st = this.settings;
    var sun = Palette.Sun;

    this.uploadWorld(world);
    this.uploadAgents(eco, world, opts.highlight);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    /* ---- scene pass ---- */
    var target = this.tScene;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.clearColor(0.02, 0.024, 0.036, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    var p = this.progScene;
    gl.useProgram(p.prog);
    gl.bindVertexArray(this.emptyVao);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texATex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texBTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texCTex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.biomeTex);
    gl.uniform1i(p.u.uTexA, 0);
    gl.uniform1i(p.u.uTexB, 1);
    gl.uniform1i(p.u.uTexC, 2);
    gl.uniform1i(p.u.uBiome, 3);

    gl.uniform2f(p.u.uRes, target.w, target.h);
    gl.uniform2f(p.u.uCentre, this.camera.x, this.camera.y);
    gl.uniform1f(p.u.uScale, this.camera.scale);
    gl.uniform2f(p.u.uWorld, world.w + 1, world.h);
    gl.uniform1f(p.u.uRowV, 0.75);
    gl.uniform2f(p.u.uTexel, 1 / (world.w + 1), 1 / world.h);
    gl.uniform1f(p.u.uTime, opts.time || 0);
    gl.uniform1i(p.u.uMode, st.mode | 0);

    /* Light direction from the sun's azimuth/elevation. At night the light
     * flips to the moon: same elevation curve, opposite side, blue. */
    var e = sun.elevation;
    var lx = Math.cos(sun.azimuth) * 0.55;
    var ly = -Math.sin(sun.azimuth) * 0.35 + 0.42;
    var lz = Math.max(0.28, Math.abs(e) * 0.95 + 0.22);
    if (sun.isNight) { lx = -lx * 0.6; ly = -0.45; lz = 0.55; }
    gl.uniform3f(p.u.uLight, lx, ly, lz);
    gl.uniform3f(p.u.uLightCol, sun.colour[0] / 255, sun.colour[1] / 255, sun.colour[2] / 255);
    gl.uniform3f(p.u.uAmbient, sun.ambient[0] / 255, sun.ambient[1] / 255, sun.ambient[2] / 255);
    gl.uniform1f(p.u.uDaylight, sun.daylight);
    gl.uniform1f(p.u.uNight, sun.isNight ? 1 : 0);
    gl.uniform1f(p.u.uRain, world.weather.rain * (sun.isNight ? 0.5 : 1));
    gl.uniform1i(p.u.uDebug, st.debug | 0);
    gl.uniform1f(p.u.uGridAmt, st.grid);
    gl.uniform1f(p.u.uContourAmt, st.contour);
    gl.uniform1f(p.u.uShadeAmt, st.shade * (st.mode === 1 ? 0.25 : 1));
    var sel = st.selection;
    if (sel) {
      gl.uniform1f(p.u.uSelX, sel.col + 0.5 * (sel.row & 1));
      gl.uniform1f(p.u.uSelY, sel.row);
      gl.uniform1f(p.u.uSelOn, 1);
    } else {
      gl.uniform1f(p.u.uSelOn, 0);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* ---- agent pass, additive into the same target ---- */
    if (this.agentCount > 0) {
      var ap = this.progAgent;
      gl.useProgram(ap.prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.bindVertexArray(this.agentVao);
      gl.uniform2f(ap.u.uCentre, this.camera.x, this.camera.y);
      gl.uniform1f(ap.u.uScale, this.camera.scale);
      gl.uniform2f(ap.u.uRes, target.w, target.h);
      gl.uniform1f(ap.u.uPointScale, st.pointScale * this.dpr * (this.camera.scale / 6));
      gl.uniform1f(ap.u.uNight, sun.isNight ? 1 : 0);
      gl.uniform1f(ap.u.uHeight, 0);
      var loc = gl.getUniformLocation(ap.prog, 'uSpecies');
      if (loc) {
        var lut = new Float32Array(16 * 3);
        for (var si = 0; si < 16; si++) {
          var col = Palette.speciesColour(si);
          lut[si * 3] = col[0] / 255;
          lut[si * 3 + 1] = col[1] / 255;
          lut[si * 3 + 2] = col[2] / 255;
        }
        gl.uniform3fv(loc, lut);
      }
      gl.drawArrays(gl.POINTS, 0, this.agentCount);
      gl.disable(gl.BLEND);
    }

    /* ---- bloom ---- */
    var hasBloom = false;
    if (this.tBrightA && st.bloom > 0.001) {
      hasBloom = true;
      var bp = this.progBright;
      gl.useProgram(bp.prog);
      gl.bindVertexArray(this.emptyVao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tBrightA.fbo);
      gl.viewport(0, 0, this.tBrightA.w, this.tBrightA.h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tScene.tex);
      gl.uniform1i(bp.u.uTex, 0);
      gl.uniform1f(bp.u.uThreshold, 0.62);
      gl.uniform1f(bp.u.uKnee, 0.35);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      var blp = this.progBlur;
      gl.useProgram(blp.prog);
      gl.uniform1i(blp.u.uTex, 0);
      var passes = [
        { src: this.tBrightA, dst: this.tBrightB, dx: 1 / this.tBrightA.w, dy: 0 },
        { src: this.tBrightB, dst: this.tBrightA, dx: 0, dy: 1 / this.tBrightA.h }
      ];
      for (var q = 0; q < passes.length; q++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, passes[q].dst.fbo);
        gl.viewport(0, 0, passes[q].dst.w, passes[q].dst.h);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, passes[q].src.tex);
        gl.uniform2f(blp.u.uDir, passes[q].dx, passes[q].dy);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }

    /* ---- composite to the screen ---- */
    var cp = this.progComposite;
    gl.useProgram(cp.prog);
    gl.bindVertexArray(this.emptyVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tScene.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hasBloom ? this.tBrightA.tex : this.tScene.tex);
    gl.uniform1i(cp.u.uScene, 0);
    gl.uniform1i(cp.u.uBloom, 1);
    gl.uniform1f(cp.u.uTime, opts.time || 0);
    gl.uniform1f(cp.u.uBloomAmt, hasBloom ? st.bloom : 0);
    gl.uniform1f(cp.u.uAberration, st.aberration);
    gl.uniform1f(cp.u.uGrain, st.grain);
    gl.uniform1f(cp.u.uVignette, st.vignette);
    gl.uniform1f(cp.u.uExposure, st.exposure);
    gl.uniform1f(cp.u.uScanline, st.scanline);
    gl.uniform1f(cp.u.uFlash, world.weather.flash || 0);
    gl.uniform1f(cp.u.uHasBloom, hasBloom ? 1 : 0);
    gl.uniform2f(cp.u.uOutRes, this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    this.stats.draws++;
  };

  Renderer.prototype.screenshot = function () {
    try { return this.canvas.toDataURL('image/png'); }
    catch (e) { return null; }
  };

  Renderer.prototype.dispose = function () {
    if (!this.gl) return;
    var gl = this.gl;
    [this.progScene, this.progAgent, this.progBright, this.progBlur, this.progComposite].forEach(function (p) {
      if (p) gl.deleteProgram(p.prog);
    });
    disposeTarget(gl, this.tScene);
    disposeTarget(gl, this.tBrightA);
    disposeTarget(gl, this.tBrightB);
    ['texATex', 'texBTex', 'texCTex', 'biomeTex'].forEach(function (k) {
      if (this[k]) gl.deleteTexture(this[k]);
    }, this);
  };

  global.HX = global.HX || {};
  global.HX.Renderer = Renderer;

})(typeof window !== 'undefined' ? window : globalThis);