/* ============================================================================
 * HORTUS / lang/interp.js
 *
 * A tree-walking evaluator for AXIOM.
 *
 * Deliberately a tree-walker rather than a closure compiler. For a language
 * whose programs are typed into a REPL, readable traces beat a 4x speedup, and
 * a step budget makes an accidental infinite loop a reportable error instead
 * of a frozen tab.
 *
 * The budget is the important part. AXIOM programs drive a live simulation
 * with side effects, so "this loop has no exit" is not a theoretical problem —
 * it is the first thing anyone types. Every evaluation step decrements a
 * counter; running out raises an AxiomError the REPL can display, with the
 * simulation left in whatever (consistent) state it had reached.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var R = global.HX.Reader;
  var U = global.HX.U;
  var sym = R.sym, isSym = R.isSymbol, isKw = R.isKeyword, isUnquote = R.isUnquote;

  /* ------------------------------------------------------------- values */

  function Closure(env, params, rest, body, name) {
    this.env = env;
    this.params = params;
    this.rest = rest;
    this.body = body;
    this.name = name || 'anonymous';
    this.closure = true;
  }

  function Env(parent) {
    this.vars = Object.create(null);
    this.parent = parent || null;
  }
  Env.prototype.get = function (name) {
    var e = this;
    while (e) {
      var v = e.vars[name];
      if (v !== undefined) return v;
      e = e.parent;
    }
    return undefined;
  };
  Env.prototype.has = function (name) {
    var e = this;
    while (e) { if (e.vars[name] !== undefined) return true; e = e.parent; }
    return false;
  };
  Env.prototype.set = function (name, v) {
    var e = this;
    while (e) {
      if (e.vars[name] !== undefined) { e.vars[name] = v; return true; }
      e = e.parent;
    }
    return false;
  };
  Env.prototype.define = function (name, v) { this.vars[name] = v; return v; };

  function makeBuiltin(name, fn, opts) {
    var b = { name: name, fn: fn, builtin: true };
    if (opts) Object.assign(b, opts);
    return b;
  }

  function isCallable(v) { return v !== null && typeof v === 'object' && (v.builtin || v.closure); }
  function truthy(v) {
    /* Everything except #f and nil is true. 0 and "" are true — a language
     * where (if 0 ...) surprises people is a language people stop using. */
    return v !== false && v !== null && v !== undefined;
  }

  /* ---------------------------------------------------------- interpreter */

  function Interp(opts) {
    opts = opts || {};
    this.global = new Env(null);
    this.stepBudget = opts.stepBudget || 4000000;
    this.steps = 0;
    this.depth = 0;
    this.maxDepth = opts.maxDepth || 600;
    this.stack = [];
    this.gensymCount = 0;
    this.output = [];
    this.maxOutput = opts.maxOutput || 20000;
    this.trace = null;
  }

  Interp.prototype.reset = function (budget) {
    this.steps = 0;
    this.depth = 0;
    this.stack.length = 0;
    this.output.length = 0;
    if (budget) this.stepBudget = budget;
  };

  Interp.prototype.burn = function (n) {
    this.steps += (n === undefined ? 1 : n);
    if (this.steps > this.stepBudget) {
      throw new R.AxiomError('step budget exhausted (' + this.stepBudget.toLocaleString('en-US') +
        ' evaluations) — the program is probably looping forever');
    }
  };

  Interp.prototype.write = function (text) {
    this.output.push(text);
    if (this.output.length > this.maxOutput) this.output.shift();
  };

  Interp.prototype.error = function (msg) { throw new R.AxiomError(msg); };

  /* ------------------------------------------------------------- eval */

  Interp.prototype.eval = function (form, env) {
    this.burn();
    var t = typeof form;

    if (form === null) return null;
    if (t === 'number' || t === 'string' || t === 'boolean') return form;
    if (t === 'function') return form;

    if (Array.isArray(form)) return this.evalList(form, env || this.global);
    if (t !== 'object') return form;

    if (isSym(form)) {
      var name = form.sym;
      var path = splitPath(name);
      if (path) {
        var base = (env || this.global).get(path[0]);
        if (base === undefined) throw new R.AxiomError('unbound symbol: ' + path[0]);
        return this.propertyOf(base, path[1]);
      }
      var v = (env || this.global).get(name);
      if (v === undefined) {
        /* #t / #f / nil are ordinary bindings, but a bare unbound symbol is
         * almost always a typo, so say which one */
        throw new R.AxiomError('unbound symbol: ' + name);
      }
      return v;
    }
    if (isKw(form)) return form;
    if (isUnquote(form)) this.error("unquote ',' used outside a quasiquote");
    if (form.genome) return form;
    if (form.closure || form.builtin) return form;
    if (form.dict) return form;
    if (form.isAgent || form.isCell) return form;

    return form;
  };

  Interp.prototype.evalList = function (form, env) {
    if (form.length === 0) return form;
    var head = form[0];

    /* literals */
    if (isSym(head)) {
      var name = head.sym;
      switch (name) {
        case 'quote': return form[1] !== undefined ? form[1] : null;
        case 'quasiquote': return this.quasi(form[1], env || this.global, 1);
      }
      var special = this.specials[name];
      if (special) return special(this, form, env || this.global);
      /* (obj.method arg) — a dotted symbol in head position is a property
         * lookup followed by an application */
      var hpath = splitPath(name);
      if (hpath) {
        var hbase = (env || this.global).get(hpath[0]);
        if (hbase === undefined) throw new R.AxiomError('unbound symbol: ' + hpath[0]);
        var hfn = this.propertyOf(hbase, hpath[1]);
        if (hfn === null) throw new R.AxiomError('no such property: ' + name);
        var hargs = [];
        for (var hi = 1; hi < form.length; hi++) hargs.push(this.eval(form[hi], env));
        return this.apply(hfn, hargs);
      }
    }

    /* splice markers in a call position evaluate to a list which is then
     * spliced into the argument list */
    if (isUnquote(head) && head.splice) {
      var headVal = this.eval(head.unquote, env);
      var args = [];
      for (var i = 1; i < form.length; i++) args.push(this.eval(form[i], env));
      var tail = Array.isArray(headVal) ? headVal : [headVal];
      return this.apply(headVal, tail.concat(args));
    }

    var fn = this.eval(head, env);
    var argv = [];
    for (var i = 1; i < form.length; i++) {
      var a = form[i];
      if (isUnquote(a) && a.splice && a.inList) {
        var av = this.eval(a.unquote, env);
        if (Array.isArray(av)) {
          for (var k = 0; k < av.length; k++) argv.push(av[k]);
          continue;
        }
      }
      argv.push(this.eval(a, env));
    }
    return this.apply(fn, argv);
  };

  /* ---------------------------------------------------------- quasiquote */

  Interp.prototype.quasi = function (form, env, depth) {
    if (isUnquote(form)) return this.eval(form.unquote, env);
    if (!Array.isArray(form)) return form;
    var out = [];
    out.isList = true;
    for (var i = 0; i < form.length; i++) {
      var f = form[i];
      if (isUnquote(f) && f.inList && f.splice) {
        var v = this.eval(f.unquote, env);
        if (Array.isArray(v)) { for (var k = 0; k < v.length; k++) out.push(v[k]); continue; }
        out.push(v);
        continue;
      }
      if (depth > 1 && Array.isArray(f)) out.push(this.quasi(f, env, depth - 1));
      else out.push(this.quasi(f, env, depth));
    }
    return out;
  };

  /* ------------------------------------------------------------- apply */

  Interp.prototype.apply = function (fn, args) {
    this.burn();
    if (fn === null || fn === undefined) this.error('attempted to call nil');
    if (typeof fn === 'number' || typeof fn === 'string' || typeof fn === 'boolean') {
      this.error('attempted to call ' + R.inspect(fn, 3) + ' as a function');
    }
    if (fn.builtin) return fn.fn.apply(null, args);
    if (fn.closure) return this.callClosure(fn, args);
    this.error('not a function: ' + R.inspect(fn, 3));
  };

  Interp.prototype.callClosure = function (fn, args) {
    if (++this.depth > this.maxDepth) {
      this.depth--;
      throw new R.AxiomError('maximum call depth exceeded (' + this.maxDepth + ') — infinite recursion?');
    }
    var env = new Env(fn.env);
    var i, p;
    for (i = 0; i < fn.params.length; i++) {
      p = fn.params[i];
      env.define(isSym(p) ? p.sym : String(p), args[i] === undefined ? null : args[i]);
    }
    if (fn.rest) {
      var extra = args.slice(fn.params.length);
      extra.isList = true;
      env.define(fn.rest, extra);
    }
    /* The body is already a list of forms. Handing each one to evalBody in
     * turn would treat `(* x x)` as a body containing the single form `*` and
     * return the operator instead of calling it. */
    var result;
    try {
      result = this.evalBody(fn.body, env);
    } catch (e) {
      /* The interpreter is recursive all the way down, so a runaway program
       * can exhaust the JavaScript stack before maxDepth is reached. That is
       * an implementation detail the person at the REPL should never see. */
      if (e && e instanceof RangeError && /call stack/i.test(e.message || '')) {
        this.depth--;
        throw new R.AxiomError('maximum call depth exceeded — infinite recursion?');
      }
      throw e;
    }
    this.depth--;
    return result;
  };

  /* Invoke a callback with a value, and with its index only if the callback
   * actually declares a second parameter.
   *
   * Passing the index unconditionally is a trap: `(map + (list 1 2 3))` would
   * silently sum each element with its own index, because `+` is variadic and
   * cannot refuse the extra argument. Arity-sniffing keeps the convenient
   * indexed iteration available to user functions without corrupting every
   * variadic builtin. */
  Interp.prototype.withIndex = function (fn, value, index) {
    if (fn && fn.closure && fn.params.length >= 2) return this.apply(fn, [value, index]);
    return this.apply(fn, [value]);
  };

  /* Same idea for reduce-style callbacks, which receive (acc, value, index). */
  Interp.prototype.withIndex3 = function (fn, acc, value, index) {
    if (fn && fn.closure && fn.params.length >= 3) return this.apply(fn, [acc, value, index]);
    if (fn && fn.closure && fn.params.length === 2) return this.apply(fn, [acc, value]);
    return this.apply(fn, [acc, value]);
  };

  /* Body semantics: a body is a SEQUENCE of forms. Every form but the last is
     * evaluated for effect; the last supplies the value. Passing the body as a
     * bare array to `eval` instead would evaluate it as a single call — which
     * is how `(if c 1 2)` turns into "call the list (1 2)". */
  Interp.prototype.evalBody = function (forms, env) {
    if (!Array.isArray(forms) || forms.length === 0) return null;
    for (var i = 0; i < forms.length - 1; i++) this.eval(forms[i], env);
    return this.eval(forms[forms.length - 1], env);
  };

  /* ----------------------------------------------------- special forms */

  function arg(form, i) { return form[i]; }

  Interp.prototype.specials = {};

  Interp.prototype.specials['if'] = function (I, form, env) {
    this_check(I, form, 3);
    return truthy(I.eval(form[1], env)) ? I.eval(form[2], env)
      : (form.length > 3 ? I.eval(form[3], env) : null);
  };

  Interp.prototype.specials['cond'] = function (I, form, env) {
    for (var i = 1; i < form.length; i++) {
      var clause = form[i];
      if (!Array.isArray(clause) || clause.length === 0) I.error('cond clause must be a list');
      var test = clause[0];
      if (isSym(test) && test.sym === 'else') return I.evalBody(clause.slice(1), env);
      if (truthy(I.eval(test, env))) return I.evalBody(clause.slice(1), env);
    }
    return null;
  };

  Interp.prototype.specials['when'] = function (I, form, env) {
    if (!truthy(I.eval(form[1], env))) return null;
    return I.evalBody(form.slice(2), env);
  };

  Interp.prototype.specials['unless'] = function (I, form, env) {
    if (truthy(I.eval(form[1], env))) return null;
    return I.evalBody(form.slice(2), env);
  };

  Interp.prototype.specials['and'] = function (I, form, env) {
    var last = null;
    for (var i = 1; i < form.length; i++) {
      last = I.eval(form[i], env);
      if (!truthy(last)) return last;
    }
    return last;
  };

  Interp.prototype.specials['or'] = function (I, form, env) {
    for (var i = 1; i < form.length; i++) {
      var v = I.eval(form[i], env);
      if (truthy(v)) return v;
    }
    return null;
  };

  Interp.prototype.specials['not'] = function (I, form, env) {
    return !truthy(I.eval(form[1], env));
  };

  Interp.prototype.specials['do'] = function (I, form, env) {
    if (form.length === 1) return null;
    var result = null;
    for (var i = 1; i < form.length - 1; i++) result = I.eval(form[i], env);
    return I.eval(form[form.length - 1], env);
  };

  Interp.prototype.specials['begin'] = Interp.prototype.specials['do'];

  Interp.prototype.specials['let'] = function (I, form, env) {
    var bindings = form[1];
    if (!Array.isArray(bindings)) I.error('let requires a binding list');
    var local = new Env(env);
    for (var i = 0; i < bindings.length; i++) {
      var b = bindings[i];
      if (!Array.isArray(b) || b.length === 0) I.error('malformed let binding');
      var nm = isSym(b[0]) ? b[0].sym : String(b[0]);
      local.define(nm, b.length > 1 ? I.eval(b[1], local) : null);
    }
    var result = null;
    for (var j = 2; j < form.length; j++) result = I.eval(form[j], local);
    return result;
  };

  Interp.prototype.specials['let*'] = function (I, form, env) {
    var bindings = form[1];
    var local = new Env(env);
    var result = null;
    for (var i = 0; i < bindings.length; i++) {
      var b = bindings[i];
      if (!Array.isArray(b) || b.length === 0) I.error('malformed let* binding');
      var nm = isSym(b[0]) ? b[0].sym : String(b[0]);
      local.define(nm, b.length > 1 ? I.eval(b[1], local) : null);
    }
    for (var j = 2; j < form.length; j++) result = I.eval(form[j], local);
    return result;
  };

  Interp.prototype.specials['define'] = function (I, form, env) {
    var target = form[1];
    if (isSym(target)) {
      var value = form.length > 2 ? I.eval(form[2], env) : null;
      if (env === I.global) I.global.define(target.sym, value);
      else env.define(target.sym, value);
      return I.silent(target.sym, value);
    }
    if (Array.isArray(target)) {
      /* (define (f a b) ...) */
      var nm2 = isSym(target[0]) ? target[0].sym : String(target[0]);
      var fn = I.makeFunction(target.slice(1), form.slice(2), env, nm2);
      I.global.define(nm2, fn);
      return I.silent(nm2, fn);
    }
    I.error('define expects a name or (name args...)');
  };
  Interp.prototype.specials['def'] = Interp.prototype.specials['define'];
  Interp.prototype.specials['defn'] = Interp.prototype.specials['define'];

  Interp.prototype.specials['set!'] = function (I, form, env) {
    var nm = isSym(form[1]) ? form[1].sym : String(form[1]);
    var v = I.eval(form[2], env);
    if (!env.set(nm, v)) {
      if (env !== I.global) I.error('cannot set! undefined local "' + nm + '"');
      I.global.define(nm, v);
    }
    return v;
  };

  Interp.prototype.specials['fn'] = function (I, form, env) { return I.makeFunction(form[1], form.slice(2), env); };
  Interp.prototype.specials['lambda'] = Interp.prototype.specials['fn'];

  Interp.prototype.makeFunction = function (params, body, env, name) {
    var names = [];
    var rest = null;
    if (params !== undefined && params !== null) {
      if (!Array.isArray(params)) this.error('parameter list must be a list');
      for (var i = 0; i < params.length; i++) {
        var p = params[i];
        if (isSym(p) && p.sym.charAt(0) === '&') {
          rest = p.sym.charAt(1) === '&' ? p.sym.slice(2) : p.sym.slice(1);
          continue;
        }
        if (!isSym(p)) this.error('bad parameter name: ' + R.inspect(p, 2));
        names.push(p.sym);
      }
    }
    return new Closure(env, names, rest, body, name);
  };

  Interp.prototype.specials['while'] = function (I, form, env) {
    var iterations = 0;
    for (;;) {
      I.burn();
      if (!truthy(I.eval(form[1], env))) break;
      for (var i = 2; i < form.length; i++) I.eval(form[i], env);
      if (++iterations % 512 === 0) I.burn(512);
    }
    return null;
  };

  Interp.prototype.specials['repeat'] = function (I, form, env) {
    var n = I.eval(form[1], env);
    if (typeof n !== 'number') I.error('repeat expects a number');
    for (var i = 0; i < n; i++) {
      I.burn();
      for (var j = 2; j < form.length; j++) I.eval(form[j], env);
    }
    return n;
  };

  Interp.prototype.specials['each'] = function (I, form, env) {
    var coll = I.eval(form[1], env);
    var fn = I.eval(form[2], env);
    var keys = null;
    if (coll && typeof coll === 'object' && coll.dict) keys = Object.keys(coll.dict);
    if (keys) {
      for (var k = 0; k < keys.length; k++) I.apply(fn, [coll.dict[keys[k]], R.kw(keys[k])]);
      return null;
    }
    if (!Array.isArray(coll)) I.error('each expects a list or dict');
    for (var i = 0; i < coll.length; i++) I.apply(fn, [coll[i], i]);
    return null;
  };

  /* (defmacro name (params) body) and (defmacro (name params) body) both work;
   * the first is far more readable, the second matches `define`. */
  Interp.prototype.specials['defmacro'] = function (I, form, env) {
    var nm, params, body;
    if (isSym(form[1])) {
      nm = form[1].sym;
      params = form[2];
      body = form.slice(3);
    } else {
      var target = form[1];
      if (!Array.isArray(target)) I.error('defmacro expects (name params) or name');
      nm = isSym(target[0]) ? target[0].sym : String(target[0]);
      params = target.slice(1);
      body = form.slice(2);
    }
    var fn = I.makeFunction(params, body, env, nm);
    var macro = makeBuiltin(nm, function () {
      return I.apply(fn, Array.prototype.slice.call(arguments));
    }, { macro: true });
    I.global.define(nm, macro);
    return I.silent(nm, macro);
  };

  /* ------------------------------------------------- property access */

  /* `obj.field` and `obj.a.b`. Dicts ({dict: {...}}) are unwrapped.
   *
   * Agent and cell references are read LIVE rather than snapshot. A cell ref
   * is a plain object built by `cell()`; if `c.veg` returned the value at the
   * moment the ref was made, then `(bloom! c 3)` followed by `c.veg` would
   * report the pre-bloom number and quietly lie about the simulation. Agent
   * refs point at the agent itself, so their fields are always current. */
  Interp.prototype.propertyOf = function (base, path) {
    var v = base;
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (v === null || v === undefined) return null;
      var key = parts[i];
      if (v.isAgent && v.ref) {
        v = v.ref[key];
        if (v === undefined) v = null;
      } else if (v.isCell && this.host && this.host.world && typeof v.index === 'number') {
        if (key === 'index') {
          v = v.index;
        } else {
          var live = this.host.world[key];
          /* column and row live on the grid, not the world */
          if (!live && this.host.world.grid) live = this.host.world.grid[key];
          v = (live && typeof live.length === 'number') ? live[v.index] : null;
        }
      } else if (typeof v === 'object' && v.dict) {
        var inner = v.dict[key];
        v = inner === undefined ? null : inner;
      } else if (typeof v === 'object' || typeof v === 'function') {
        v = v[key];
        if (v === undefined) v = null;
      } else {
        return null;
      }
    }
    return v === undefined ? null : v;
  };

  /* Split `a.b.c` into ['a', 'b.c]; returns null when there is no dot. */
  function splitPath(name) {
    var d = name.indexOf('.');
    if (d <= 0 || d === name.length - 1) return null;
    return [name.slice(0, d), name.slice(d + 1)];
  }

  /* Macros expand before argument evaluation, at the head of a list. */
  var interpProto = Interp.prototype;
  var originalEvalList = interpProto.evalList;
  interpProto.evalList = function (form, env) {
    if (form.length && isSym(form[0])) {
      var m = (env || this.global).get(form[0].sym);
      if (m && m.macro) {
        var args = [];
        for (var i = 1; i < form.length; i++) args.push(form[i]);
        var expansion = this.apply(m, args);
        this.burn();
        return this.eval(expansion, env || this.global);
      }
    }
    /* A stack overflow can surface anywhere in the recursive evaluator; catch
     * it here so every runaway program gets the same readable message. */
    try {
      return originalEvalList.call(this, form, env);
    } catch (e) {
      if (e && e instanceof RangeError && /call stack/i.test(e.message || '')) {
        this.depth = 0;
        throw new R.AxiomError('maximum call depth exceeded — infinite recursion?');
      }
      throw e;
    }
  };

  /* ------------------------------------------------------------- helpers */

  /* `define` returns a silent marker rather than the value, so a REPL does
   * not echo `5` after `(define x 5)` and drown the real output. */
  Interp.prototype.silent = function (name, value) {
    return { define: true, sym: name, value: value };
  };

  Interp.prototype.isSilent = function (v) {
    return v !== null && typeof v === 'object' && v.define === true;
  };

  function this_check(I, form, min) {
    if (form.length < min) I.error('too few arguments to ' + R.inspect(form[0], 2));
  }
  function arg(form, i) { return form[i]; }

  function number(v, who) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null || v === undefined) throw new R.AxiomError((who || 'argument') + ': expected a number, got nil');
    if (typeof v === 'string') {
      var n = R.parseNumber(v);
      if (n !== null) return n;
    }
    throw new R.AxiomError((who || 'argument') + ': expected a number, got ' + R.inspect(v, 3));
  }

  Interp.prototype.toNumber = number;
  Interp.prototype.toString = function (v) {
    if (typeof v === 'string') return v;
    if (v === null) return '';
    return R.inspect(v, 3);
  };

  /* Run a sequence of top-level forms, collecting printed output. */
  Interp.prototype.run = function (forms, env, opts) {
    opts = opts || {};
    this.reset(opts.budget);
    var results = [];
    var error = null;
    var outLen = this.output.length;
    for (var i = 0; i < forms.length; i++) {
      try {
        var v = this.eval(forms[i], env || this.global);
        if (opts.collect !== false) results.push(v);
      } catch (e) {
        error = e;
        break;
      }
    }
    return {
      results: results,
      value: results.length ? results[results.length - 1] : null,
      error: error,
      steps: this.steps,
      output: this.output.slice(outLen).join('')
    };
  };

  global.HX = global.HX || {};
  global.HX.Interp = Interp;
  global.HX.Env = Env;
  global.HX.Closure = Closure;
  global.HX.makeBuiltin = makeBuiltin;
  global.HX.isCallable = isCallable;
  global.HX.truthy = truthy;
  global.HX.toNumber = number;

})(typeof window !== 'undefined' ? window : globalThis);