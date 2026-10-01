/* ============================================================================
 * HORTUS / core/hex.js
 *
 * Hex grid geometry.
 *
 * Storage layout is "odd-r" offset (odd rows shifted right) with pointy-top
 * hexes. Offset keeps the flat array trivially addressable; all real geometry
 * is done in axial coordinates, and conversions go through `idxQ`.
 *
 * The trap in odd-r layouts: the six named directions do NOT map to a fixed
 * axial vector. `SW` is axial (0,+1) on odd rows but (-1,+1) on even rows.
 * So the only correct way to invert a direction is to search the neighbour
 * table, which this module does — see `directionTo`.
 *
 * Per-cell ring tables (for sensing) are precomputed at construction time,
 * bounded by MAX_RING so the memory cost stays predictable.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var HEX_W = 1.0;    /* horizontal spacing between column centres, cell units */
  var HEX_V = 0.75;   /* vertical spacing between row centres (3/4)            */

  /* Pointy-top hexes, clockwise from east. Offsets are for EVEN rows; odd
   * rows use HexGrid.ODD_OFF. */
  var DIRS = [
    { name: 'E',  dr: 0, dc: 1 },
    { name: 'NE', dr: -1, dc: 0 },
    { name: 'NW', dr: -1, dc: -1 },
    { name: 'W',  dr: 0, dc: -1 },
    { name: 'SW', dr: 1, dc: 0 },
    { name: 'SE', dr: 1, dc: 1 }
  ];

  var EVEN_OFF = [1, 0, -1, -1, -1, 0];
  var ODD_OFF = [1, 1, 0, -1, 0, 1];
  var OPPOSITE = [3, 4, 5, 0, 1, 2];

  /* Cubic-space coordinates of each direction, for EVEN rows. Odd rows differ;
   * use `axialDelta(row, d)` when you need an axial step vector. */
  var CUBE_EVEN = [
    [1, -1, 0],    /* E  */
    [0, 1, -1],    /* NE */
    [-1, 1, -1],   /* NW */
    [-1, 1, 0],    /* W  */
    [-1, 0, 1],    /* SW */
    [1, -2, 1]     /* SE */
  ];
  var CUBE_ODD = [
    [1, -1, 0],    /* E  */
    [1, 0, -1],    /* NE */
    [0, 1, -1],    /* NW */
    [-1, 1, 0],    /* W  */
    [0, -1, 1],    /* SW */
    [1, -2, 1]     /* SE */
  ];

  /* ---- rings in axial space ------------------------------------------- */
  /* The six side vectors of a hex ring, in axial (dq, dr). */
  var RING_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

  function axialRing(n) {
    if (n === 0) return [[0, 0]];
    var out = [];
    var q = RING_DIRS[4][0] * n, r = RING_DIRS[4][1] * n;  /* start at a corner */
    for (var side = 0; side < 6; side++) {
      var dq = RING_DIRS[side][0], dr = RING_DIRS[side][1];
      for (var s = 0; s < n; s++) {
        q += dq; r += dr;
        out.push([q, r]);
      }
    }
    return out;
  }

  var RING_AXIAL = [];
  for (var _rn = 0; _rn <= 16; _rn++) RING_AXIAL.push(axialRing(_rn));

  /* Cumulative cell counts, so ring r ends at CUM[r] - 1. */
  var CUM = (function () {
    var c = [0], total = 0;
    for (var i = 0; i < RING_AXIAL.length; i++) { total += RING_AXIAL[i].length; c.push(total); }
    return c;
  })();

  /* =========================================================== HexGrid ==== */

  function HexGrid(w, h, maxRing) {
    this.w = w | 0;
    this.h = h | 0;
    this.size = this.w * this.h;
    if (this.size <= 0) throw new Error('HexGrid: empty');

    var i, y, x, d;

    /* ---- index <-> (col,row) and axial -------------------------------- */
    this.col = new Int16Array(this.size);
    this.row = new Int16Array(this.size);
    this.q = new Int16Array(this.size);
    this.r = new Int16Array(this.size);

    for (y = 0; y < this.h; y++) {
      var half = (y - (y & 1)) >> 1;
      for (x = 0; x < this.w; x++) {
        i = y * this.w + x;
        this.col[i] = x;
        this.row[i] = y;
        this.r[i] = y;
        this.q[i] = x - half;
      }
    }

    /* ---- pixel centres, in cell units --------------------------------- */
    this.px = new Float32Array(this.size);
    this.py = new Float32Array(this.size);
    for (i = 0; i < this.size; i++) {
      this.px[i] = this.col[i] + (this.row[i] & 1) * 0.5;
      this.py[i] = this.row[i] * HEX_V;
    }

    /* ---- neighbour table --------------------------------------------- */
    this.nbr = new Int32Array(this.size * 6);
    for (i = 0; i < this.size; i++) {
      var cx = this.col[i], cy = this.row[i];
      var off = (cy & 1) ? ODD_OFF : EVEN_OFF;
      for (d = 0; d < 6; d++) {
        var nc = cx + off[d];
        var nr = cy + DIRS[d].dr;
        this.nbr[i * 6 + d] = (nc < 0 || nc >= this.w || nr < 0 || nr >= this.h) ? -1 : nr * this.w + nc;
      }
    }

    /* ---- ring membership (sensing) ----------------------------------- */
    this.MAX_RING = Math.min(maxRing === undefined ? 4 : maxRing, 16);
    var stride = this.MAX_RING + 1;
    var tableLen = CUM[this.MAX_RING];
    this.ringStride = stride;
    this.ringTableLen = tableLen;
    this.ringStart = new Int32Array(this.size * stride);
    this.ringIdx = new Int32Array(this.size * tableLen);

    for (i = 0; i < this.size; i++) {
      var base = i * tableLen;
      var qi = this.q[i], ri = this.r[i];
      var off2 = 0;
      for (var rr = 0; rr <= this.MAX_RING; rr++) {
        this.ringStart[i * stride + rr] = base + off2;
        var ring = RING_AXIAL[rr];
        for (var k = 0; k < ring.length; k++) {
          var oc = (qi + ring[k][0]) + (((ri + ring[k][1]) - ((ri + ring[k][1]) & 1)) >> 1);
          var orr = ri + ring[k][1];
          this.ringIdx[base + off2] = (oc < 0 || oc >= this.w || orr < 0 || orr >= this.h) ? -1 : orr * this.w + oc;
          off2++;
        }
      }
    }

    /* ---- bounds ------------------------------------------------------- */
    this.minPx = 0;
    this.minPy = 0;
    this.maxPx = (this.w - 1) + 0.5;
    this.maxPy = (this.h - 1) * HEX_V;
    this.aspect = this.maxPx / Math.max(1e-6, this.maxPy);
  }

  /* --------------------------------------------------------- conversions */

  HexGrid.prototype.inBounds = function (col, row) {
    return col >= 0 && col < this.w && row >= 0 && row < this.h;
  };

  HexGrid.prototype.idx = function (col, row) {
    if (col < 0 || col >= this.w || row < 0 || row >= this.h) return -1;
    return row * this.w + col;
  };

  /* axial -> index */
  HexGrid.prototype.idxQ = function (q, r) {
    var col = q + ((r - (r & 1)) >> 1);
    return this.idx(col, r);
  };

  /* index -> axial */
  HexGrid.prototype.ax = function (i) { return [this.q[i], this.r[i]]; };

  /* ---------------------------------------------------------- directions */

  HexGrid.prototype.neighbor = function (i, d) { return this.nbr[i * 6 + d]; };

  HexGrid.prototype.opposite = function (d) { return OPPOSITE[d]; };

  /* Axial step vector for direction `d` leaving a cell in row `row`. */
  HexGrid.axialDelta = function (row, d) {
    var off = (row & 1) ? ODD_OFF : EVEN_OFF;
    var dr = DIRS[d].dr;
    var dc = off[d];
    return [dc - ((dr - (dr & 1)) >> 1), dr];
  };

  HexGrid.prototype.axialDelta = function (i, d) { return HexGrid.axialDelta(this.row[i], d); };

  /*
   * Invert a direction: which of the six neighbours is cell `to`?
   * A search over the neighbour table is the only parity-correct way to do it.
   */
  HexGrid.prototype.directionTo = function (from, to) {
    var base = from * 6, nbr = this.nbr;
    for (var d = 0; d < 6; d++) if (nbr[base + d] === to) return d;
    return -1;
  };

  /* Same, tolerant: falls back to cube rounding for non-adjacent targets. */
  HexGrid.prototype.approxDirection = function (from, to) {
    var d = this.directionTo(from, to);
    if (d >= 0) return d;
    var dq = this.q[to] - this.q[from];
    var dr = this.r[to] - this.r[from];
    if (dq === 0 && dr === 0) return -1;
    var x = dq, z = dr, y = -x - z;
    var rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
    var dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    var cube = (this.row[from] & 1) ? CUBE_ODD : CUBE_EVEN;
    var best = -1, bestDot = -Infinity;
    for (var k = 0; k < 6; k++) {
      var dot = cube[k][0] * rx + cube[k][1] * ry + cube[k][2] * rz;
      if (dot > bestDot) { bestDot = dot; best = k; }
    }
    return best;
  };

  /* Walk `steps` cells in direction d. Returns -1 if it leaves the world. */
  HexGrid.prototype.step = function (i, d, steps) {
    steps = steps || 1;
    var cur = i, s;
    for (s = 0; s < steps; s++) {
      cur = this.nbr[cur * 6 + d];
      if (cur < 0) return -1;
    }
    return cur;
  };

  /* ------------------------------------------------------------ distance */

  HexGrid.prototype.distance = function (a, b) {
    var dq = this.q[a] - this.q[b];
    var dr = this.r[a] - this.r[b];
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  };

  HexGrid.prototype.lineTo = function (a, b) {
    var n = this.distance(a, b);
    if (n === 0) return [a];
    var out = [];
    var ax = this.q[a], az = this.r[a];
    var ay = -ax - az;
    var bx = this.q[b] + 1e-6, bz = this.r[b] - 1e-6, by = -bx - bz;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      var rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
      var dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
      if (dx > dy && dx > dz) rx = -ry - rz;
      else if (dy > dz) ry = -rx - rz;
      else rz = -rx - ry;
      var id = this.idxQ(rx, rz);
      out.push(id < 0 ? a : id);
    }
    return out;
  };

  /* --------------------------------------------------------------- discs */

  /* Cells within axial radius `rad` (clamped to MAX_RING), i.e. rings 0..rad,
   * with -1 entries for positions that fall outside the world. No allocation.
   * Rings are stored contiguously per cell, so the disc is simply the prefix
   * of length CUM[rad+1]. */
  HexGrid.prototype.ringSlice = function (i, rad) {
    if (rad > this.MAX_RING) rad = this.MAX_RING;
    if (rad < 0) rad = 0;
    var base = i * this.ringTableLen;
    return this.ringIdx.subarray(base, base + CUM[rad + 1]);
  };

  /* Same, but out-of-world positions dropped. Allocates. */
  HexGrid.prototype.disc = function (i, rad) {
    var slice = this.ringSlice(i, Math.min(rad, this.MAX_RING));
    var out = [];
    for (var k = 0; k < slice.length; k++) if (slice[k] >= 0) out.push(slice[k]);
    return out;
  };

  /* Visit every in-world cell within radius `rad`. Works for any radius up to
   * 16 without a precomputed table, so wide scans stay possible. */
  HexGrid.prototype.forEachInDisc = function (i, rad, fn) {
    if (rad < 0) return;
    var q0 = this.q[i], r0 = this.r[i];
    var ri, k, ring, id;
    for (ri = 0; ri <= rad; ri++) {
      ring = RING_AXIAL[ri];
      for (k = 0; k < ring.length; k++) {
        id = this.idxQ(q0 + ring[k][0], r0 + ring[k][1]);
        if (id >= 0) fn(id, ri);
      }
    }
  };

  /* Average of a Float32Array field over a disc, weighted toward the centre.
     Allocation-free: out-of-world ring entries are simply skipped. */
  HexGrid.prototype.avgInDisc = function (i, rad, field) {
    var stride = this.MAX_RING + 1;
    var rad2 = rad < 0 ? 0 : (rad > this.MAX_RING ? this.MAX_RING : rad);
    var slice = this.ringSlice(i, rad2), s = 0, n = 0;
    for (var k = 0; k < slice.length; k++) {
      var j = slice[k];
      if (j < 0) continue;
      s += field[j]; n++;
    }
    return n ? s / n : 0;
  };

  /* ---------------------------------------------------------------- misc */

  /* Index of the cell containing pixel coordinates in cell units. */
  HexGrid.prototype.cellFromPixel = function (fx, fy) {
    var row = Math.round(fy / HEX_V);
    var col = Math.round(fx - (row & 1) * 0.5);
    return this.idx(col, row);
  };

  /* Every cell, in a stable order, as a plain Int32Array (cached). */
  HexGrid.prototype.allCells = function () {
    if (!this._all) {
      this._all = new Int32Array(this.size);
      for (var i = 0; i < this.size; i++) this._all[i] = i;
    }
    return this._all;
  };

  HexGrid.HEX_W = HEX_W;
  HexGrid.HEX_V = HEX_V;
  HexGrid.DIRS = DIRS;
  HexGrid.RING_AXIAL = RING_AXIAL;
  HexGrid.CUM = CUM;
  HexGrid.OPPOSITE = OPPOSITE;

  global.HX = global.HX || {};
  global.HX.HexGrid = HexGrid;
  global.HX.DIRS = DIRS;

})(typeof window !== 'undefined' ? window : globalThis);