/* ============================================================================
 * HORTUS / audio/audio.js
 *
 * Sonification. The world is not scored with music; it is scored with itself.
 * Every audible parameter is a measurement of the simulation:
 *
 *   drone pitch        latitude-weighted mean temperature
 *   drone brightness   vegetation saturation (the filter opens as the world
 *                      greens up)
 *   pulse tempo        time of day
 *   sub-bass drift     mean creature energy — the population's mood
 *   noise bed          rainfall and wind
 *   events             births, deaths, seasons, extinctions, lightning
 *
 * Nothing is sampled or looped: every sound is synthesised from oscillators
 * and filtered noise, so it never repeats and never needs a download.
 *
 * Started only from a user gesture, per browser autoplay policy.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;

  function Audio(opts) {
    opts = opts || {};
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.volume = opts.volume === undefined ? 0.55 : opts.volume;
    this.nodes = {};
    this.lastEvent = 0;
    this.eventBudget = 0;
    this.available = !!(global.AudioContext || global.webkitAudioContext);
    this.error = null;
  }

  /* ---------------------------------------------------------- lifecycle */

  Audio.prototype.start = function () {
    if (this.started) return true;
    if (!this.available) { this.error = new Error('Web Audio unavailable'); return false; }
    try {
      var Ctor = global.AudioContext || global.webkitAudioContext;
      this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._build();
      this.started = true;
      return true;
    } catch (e) {
      this.error = e;
      this.available = false;
      return false;
    }
  };

  Audio.prototype.stop = function () {
    if (!this.ctx) return;
    try { this.ctx.close(); } catch (e) { /* already closed */ }
    this.ctx = null;
    this.started = false;
  };

  Audio.prototype.setMuted = function (m) {
    this.muted = !!m;
    if (this.nodes.master && this.ctx) {
      this.nodes.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.08);
    }
  };

  Audio.prototype.setVolume = function (v) {
    this.volume = U.clamp01(v);
    if (this.nodes.master && this.ctx && !this.muted) {
      this.nodes.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  };

  /* ------------------------------------------------------------- routing */

  Audio.prototype._build = function () {
    var ctx = this.ctx;
    var now = ctx.currentTime;

    var master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;

    /* A gentle limiter, so a population crash (many simultaneous deaths)
     * does not clip into a nasty crackle. */
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 22;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;

    master.connect(comp);
    comp.connect(ctx.destination);

    /* Generated impulse response: exponentially decaying noise with a slight
     * early-reflection cluster. Cheaper than shipping an IR file and it can be
     * tuned to the room size we want. */
    var conv = ctx.createConvolver();
    conv.buffer = this._impulse(2.6, 2.4);
    var wet = ctx.createGain();
    wet.gain.value = 0.34;
    conv.connect(wet);
    wet.connect(master);

    var dry = ctx.createGain();
    dry.gain.value = 0.82;
    dry.connect(master);

    this.nodes.master = master;
    this.nodes.dry = dry;
    this.nodes.reverb = conv;
    this.nodes.send = ctx.createGain();
    this.nodes.send.gain.value = 1;
    this.nodes.send.connect(conv);

    /* ---- noise source, shared by rain and wind ---- */
    var noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer(6);
    noise.loop = true;
    noise.start(now);

    var rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 2400;
    rainFilter.Q.value = 0.55;
    var rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    noise.connect(rainFilter);
    rainFilter.connect(rainGain);
    rainGain.connect(dry);
    rainGain.connect(this.nodes.send);

    var windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 420;
    windFilter.Q.value = 0.9;
    var windGain = ctx.createGain();
    windGain.gain.value = 0.02;
    noise.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(dry);

    this.nodes.noise = noise;
    this.nodes.rainFilter = rainFilter;
    this.nodes.rainGain = rainGain;
    this.nodes.windFilter = windFilter;
    this.nodes.windGain = windGain;

    /* ---- drone: three detuned saws through a moving lowpass ---- */
    var droneGain = ctx.createGain();
    droneGain.gain.value = 0.0;
    var droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 500;
    droneFilter.Q.value = 3.2;
    droneFilter.connect(droneGain);
    droneGain.connect(dry);
    droneGain.connect(this.nodes.send);

    var oscs = [];
    var detunes = [-7, 0, 6];
    for (var i = 0; i < 3; i++) {
      var o = ctx.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sawtooth';
      o.frequency.value = 55;
      o.detune.value = detunes[i];
      var g = ctx.createGain();
      g.gain.value = i === 2 ? 0.5 : 0.3;
      o.connect(g);
      g.connect(droneFilter);
      o.start(now);
      oscs.push(o);
    }
    this.nodes.droneOsc = oscs;
    this.nodes.droneFilter = droneFilter;
    this.nodes.droneGain = droneGain;

    /* slow filter wobble so the drone never sits still */
    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.06;
    var lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain);
    lfoGain.connect(droneFilter.frequency);
    lfo.start(now);
    this.nodes.lfo = lfo;

    /* ---- sub-bass: the population's mood ---- */
    var sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 41;
    var subGain = ctx.createGain();
    subGain.gain.value = 0;
    sub.connect(subGain);
    subGain.connect(dry);
    sub.start(now);
    this.nodes.sub = sub;
    this.nodes.subGain = subGain;

    /* ---- heartbeat pulse, tempo follows the day ---- */
    this.nodes.pulseGain = ctx.createGain();
    this.nodes.pulseGain.gain.value = 0;
    this.nextPulse = now + 1;
  };

  Audio.prototype._impulse = function (seconds, decay) {
    var ctx = this.ctx;
    var rate = ctx.sampleRate;
    var len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        var t = i / len;
        /* a couple of early reflections give the tail a sense of size */
        var early = (i < rate * 0.021 || (i > rate * 0.037 && i < rate * 0.045)) ? 1.7 : 1.0;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
      }
    }
    return buf;
  };

  Audio.prototype._noiseBuffer = function (seconds) {
    var ctx = this.ctx;
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      /* gently pinked: a plain white noise bed is harsh for minutes on end */
      var w = Math.random() * 2 - 1;
      last = 0.985 * last + 0.015 * w;
      d[i] = last * 3.2 + w * 0.25;
    }
    return buf;
  };

  /* --------------------------------------------------------------- update */

  /*
   * Called every frame. `s` carries the measurements; every one of them is
   * smoothed with setTargetAtTime so a sudden population crash bends the drone
   * instead of clicking it.
   */
  Audio.prototype.update = function (s, dt) {
    if (!this.started || !this.ctx) return;
    var ctx = this.ctx;
    var t = ctx.currentTime;
    var n = this.nodes;
    var smooth = 0.35;

    /* ---- rain ---- */
    var rain = U.clamp01(s.rain || 0);
    n.rainGain.gain.setTargetAtTime(rain * rain * 0.16, t, smooth);
    n.rainFilter.frequency.setTargetAtTime(1400 + rain * 2600, t, smooth);

    /* ---- wind ---- */
    var wind = U.clamp01(s.wind === undefined ? 0.3 : s.wind);
    n.windGain.gain.setTargetAtTime(0.012 + wind * wind * 0.075, t, 0.6);
    n.windFilter.frequency.setTargetAtTime(260 + wind * 620, t, 0.8);

    /* ---- drone ----
     * Pitch rises with temperature and drops at altitude; a low, wide world
     * should sound like one. Scale degrees rather than arbitrary Hz so it
     * stays consonant. */
    var temp = U.clamp01(s.temp === undefined ? 0.5 : s.temp);
    var root = 46.25 * Math.pow(2, U.lerp(-0.42, 0.42, temp));   /* ~41 Hz .. ~66 Hz */
    var detune = (s.meanEnergy === undefined ? 0.4 : U.clamp01(s.meanEnergy));
    for (var i = 0; i < n.droneOsc.length; i++) {
      n.droneOsc[i].frequency.setTargetAtTime(root * (i === 2 ? 2 : 1), t, 1.2);
      n.droneOsc[i].detune.setTargetAtTime((i - 1) * 5 + (0.5 - detune) * 14, t, 1.5);
    }
    /* The filter opens with vegetation: a green world is a brighter world. */
    var green = U.clamp01(s.vegSaturation === undefined ? 0.5 : s.vegSaturation);
    var night = s.night ? 0.55 : 1;
    n.droneFilter.frequency.setTargetAtTime(
      U.lerp(240, 1500, green) * (s.night ? 0.6 : 1) * night, t, 1.4);
    n.droneFilter.Q.setTargetAtTime(2.0 + (1 - green) * 4.0, t, 1.4);

    var alive = U.clamp01(s.population === undefined ? 0.5 : s.population);
    n.droneGain.gain.setTargetAtTime(0.06 + alive * 0.13, t, 0.8);

    /* ---- sub-bass follows mean energy: content animals hum, starving ones
       sag below the drone. */
    var me = s.meanEnergy === undefined ? 0.4 : U.clamp01(s.meanEnergy);
    n.sub.frequency.setTargetAtTime(28 + me * 22, t, 1.6);
    n.subGain.gain.setTargetAtTime(0.035 + me * 0.075, t, 1.2);

    /* ---- pulse ----
     * One soft heartbeat per simulated hour, with the interval stretched by
     * the current speed setting so the tempo tracks the clock, not the frame
     * rate. */
    if (s.dayFrac !== undefined && s.dayFrac < n._lastDayFrac) {
      this._pulse(t, s.population);
    }
    n._lastDayFrac = s.dayFrac === undefined ? 0 : s.dayFrac;
  };

  /* -------------------------------------------------------------- events */

  Audio.prototype._pulse = function (t, strength) {
    var ctx = this.ctx;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(96, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.16);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.10 * U.clamp01(0.3 + strength), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g);
    g.connect(this.nodes.dry);
    g.connect(this.nodes.send);
    o.start(t);
    o.stop(t + 0.5);
  };

  /* Birth: a short bell, pitched by species so the population's mix is
   * audible even before you look at the chart. */
  Audio.prototype.birth = function (speciesId, strength) {
    if (!this.started) return;
    var ctx = this.ctx, t = ctx.currentTime;
    var semis = (speciesId * 3) % 12;
    var f = 523.25 * Math.pow(2, semis / 12);
    var o = ctx.createOscillator();
    var o2 = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = 'sine'; o2.type = 'sine';
    o.frequency.value = f;
    o2.frequency.value = f * 2.005;
    var g2 = ctx.createGain();
    g2.gain.value = 0.3;
    o2.connect(g2); g2.connect(g);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.045 * (strength || 1), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    o.connect(g);
    g.connect(this.nodes.dry);
    g.connect(this.nodes.send);
    o.start(t); o2.start(t);
    o.stop(t + 0.34); o2.stop(t + 0.34);
  };

  /* Death: a filtered noise thud. */
  Audio.prototype.death = function (n) {
    if (!this.started) return;
    if (this._deathBudget === undefined) this._deathBudget = 0;
    if (this._deathBudget > 3) return;
    this._deathBudget++;
    var ctx = this.ctx, t = ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = this._deathNoise || (this._deathNoise = this._noiseBuffer(0.4));
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(420, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 0.2);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    src.connect(f); f.connect(g); g.connect(this.nodes.dry);
    src.start(t); src.stop(t + 0.3);
  };

  Audio.prototype._resetDeathBudget = function () {
    if (this._deathBudget === undefined) this._deathBudget = 0;
    if (this._deathBudget > 0) this._deathBudget--;
  };

  /* Season change: a rising or falling four-note figure. */
  Audio.prototype.season = function (season) {
    if (!this.started) return;
    var ctx = this.ctx, t0 = ctx.currentTime;
    var scale = [0, 4, 7, 11];
    var up = season === 1 || season === 2;
    for (var i = 0; i < 4; i++) {
      var semis = (up ? scale[i] : scale[3 - i]) + (season - 1) * 2;
      var f = 261.63 * Math.pow(2, semis / 12);
      var t = t0 + i * 0.13;
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.035, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g);
      g.connect(this.nodes.dry);
      g.connect(this.nodes.send);
      o.start(t); o.stop(t + 0.55);
    }
  };

  /* Extinction: a low, sour cluster. */
  Audio.prototype.extinction = function () {
    if (!this.started) return;
    var ctx = this.ctx, t = ctx.currentTime;
    var freqs = [58, 61.5, 87, 92.5];
    for (var i = 0; i < freqs.length; i++) {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(freqs[i], t);
      o.frequency.exponentialRampToValueAtTime(freqs[i] * 0.72, t + 2.2);
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 620;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      o.connect(f); f.connect(g);
      g.connect(this.nodes.dry);
      g.connect(this.nodes.send);
      o.start(t); o.stop(t + 2.5);
    }
  };

  Audio.prototype.revival = function () {
    if (!this.started) return;
    var ctx = this.ctx, t0 = ctx.currentTime;
    for (var i = 0; i < 3; i++) {
      var t = t0 + i * 0.18;
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(196 * (i + 1), t);
      o.frequency.exponentialRampToValueAtTime(392 * (i + 1), t + 0.3);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.04, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g);
      g.connect(this.nodes.dry);
      g.connect(this.nodes.send);
      o.start(t); o.stop(t + 0.65);
    }
  };

  Audio.prototype.thunder = function (distance) {
    if (!this.started) return;
    var ctx = this.ctx, t = ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(2.5);
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1200, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 1.6);
    var g = ctx.createGain();
    var amp = 0.16 * U.clamp01(1 - (distance || 0));
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
    src.connect(f); f.connect(g);
    g.connect(this.nodes.dry);
    g.connect(this.nodes.send);
    src.start(t); src.stop(t + 2);
  };

  Audio.prototype.blip = function (freq, dur, type, gain) {
    if (!this.started) return;
    var ctx = this.ctx, t = ctx.currentTime;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq || 880;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain === undefined ? 0.03 : gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.12));
    o.connect(g); g.connect(this.nodes.dry);
    o.start(t); o.stop(t + (dur || 0.12) + 0.05);
  };

  global.HX = global.HX || {};
  global.HX.AudioEngine = Audio;

})(typeof window !== 'undefined' ? window : globalThis);