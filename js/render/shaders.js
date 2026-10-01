/* ============================================================================
 * HORTUS / render/shaders.js
 *
 * GLSL ES 3.00 sources for the GPU path. Kept as strings so the page loads
 * with no build step and no network fetch.
 *
 * Pass structure:
 *   scene     -> world shading + relief + water + rivers + contours
 *   agents    -> additive point sprites for every living creature
 *   bright    -> threshold extraction for bloom
 *   blur      -> separable gaussian, run twice
 *   composite -> tone map, bloom add, aberration, grain, vignette
 *
 * Everything is written so that a WebGL2 compile failure is loud and
 * locatable rather than a black canvas: the renderer prints the offending
 * line to the overlay and falls back to Canvas2D.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- shared */

  var COMMON = `
const float PI = 3.141592653589793;

// cheap value noise for grain, foam and water sparkle
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 4-stop colour ramp, used by the false-colour views
vec3 ramp4(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  t = clamp(t, 0.0, 1.0);
  float f = t * 3.0;
  vec2 i = vec2(clamp(floor(f), 0.0, 2.0), clamp(f - floor(f), 0.0, 1.0));
  vec3 lo = i.x < 0.5 ? a : (i.x < 1.5 ? b : c);
  vec3 hi = i.x < 0.5 ? b : (i.x < 1.5 ? c : d);
  return mix(lo, hi, i.y);
}

// anti-aliased periodic line, width in units of the local gradient
float gridLine(float v, float w) {
  float g = abs(fract(v - 0.5) - 0.5) / max(w, 1e-5);
  return 1.0 - min(g, 1.0);
}

// ALIASING GUARD. World units per device pixel. Any procedural term whose
// spatial frequency exceeds about half the pixel rate is invisible at best
// and a shimmering moire at worst — and a fine weave across the whole ocean
// reads as "the water is patterned", not as a bug. Every hand-tuned frequency
// in this shader is clamped through this so it can never outrun the sampler.
float aliasGuard(float freq, float px) {
  return min(freq, 0.24 / max(px, 1e-5));
}

// Gradient noise. Three hand-picked sinusoids tile visibly: on a regular
// sampling lattice they repeat identical "fish scales" across the entire ocean,
// which reads as a texture bug rather than as water. Gradient noise has no
// repeating unit, and two samples of it are enough to domain-warp the waves
// into something organic.
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(hash22(i),                 f);
  float b = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
}
`;

  /* ----------------------------------------------------------------- scene */

  var SCENE_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // full-screen triangle from gl_VertexID, no vertex buffer needed
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

  var SCENE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;        // drawing buffer size, device pixels
uniform vec2  uCentre;     // camera centre in world cell units
uniform float uScale;      // device pixels per world cell unit
uniform vec2  uWorld;      // world texture width (gridW + 1, shear baked in), gridH
uniform float uRowV;       // 0.75
uniform vec2  uTexel;      // 1 / gridW, 1 / gridH
uniform float uTime;
uniform int   uMode;       // 0 terrain, 1 chart, 2 biomass, 3 thermal, 4 water, 5 stress
uniform vec3  uLight;      // direction toward the light
uniform vec3  uLightCol;
uniform vec3  uAmbient;
uniform float uDaylight;
uniform float uNight;
uniform float uRain;
uniform float uGridAmt;
uniform float uContourAmt;
uniform float uShadeAmt;
uniform float uSelX;       // selected cell, for the locator ring
uniform float uSelY;
uniform float uSelOn;
uniform int   uDebug;      // 0 off, 1 water, 2 elevation, 3 biome, 4 vegetation, 5 uv

uniform sampler2D uTexA;   // r elev(-1..1 packed), g water, b veg, a snow
uniform sampler2D uTexB;   // r temp, g biome/255, b flux, a scorch
uniform sampler2D uTexC;   // r moist, g fertility, b crowd, a precip
uniform sampler2D uBiome;  // 32x2 palette LUT: row 0 base, row 1 accent

${COMMON}

void main() {
  // screen -> world. gl_FragCoord is bottom-up; the world's +y runs south.
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 world = uCentre + (frag - uRes * 0.5) / uScale;

  // Nearest cell centre on the odd-r offset lattice. Rounding in offset space
  // is exact, unlike rounding in axial space where two cells tie.
  float rowf = floor(world.y / uRowV + 0.5);
  float par = mod(rowf, 2.0);
  // Cell index within the SHEARED texture: odd rows were written half a texel
  // to the right on upload, so the parity shift is already baked in and the
  // shader needs no shear arithmetic at all.
  vec2 cellTex = vec2(floor(world.x - 0.5 * par + 0.5) + 0.5 * par, rowf);
  vec2 uvCell = cellTex / uWorld;
  // ...but the SMOOTH fields need the CONTINUOUS lattice coordinate, not the
  // rounded cell. Sampling uv at cellTex + 0.5 returns the exact texel value
  // and jumps at every cell boundary, which renders as a hard checkerboard
  // across every field — the whole map looks quantised to one colour per cell.
  vec2 lattice = vec2(world.x - 0.5 * par, world.y / uRowV);
  vec2 uv = (lattice + vec2(0.5, 0.5)) / uWorld;

  if (uvCell.x < 0.0 || uvCell.x > 1.0 || uvCell.y < 0.0 || uvCell.y > 1.0) {
    fragColor = vec4(0.020, 0.024, 0.036, 1.0);
    return;
  }

  ivec2 ip = ivec2(int(cellTex.x), int(cellTex.y));

  vec4 A = texture(uTexA, uv);
  float elev  = A.r * 2.0 - 1.0;
  float water = A.g;
  float veg   = A.b;
  float snow  = A.a;

  vec4 B = texelFetch(uTexB, ip, 0);
  float biome  = B.g * 255.0;
  float flux   = B.b;
  float scorch = B.a;

  vec4 C = texture(uTexC, uv);
  float moist = C.r;
  float crowd = C.b;

  /* Debug channels. Every field-transport bug in a shader eventually looks
     like "the whole map is the wrong colour", and the only fast way to find
     out which term is wrong is to make the shader show you the raw channel. */
  if (uDebug > 0 && uDebug < 6) {
    vec3 dbg = vec3(0.0);
    if (uDebug == 1) dbg = vec3(water);
    else if (uDebug == 2) dbg = vec3(elev * 0.5 + 0.5);
    else if (uDebug == 3) dbg = vec3(float(int(biome)) / 18.0, mod(biome, 3.0) / 3.0, mod(biome, 6.0) / 6.0);
    else if (uDebug == 4) dbg = vec3(veg);
    else if (uDebug == 5) dbg = vec3(uv, 0.0);
    fragColor = vec4(dbg, 1.0);
    return;
  }

  float isLand = step(water, 0.02);
  float wet    = smoothstep(0.0, 0.05, water);

  // ---- relief -----------------------------------------------------------
  // Neighbour samples must be taken at the HEX neighbours, expressed in texels.
  // Stepping one texel east is one cell east, but stepping one texel "up" is
  // only a half-cell diagonal, because rows are offset by half a cell — and a
  // gradient built on that staircase produces a per-cell checkerboard across
  // the whole ocean. On even rows the row above/below sits one texel to the
  // right of this cell; on odd rows, one texel to the left.
  vec2 t = uTexel;
  vec2 base = lattice + vec2(0.5, 0.5);
  float shift = 1.0 - 2.0 * par;
  vec2 uvE = (base + vec2(1.0, 0.0)) * t;
  vec2 uvW = (base + vec2(-1.0, 0.0)) * t;
  vec2 uvU = (base + vec2(shift, -1.0)) * t;
  vec2 uvD = (base + vec2(shift, 1.0)) * t;

  float hL = texture(uTexA, uvW).r * 2.0 - 1.0;
  float hR = texture(uTexA, uvE).r * 2.0 - 1.0;
  float hD = texture(uTexA, uvD).r * 2.0 - 1.0;
  float hU = texture(uTexA, uvU).r * 2.0 - 1.0;
  // Land relief is exaggerated so mountains read. The sea floor gets a much
  // gentler slope: its elevation range is small, and at high zoom a large
  // multiplier turns its per-cell quantisation into a visible checkerboard.
  float relief = mix(2.5, 9.5, isLand) * (1.0 + uShadeAmt);
  vec3 N = normalize(vec3((hL - hR) * relief, (hD - hU) * relief, 1.0));

  // ---- water surface -----------------------------------------------------
  float px = 1.0 / max(uScale, 1e-4);      // world units per device pixel
  float rf = aliasGuard(2.1, px);
  vec2 wp = world * rf;
  // Domain warp + amplitude modulation. Without these the three waves below are
  // a perfect product of sinusoids on a regular lattice and the ocean becomes a
  // sheet of identical repeating scales. The warp is two extra noise samples
  // and kills the tiling completely.
  vec2 warp = vec2(gnoise(wp * 0.62 + vec2(uTime * 0.10, 0.0)),
                   gnoise(wp * 0.62 + vec2(31.7, -uTime * 0.08))) * 1.5;
  vec2 q = wp + warp;
  float amp = 0.55 + 0.55 * gnoise(wp * 0.29 + 7.3);
  float w1 = sin(q.x * 1.7 + uTime * 1.15);
  float w2 = sin(q.y * 2.4 - uTime * 0.95);
  float w3 = sin((q.x + q.y) * 1.35 + uTime * 1.75);
  float chop = (0.055 + uRain * 0.13) * amp;
  vec3 ripple = normalize(vec3((w1 + w3 * 0.6) * chop, (w2 + w3 * 0.6) * chop, 1.0));
  N = normalize(mix(N, ripple, wet));

  // ---- albedo -----------------------------------------------------------
  vec3 baseC   = texelFetch(uBiome, ivec2(int(biome), 0), 0).rgb;
  vec3 accentC = texelFetch(uBiome, ivec2(int(biome), 1), 0).rgb;

  float canopy = smoothstep(0.02, 0.50, veg);
  // Canopy is allowed to overshoot so that a fully vegetated cell reaches the
  // biome's accent outright. Held back at 0.72 it topped out at less than half
  // the distance to accent, which left every summer forest a desaturated
  // mid-tone and the whole island reading as one beige mass.
  vec3 land = mix(baseC, accentC, clamp(canopy * 1.45, 0.0, 1.0));
  // exposed rock on high ground. Kept slightly warmer than a neutral grey so
  // that a snowless ALPINE massif reads as stone, not as unfinished colour.
  land = mix(land, vec3(0.34, 0.31, 0.30), smoothstep(0.52, 0.88, elev) * 0.32);
  // drought: dry ground desaturates
  float dryness = 1.0 - smoothstep(0.15, 0.55, moist);
  land = mix(land, mix(land, vec3(dot(land, vec3(0.33))), 0.55), dryness * 0.35);
  // snow cover
  land = mix(land, vec3(0.88, 0.92, 0.97), snow * 0.92);

  vec3 shallowC = vec3(0.075, 0.235, 0.270);
  vec3 midC     = vec3(0.030, 0.098, 0.160);
  vec3 deepC    = vec3(0.010, 0.030, 0.068);
  vec3 sea = mix(shallowC, mix(midC, deepC, smoothstep(0.30, 0.95, water)),
                 smoothstep(0.02, 0.42, water));

  vec3 albedo = mix(land, sea, wet);

  if (uDebug == 6) { fragColor = vec4(albedo, 1.0); return; }

  // ---- false colour views ----------------------------------------------
  if (uMode >= 2) {
    vec3 vital;
    if (uMode == 2)      vital = ramp4(veg, vec3(0.05,0.09,0.06), vec3(0.18,0.40,0.20), vec3(0.55,0.72,0.28), vec3(0.88,0.92,0.62));
    else if (uMode == 3) vital = ramp4(A.g, vec3(0.10,0.02,0.30), vec3(0.62,0.10,0.28), vec3(0.92,0.52,0.16), vec3(1.00,0.96,0.80));
    else if (uMode == 4) vital = ramp4(water, vec3(0.55,0.62,0.68), vec3(0.16,0.42,0.62), vec3(0.08,0.20,0.46), vec3(0.03,0.06,0.16));
    else                 vital = ramp4(clamp(flux * 0.7 + scorch * 0.9 + crowd * 0.25, 0.0, 1.0), vec3(0.03,0.02,0.08), vec3(0.42,0.08,0.34), vec3(0.86,0.34,0.22), vec3(1.0,0.92,0.66));
    albedo = mix(albedo, vital, mix(1.0, 0.72, wet));
  }

  // ---- lighting ---------------------------------------------------------
  float ndl = max(0.0, dot(N, uLight));
  float shade = mix(1.0, 0.28 + 0.72 * ndl, uShadeAmt);
  /* The ambient and sun terms must SUM to about one at full daylight, or the
   * whole image is over-exposed and every biome washes out to the same pale
   * value. A fully lit surface lands near 1.0; a shadowed one near 0.3. */
  vec3 lightSum = uAmbient * 0.34 + uLightCol * shade * (0.05 + 0.92 * uDaylight);
  if (uDebug == 7) { fragColor = vec4(lightSum, 1.0); return; }
  vec3 lit = albedo * lightSum;

  // specular glint on water only
  // Water is mostly a mirror of the sky, not a mirror of the sun. A tight
  // specular alone looks wrong twice over: pow(x, 48) on a rippled normal
  // swings hard enough to strobe, and over a deep ocean — which is nearly
  // black — the highlight ends up brighter than the water itself, so the whole
  // sea becomes a lattice of glints. So: a broad Fresnel sky term carries the
  // appearance, and a narrow glint is added on top as a highlight.
  // Viewed from straight above, water reflects only a couple of percent of the
  // sky. A fixed 30% mix therefore turned the deep sea into flat grey and hid
  // the depth grading entirely, so the mix now starts at a physical 2% and only
  // climbs towards grazing angles, and wave shading does the visual work.
  vec3 V = vec3(0.0, 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - clamp(N.z, 0.0, 1.0), 5.0);
  vec3 skyRefl = uLightCol * (0.10 + 0.50 * uDaylight) + uAmbient * 0.35;
  lit *= mix(1.0, 0.88 + 0.26 * (ripple.x * 0.6 + ripple.y * 0.4), wet);
  lit = mix(lit, skyRefl, wet * clamp(fres, 0.0, 0.70));
  vec3 Rv = normalize(reflect(-uLight, N));
  float glint = pow(max(0.0, dot(Rv, V)), 90.0);
  lit += uLightCol * glint * wet * uDaylight * 0.30;
  // moon glitter
  lit += vec3(0.55, 0.68, 0.95) * glint * wet * uNight * 0.20;

  // ---- coast foam -------------------------------------------------------
  float wl = texture(uTexA, uvW).g;
  float wr = texture(uTexA, uvE).g;
  float wd = texture(uTexA, uvD).g;
  float wu = texture(uTexA, uvU).g;
  float nearWater = max(max(wl, wr), max(wd, wu));
  float surf = smoothstep(0.16, 0.0, water) * (1.0 - smoothstep(0.0, 0.22, nearWater));
  float ff = aliasGuard(6.0, px);
  float foam = surf * (0.55 + 0.45 * sin(world.x * ff + world.y * ff * 0.75 - uTime * 2.2));
  lit += vec3(0.55, 0.68, 0.72) * max(foam, 0.0) * 0.30 * (0.3 + 0.7 * uDaylight);

  // ---- rivers -----------------------------------------------------------
  float riv = smoothstep(0.10, 0.45, flux) * (1.0 - scorch);
  albedo = mix(albedo, vec3(0.44, 0.70, 0.80), riv * 0.60);
  float sf = aliasGuard(9.0, px);
  float sparkle = smoothstep(0.55, 1.0, sin(world.x * sf + world.y * sf * 0.68 + uTime * 2.6) * 0.5 + 0.5);
  lit += vec3(0.30, 0.46, 0.52) * riv * sparkle * 0.30;

  // ---- rain ------------------------------------------------------------
  // Multiplicative, not additive. An additive highlight over a deep ocean
  // (which is nearly black) quadruples its brightness wherever a streak lands
  // and turns light drizzle into a bright lattice across the whole sea.
  if (uRain > 0.02) {
    float nf = aliasGuard(4.0, px);
    float streak = smoothstep(0.88, 1.0, vnoise(vec2(world.x * nf, world.y * nf * 0.4 + uTime * 5.0)));
    lit *= 1.0 + streak * uRain * 0.55;
    lit = mix(lit, lit * vec3(0.94, 0.97, 1.03), uRain * 0.5);
  }

  // ---- grid frame ------------------------------------------------------
  // Deep ocean sits within a few percent of the page behind it, so without an
  // edge the world reads as an island floating in a void and the bounds of the
  // simulation are invisible. A hairline makes the rectangle legible.
  vec2 edgeCells = min(uvCell, 1.0 - uvCell) * uWorld;
  float frame = 1.0 - smoothstep(0.0, 1.1, min(edgeCells.x, edgeCells.y));
  lit = mix(lit, lit * 1.9 + vec3(0.030, 0.048, 0.062), frame * 0.85);

  // ---- overlays --------------------------------------------------------
  if (uMode == 1) {
    // Chart mode: flatten the relief and add topology
    float ec = elev * 30.0;
    float cl = gridLine(ec, fwidth(ec)) * uContourAmt;
    lit = mix(lit, albedo * (uAmbient * 0.7 + vec3(0.35)), 0.75);
    lit *= 1.0 - cl * 0.30;
  } else if (uContourAmt > 0.001) {
    float ec = elev * 22.0;
    lit *= 1.0 - gridLine(ec, fwidth(ec)) * uContourAmt * 0.22;
  }

  if (uGridAmt > 0.001) {
    // pointy-top hexagon outline: max of three half-plane tests
    vec2 p = world - vec2(cellTex.x, cellTex.y * uRowV);
    float hexF = max(abs(p.x), 0.5 * abs(p.x) + 0.8660254 * abs(p.y));
    float e = 1.0 - smoothstep(0.0, fwidth(hexF) * 1.4 + 0.002, 0.5 - hexF);
    lit = mix(lit, lit * 1.35 + vec3(0.05, 0.08, 0.10), e * uGridAmt);
  }

  // ---- selection locator ------------------------------------------------
  if (uSelOn > 0.5) {
    vec2 sp = world - vec2(uSelX + 0.5 * mod(floor(uSelY), 2.0), uSelY * uRowV);
    float d = max(abs(sp.x), 0.5 * abs(sp.x) + 0.8660254 * abs(sp.y));
    float ring = smoothstep(0.5, 0.44, d) - smoothstep(0.40, 0.34, d);
    float pulse = 0.55 + 0.45 * sin(uTime * 4.0);
    lit += vec3(0.55, 0.90, 1.0) * ring * pulse * 0.9;
  }

  // ---- night grade ------------------------------------------------------
  // Night should read as moonlight, not as a blue filter over the whole map.
  // Tinting everything toward blue flattens the land into one pale mass and
  // destroys exactly the biome legibility the view exists to provide, so the
  // tint is kept mild and saturation is deliberately put back afterwards.
  vec3 nightTint = vec3(0.66, 0.74, 1.00);
  lit = mix(lit * nightTint, lit, clamp(uDaylight * 1.6, 0.0, 1.0));
  float lum = dot(lit, vec3(0.2126, 0.7152, 0.0722));
  lit = mix(vec3(lum), lit, 1.0 - 0.38 * uNight);

  fragColor = vec4(max(lit, 0.0), 1.0);
}
`;

  /* ---------------------------------------------------------------- agents */

  var AGENT_VS = `#version 300 es
precision highp float;

in vec2 aPos;    // world cell units
in vec4 aData;   // energy, species, state, flags

uniform vec2  uCentre;
uniform float uScale;
uniform vec2  uRes;
uniform float uPointScale;
uniform float uNight;
uniform vec3  uSpecies[16];
uniform float uHeight;

out vec3 vColour;
out float vGlow;
out float vCore;

void main() {
  vec2 frag = vec2(aPos.x, uRes.y - aPos.y);
  vec2 px = (aPos - uCentre) * uScale + uRes * 0.5;
  vec2 clip = px / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

  float energy = aData.x;
  float size = uPointScale * (0.42 + 0.55 * energy + 0.30 * aData.z);
  gl_PointSize = clamp(size, 1.5, 42.0);

  int sp = int(aData.y + 0.5);
  vColour = uSpecies[sp % 16];
  // hungry creatures glow hot, content ones cool: colour carries state
  vGlow = mix(1.6, 0.45, clamp(energy, 0.0, 1.0));
  vGlow *= mix(1.0, 1.7, uNight);
  vCore = aData.w;   // selected
}
`;

  var AGENT_FS = `#version 300 es
precision highp float;

in vec3 vColour;
in float vGlow;
in float vCore;
out vec4 fragColor;

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float halo = exp(-r2 * 3.2);
  float core = exp(-r2 * 14.0);
  vec3 c = vColour * (halo * 0.55 + core * 0.95) * vGlow;
  c += vec3(1.0) * core * vCore * 0.9;
  fragColor = vec4(c, 1.0);
}
`;

  /* ------------------------------------------------------------ post chain */

  var QUAD_VS = SCENE_VS;

  var BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uKnee;
${COMMON}
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float s = max(0.0, l - uThreshold) / max(l, 1e-4);
  fragColor = vec4(c * s * smoothstep(0.0, uKnee, l - uThreshold), 1.0);
}
`;

  var BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uDir;     // texel-sized step along one axis
void main() {
  // 9-tap gaussian collapsed to 5 linearly-interpolated samples
  vec3 c = texture(uTex, vUv).rgb * 0.2270270270;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  c += (texture(uTex, vUv + o1).rgb + texture(uTex, vUv - o1).rgb) * 0.3162162162;
  c += (texture(uTex, vUv + o2).rgb + texture(uTex, vUv - o2).rgb) * 0.0702702703;
  fragColor = vec4(c, 1.0);
}
`;

  var COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uTime;
uniform float uBloomAmt;
uniform float uAberration;
uniform float uGrain;
uniform float uVignette;
uniform float uExposure;
uniform float uScanline;
uniform float uFlash;
uniform float uHasBloom;
uniform vec2  uOutRes;

${COMMON}

void main() {
  vec2 uv = vUv;
  vec2 centred = uv - 0.5;
  float r2 = dot(centred, centred);

  // chromatic aberration grows toward the edges, like a real lens
  float ab = uAberration * (0.25 + r2 * 2.4);
  vec3 scene;
  scene.r = texture(uScene, uv + centred * ab * 0.0035).r;
  scene.g = texture(uScene, uv).g;
  scene.b = texture(uScene, uv - centred * ab * 0.0035).b;

  vec3 bloom = uHasBloom > 0.5 ? texture(uBloom, uv).rgb : vec3(0.0);
  vec3 c = scene + bloom * uBloomAmt;

  // filmic-ish tonemap, keeps highlights from clipping to flat white
  c = vec3(1.0) - exp(-c * uExposure);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));

  // lightning
  c += vec3(0.75, 0.82, 1.0) * uFlash;

  // scanlines: a whisper, not a CRT costume
  c *= 1.0 - uScanline * 0.5 * (0.5 + 0.5 * sin(uv.y * uOutRes.y * 1.55));

  // vignette
  float vig = 1.0 - uVignette * smoothstep(0.18, 0.78, r2);
  c *= vig;

  // Film grain. Keyed off gl_FragCoord, never off uv: multiplying uv by a
  // nominal resolution puts the noise at (nominal / actual) times the pixel
  // rate, and anything above the pixel rate is a shimmering pattern rather
  // than grain. It also showed the hash's own structure as a regular diagonal
  // weave across the dark ocean, which is exactly what it looked like.
  float g = hash21(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
  c += g * uGrain * (1.0 - 0.55 * dot(c, vec3(0.33)));

  fragColor = vec4(c, 1.0);
}
`;

  global.HX = global.HX || {};
  global.HX.Shaders = {
    SCENE_VS: SCENE_VS,
    SCENE_FS: SCENE_FS,
    AGENT_VS: AGENT_VS,
    AGENT_FS: AGENT_FS,
    QUAD_VS: QUAD_VS,
    BRIGHT_FS: BRIGHT_FS,
    BLUR_FS: BLUR_FS,
    COMPOSITE_FS: COMPOSITE_FS,
    COMMON: COMMON
  };

})(typeof window !== 'undefined' ? window : globalThis);