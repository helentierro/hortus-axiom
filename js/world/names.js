/* ============================================================================
 * HORTUS / world/names.js
 *
 * Procedural naming for individuals, species and mutation events.
 *
 * A simulation you are meant to watch for a long time needs to be *legible*:
 * you should be able to say "that's the third Thessa" without the UI showing
 * you a number. Names are drawn from curated phoneme tables and recombined with
 * a seeded RNG, so a world always names itself the same way.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var ONSET = [
    'b', 'br', 'd', 'dr', 'f', 'fl', 'g', 'gr', 'h', 'k', 'kr', 'l', 'm',
    'n', 'p', 'pr', 'r', 's', 'sk', 'sl', 'st', 't', 'th', 'tr', 'v', 'w',
    'y', 'z', 'zh', 'ch', 'kh', 'sh', 'ph', 'vr', 'sil', 'nor', 'tal', 'sel'
  ];

  var NUCLEUS = [
    'a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'ia', 'au', 'ea', 'io', 'ua',
    'y', 'ei', 'ou', 'ui', 'oe', 'aa', 'ee'
  ];

  var CODA = [
    '', '', '', 'n', 'r', 'l', 's', 'th', 'sh', 'rn', 'st', 'll', 'rk',
    'nd', 'sk', 'x', 'm', 'ng', 'ff', 'ld', 'ss'
  ];

  var PREFIX = [
    'Ael', 'Vor', 'Thys', 'Cal', 'Mor', 'Nyr', 'Sel', 'Bram', 'Ori', 'Tav',
    'Zel', 'Khal', 'Iri', 'Durn', 'Fen', 'Ghal', 'Hesper', 'Ilex', 'Corv',
    'Ymir', 'Astr', 'Bel', 'Cyn', 'Dre', 'Ere', 'Fen', 'Gal', 'Hal', 'Ix',
    'Jun', 'Ker', 'Lith', 'Mir', 'Nyx', 'Ors', 'Pel', 'Quen', 'Rhov', 'Sil',
    'Tor', 'Ur', 'Vel', 'Wyr', 'Xan', 'Yl', 'Zar', 'Solv', 'Nyx'
  ];

  var SUFFIX = [
    'an', 'ix', 'or', 'un', 'ai', 'ea', 'is', 'os', 'ur', 'ys', 'en', 'ol',
    'ar', 'ir', 'ax', 'eth', 'ith', 'oth', 'ael', 'ien'
  ];

  var EPITHET = [
    'the Patient', 'the Grey', 'the Long-Nosed', 'the Quiet', 'the Bitter',
    'the Twice-Marked', 'the Elder', 'the Small', 'the Swift', 'the Hollow',
    'the Bright-Eyed', 'the Mute', 'the Wanderer', 'the Scarred', 'the Pale',
    'the Loud', 'the Frozen', 'the Starving', 'the Well-Fed', 'the Unlucky'
  ];

  var EPITHET_HAZARD = [
    'of the Long Winter', 'of the Scorch', 'of the Flood Year',
    'of Nine Seasons', 'of the Silent Spring', 'of the Red Rain',
    'of the Famine', 'of the Bloom', 'of the Ashen Wind'
  ];

  function syllable(rng) {
    var o = ONSET[rng.below(ONSET.length)];
    var n = NUCLEUS[rng.below(NUCLEUS.length)];
    var c = CODA[rng.below(CODA.length)];
    /* avoid awkward triple consonants */
    if (c.length > 1 && o.length > 1 && o.charAt(o.length - 1) === c.charAt(0)) c = c.charAt(1);
    return o + n + c;
  }

  function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /* 2-3 syllables, always at least 3 characters. */
  function given(rng) {
    var n = rng.chance(0.45) ? 3 : 2;
    var s = '';
    for (var i = 0; i < n; i++) s += syllable(rng);
    s = titleCase(s);
    return s;
  }

  /* Species: prefix + suffix, occasionally a two-part Latinate name. */
  function species(rng) {
    var r = rng.next();
    if (r < 0.42) return titleCase(PREFIX[rng.below(PREFIX.length)] + SUFFIX[rng.below(SUFFIX.length)]);
    if (r < 0.78) return titleCase(given(rng) + ' ' + SUFFIX[rng.below(SUFFIX.length)]);
    return titleCase(PREFIX[rng.below(PREFIX.length)] + '-' + given(rng));
  }

  function epithet(rng) { return EPITHET[rng.below(EPITHET.length)]; }
  function hazard(rng) { return EPITHET_HAZARD[rng.below(EPITHET_HAZARD.length)]; }

  /* Deterministic, near-unique individual names. */
  function Namer(rng) {
    var used = {};
    return {
      next: function () {
        for (var attempt = 0; attempt < 40; attempt++) {
          var n = given(rng);
          if (!used[n]) { used[n] = 1; return n; }
        }
        return given(rng) + '-' + rng.below(999);
      },
      reset: function () { used = {}; }
    };
  }

  global.HX = global.HX || {};
  global.HX.Names = {
    given: given,
    species: species,
    epithet: epithet,
    hazard: hazard,
    Namer: Namer
  };

})(typeof window !== 'undefined' ? window : globalThis);