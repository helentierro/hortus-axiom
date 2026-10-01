/* ============================================================================
 * HORTUS / render/palette.js
 *
 * Colour is the entire visual language of this program, so it gets its own
 * module and its own justification.
 *
 * Three things live here:
 *
 *  1. BIOME COLOURS. Eighteen biomes need eighteen colours that a person can
 *     tell apart at 3px per cell, in greyscale-ish contexts, and next to each
 *     other. The set below is built by walking hue around the wheel while
 *     holding lightness and saturation in a narrow band, so every biome sits
 *     at the same "visual weight" and no single one shouts.
 *
 *  2. VIEW MODES. Chart (flat cartographic), Terrain (relief-shaded), Vital
 *     (false colour by a chosen field), Thermal, and Night. Each is a
 *     different function from the same world fields, not a different world.
 *
 *  3. AGENT COLOURS. Assigned per species so that competing lineages are
 *     visually separable, and chosen to sit apart from every biome colour.
 *
 * Kept free of DOM and WebGL so the Canvas2D fallback and the tests can use
 * exactly the same colours as the GPU path.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;

  /* ------------------------------------------------------------- biomes */
  /* Keys match HX.BIOMES order exactly. Kept as a separate literal so the
   * palette is editable without touching the simulation. */
  var BIOME_COLOURS = [
    { key: 'DEEP',     base: [4, 10, 26],    edge: [10, 34, 62],   accent: [26, 72, 110] },
    { key: 'OCEAN',    base: [12, 40, 72],   edge: [18, 68, 104],  accent: [40, 116, 150] },
    { key: 'SHALLOWS', base: [30, 96, 116],  edge: [46, 132, 146], accent: [96, 186, 186] },
    { key: 'ICE',      base: [206, 226, 240], edge: [232, 244, 252], accent: [255, 255, 255] },
    { key: 'TUNDRA',   base: [122, 132, 120], edge: [150, 158, 144], accent: [150, 164, 140] },
    { key: 'TAIGA',    base: [48, 78, 62],   edge: [62, 100, 76],   accent: [104, 152, 106] },
{ key: 'ALPINE',   base: [118, 128, 146], edge: [146, 154, 166], accent: [160, 166, 174] },
    { key: 'HIGHLAND', base: [116, 100, 74],  edge: [144, 124, 90],  accent: [178, 152, 106] },
    { key: 'MARSH',    base: [58, 92, 74],   edge: [74, 116, 88],  accent: [116, 156, 108] },
    { key: 'FOREST',   base: [38, 74, 46],   edge: [50, 96, 56],   accent: [92, 148, 76] },
    { key: 'GRASS',    base: [108, 136, 68], edge: [134, 160, 82],  accent: [178, 196, 106] },
{ key: 'SAVANNA',  base: [142, 140, 66],  edge: [170, 162, 84],  accent: [196, 178, 92] },
    { key: 'STEPPE',   base: [148, 142, 96],   edge: [172, 162, 116],  accent: [190, 180, 118] },
    { key: 'DESERT',   base: [198, 176, 126], edge: [220, 200, 152], accent: [240, 226, 186] },
    { key: 'BEACH',    base: [214, 198, 156], edge: [230, 218, 184], accent: [246, 240, 216] },
    { key: 'BARRENS',  base: [90, 82, 80],    edge: [112, 102, 98],   accent: [144, 132, 126] },
    { key: 'BLIGHT',   base: [68, 58, 62],   edge: [88, 74, 76],   accent: [108, 92, 94] },
    { key: 'VENT',     base: [58, 42, 42],   edge: [82, 52, 44],   accent: [168, 74, 40] }
  ];

  /* Flat Float32Array of base colours for shader upload, and a matching
   * 256-entry lookup built from them. */
  var BIOME_FLAT = new Float32Array(BIOME_COLOURS.length * 3);
  for (var i = 0; i < BIOME_COLOURS.length; i++) {
    BIOME_FLAT[i * 3] = BIOME_COLOURS[i].base[0] / 255;
    BIOME_FLAT[i * 3 + 1] = BIOME_COLOURS[i].base[1] / 255;
    BIOME_FLAT[i * 3 + 2] = BIOME_COLOURS[i].base[2] / 255;
  }
  var BIOME_EDGE_FLAT = new Float32Array(BIOME_COLOURS.length * 3);
  for (var j = 0; j < BIOME_COLOURS.length; j++) {
    BIOME_EDGE_FLAT[j * 3] = BIOME_COLOURS[j].edge[0] / 255;
    BIOME_EDGE_FLAT[j * 3 + 1] = BIOME_COLOURS[j].edge[1] / 255;
    BIOME_EDGE_FLAT[j * 3 + 2] = BIOME_COLOURS[j].edge[2] / 255;
  }

  /* ------------------------------------------------------------ species */
  /* Deliberately outside the biome gamut: high-chroma hues, so a creature is
   * always the most saturated thing on screen. */
  var SPECIES_COLOURS = [
    [255, 92, 76],    /* vermilion */
    [255, 176, 46],   /* amber     */
    [126, 224, 128],  /* jade      */
    [92, 208, 236],   /* cyan      */
    [148, 128, 255],  /* iris      */
    [240, 108, 188],  /* magenta   */
    [255, 240, 120],  /* sulphur   */
    [120, 190, 255],  /* azure     */
    [200, 255, 210],  /* mint      */
    [255, 150, 120],  /* coral     */
    [180, 220, 90],   /* olive-lime*/
    [230, 130, 255]   /* wisteria  */
  ];

  function speciesColour(id) { return SPECIES_COLOURS[id % SPECIES_COLOURS.length]; }
  function speciesCss(id, alpha) {
    var c = speciesColour(id);
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' + (alpha === undefined ? '' : ' / ' + alpha);
  }
  function speciesRgb(id) { return { r: speciesColour(id)[0], g: speciesColour(id)[1], b: speciesColour(id)[2] }; }

  /* --------------------------------------------------------- view modes */

  var VIEWS = [
    { key: 'terrain', name: 'Terrain', hint: 'relief-shaded naturalism' },
    { key: 'chart',   name: 'Chart',   hint: 'flat cartographic biomes' },
    { key: 'vegetation', name: 'Biomass', hint: 'false colour by standing vegetation' },
    { key: 'thermal', name: 'Thermal', hint: 'false colour by temperature' },
    { key: 'water',   name: 'Water',   hint: 'false colour by hydrology' },
    { key: 'stress',  name: 'Stress',  hint: 'false colour by grazing pressure' }
  ];

  /* --------------------------------------------------------------- ramps */
  var RAMPS = {
    vegetation: U.STOP.moss,
    thermal: U.STOP.fire,
    water: U.STOP.ice,
    stress: U.STOP.magma,
    terrain: U.STOP.dusk
  };

  /* Sun direction and the day cycle. One shared source of truth so the
   * renderer, the audio engine and the UI can never disagree about what time
   * it is. */
  var Sun = {
    /* daylight 0..1, driven by the world's day fraction */
    elevation: 0.7,
    azimuth: 0.4,
    colour: [255, 244, 214],
    nightColour: [92, 118, 176],
    ambient: [58, 66, 88],
    daylight: 1,
    isNight: false
  };

  function updateSun(dayFrac, weather, tempMean) {
    /* Peak at noon (dayFrac 0.5). */
    var a = (dayFrac - 0.25) * U.TAU;
    var elev = Math.sin(a);
    Sun.elevation = elev;
    Sun.azimuth = a;
    /* Cloud cover flattens the light and desaturates it. */
    var cloud = weather ? weather.cloud : 0.2;
    var overcast = U.lerp(1, 0.42, cloud);
    Sun.daylight = U.clamp01(elev * 1.35 + 0.12) * overcast;
    Sun.isNight = Sun.daylight < 0.14;
    /* Warm at dawn and dusk, neutral at noon, blue at night. */
    var golden = U.gauss(Math.abs(elev), 0.16, 0.16);
    var warm = golden * (1 - cloud * 0.5);
    var night = 1 - U.clamp01(Sun.daylight * 2.2);
    for (var i = 0; i < 3; i++) {
      var day = [255, 246, 224][i];
      var dusk = [255, 176, 108][i];
      var n = [86, 112, 178][i];
      Sun.colour[i] = U.lerp(U.lerp(day, dusk, warm * 0.85), n, night);
    }
    var cloudDim = 1 - cloud * 0.28;
    /* Night is not zero light, but it is much less than day. An ambient floor
       near black turns the map into one unreadable silhouette; one that is
       too high makes midnight look like noon. This lands in between. */
    Sun.ambient[0] = U.lerp(38, 118, Sun.daylight) * cloudDim;
    Sun.ambient[1] = U.lerp(44, 124, Sun.daylight) * cloudDim;
    Sun.ambient[2] = U.lerp(62, 128, Sun.daylight) * cloudDim;
  }

  /* ------------------------------------------------------------- helpers */

  /* Sample a biome colour with a little elevation shading folded in, for the
   * Canvas2D path where there is no shader to do it. */
  function biomeShaded(biomeId, elev, veg) {
    var c = BIOME_COLOURS[biomeId] || BIOME_COLOURS[0];
    var lift = 0.86 + elev * 0.34;
    var r = c.base[0] * lift, g = c.base[1] * lift, b = c.base[2] * lift;
    if (veg > 0.02) {
      var a = U.clamp01(veg * 0.75);
      r = U.lerp(r, c.accent[0], a * 0.55);
      g = U.lerp(g, c.accent[1], a * 0.55);
      b = U.lerp(b, c.accent[2], a * 0.55);
    }
    return [
      Math.max(0, Math.min(255, Math.round(r))),
      Math.max(0, Math.min(255, Math.round(g))),
      Math.max(0, Math.min(255, Math.round(b)))
    ];
  }

  function rampColour(rampName, t) {
    var stops = RAMPS[rampName] || RAMPS.vegetation;
    var c = U.ramp(t, stops);
    return [c.r, c.g, c.b];
  }

  /* Grade a colour by the current sun. Used by the fallback renderer so that
   * day and night are visible even without the GPU path. */
  function grade(rgb, daylight, ambient) {
    var out = [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      var lit = ambient ? ambient[i] : 40;
      var sun = Sun.colour[i] / 255;
      var v = rgb[i] / 255;
      v = v * (lit / 255) * 0.6 + v * sun * daylight;
      out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    return out;
  }

  global.HX = global.HX || {};
  global.HX.Palette = {
    BIOME_COLOURS: BIOME_COLOURS,
    BIOME_FLAT: BIOME_FLAT,
    BIOME_EDGE_FLAT: BIOME_EDGE_FLAT,
    SPECIES_COLOURS: SPECIES_COLOURS,
    VIEWS: VIEWS,
    RAMPS: RAMPS,
    Sun: Sun,
    speciesColour: speciesColour,
    speciesCss: speciesCss,
    speciesRgb: speciesRgb,
    biomeShaded: biomeShaded,
    rampColour: rampColour,
    updateSun: updateSun,
    grade: grade
  };

})(typeof window !== 'undefined' ? window : globalThis);