/* ============================================================================
 * HORTUS / lang/reader.js
 *
 * The AXIOM reader: source text -> s-expression tree.
 *
 * A hand-written scanner rather than a regex stripper, because the shapes the
 * language needs (strings with escapes, nested delimiters, comments that run
 * past the end of the current list) are exactly the ones regular expressions
 * handle badly and a character loop handles for free.
 *
 * Value shapes produced:
 *   number            JS number
 *   string            JS string
 *   boolean           JS boolean
 *   null              nil
 *   array             list, with `.isList = true` on the array itself
 *   {sym: name}       symbol (only produced by quote/quasiquote)
 *   {kw: name}        keyword
 *   {unquote: expr}   ,expr / ,@expr inside a quasiquote
 * ==========================================================================*/
(function (global) {
  'use strict';

  var OPEN = { '(': ')', '[': ']', '{': '}' };
  var CLOSE = { ')': true, ']': true, '}': true };

  function AxiomError(message, pos, line, col) {
    this.name = 'AxiomError';
    this.message = message;
    this.pos = pos;
    this.line = line;
    this.col = col;
    this.axiom = true;
    this.stack = (new Error(message)).stack;
  }
  AxiomError.prototype = Object.create(Error.prototype);
  AxiomError.prototype.toString = function () {
    return this.message + ' (line ' + this.line + ', col ' + this.col + ')';
  };

  function sym(name) { return { sym: name }; }
  function kw(name) { return { kw: name }; }

  function isSymbol(v) { return v !== null && typeof v === 'object' && typeof v.sym === 'string'; }
  function isKeyword(v) { return v !== null && typeof v === 'object' && typeof v.kw === 'string'; }
  function isUnquote(v) { return v !== null && typeof v === 'object' && !!v.unquote; }
  function isList(v) { return Array.isArray(v); }

  /* ------------------------------------------------------------ scanning */

  function Reader(src) {
    this.src = String(src);
    this.pos = 0;
    this.line = 1;
    this.lineStart = 0;
  }

  Reader.prototype.col = function () { return this.pos - this.lineStart + 1; };
  Reader.prototype.fail = function (msg) {
    throw new AxiomError(msg, this.pos, this.line, this.col());
  };

  Reader.prototype.peek = function () { return this.src[this.pos]; };
  Reader.prototype.next = function () {
    var c = this.src[this.pos++];
    if (c === '\n') { this.line++; this.lineStart = this.pos; }
    return c;
  };

  Reader.prototype.skipSpace = function () {
    while (this.pos < this.src.length) {
      var c = this.src[this.pos];
      if (c === ';') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') { this.next(); continue; }
      /* ,@ is a single token */
      return;
    }
  };

  Reader.prototype.readAll = function () {
    var out = [];
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.src.length) break;
      out.push(this.readForm());
    }
    return out;
  };

  Reader.prototype.readForm = function () {
    this.skipSpace();
    if (this.pos >= this.src.length) this.fail('unexpected end of input');
    var c = this.peek();

    if (OPEN[c]) return this.readList(c);
    if (CLOSE[c]) this.fail('unexpected ' + c);
    if (c === '"') return this.readString();
    if (c === "'") { this.next(); return [sym('quote'), this.readForm()]; }
    if (c === '`') { this.next(); return [sym('quasiquote'), this.readForm()]; }
    if (c === ',') {
      this.next();
      if (this.peek() === '@') { this.next(); return { unquote: this.readForm(), splice: true }; }
      return { unquote: this.readForm(), splice: false };
    }
    if (c === '#') return this.readHash();
    if (c === ':') { this.next(); return kw(this.readToken()); }
    return this.readAtom();
  };

  Reader.prototype.readList = function (openChar) {
    var closer = OPEN[openChar];
    this.next(); /* consume the opener */
    var out = [];
    out.isList = true;
    out.delim = openChar;
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.src.length) {
        throw new AxiomError('unclosed list opened at line ' + this.line, this.pos, this.line, this.col());
      }
      var c = this.peek();
      if (c === closer) { this.next(); return out; }
      if (CLOSE[c]) {
        throw new AxiomError('mismatched ' + c + ' (expected ' + closer + ')', this.pos, this.line, this.col());
      }
      /* a bare comma inside a list splices its value in at expansion time */
      if (c === ',') {
        this.next();
        var splice = false;
        if (this.peek() === '@') { this.next(); splice = true; }
        out.push({ unquote: this.readForm(), splice: splice, inList: true });
        continue;
      }
      out.push(this.readForm());
    }
  };

  Reader.prototype.readString = function () {
    this.next(); /* opening quote */
    var buf = '';
    for (;;) {
      if (this.pos >= this.src.length) this.fail('unterminated string');
      var c = this.next();
      if (c === '"') return buf;
      if (c === '\\') {
        if (this.pos >= this.src.length) this.fail('unterminated escape');
        var e = this.next();
        switch (e) {
          case 'n': buf += '\n'; break;
          case 't': buf += '\t'; break;
          case 'r': buf += '\r'; break;
          case '0': buf += '\0'; break;
          case '\\': buf += '\\'; break;
          case '"': buf += '"'; break;
          case 'u': {
            var hex = '';
            for (var k = 0; k < 4 && this.pos < this.src.length; k++) hex += this.next();
            buf += String.fromCharCode(parseInt(hex, 16) || 63);
            break;
          }
          default: buf += e;
        }
        continue;
      }
      buf += c;
    }
  };

  Reader.prototype.readHash = function () {
    this.next(); /* # */
    var c = this.peek();
    if (c === 't' || c === 'f') {
      var s = this.readToken();
      return s === 't' || s === 'true';
    }
    if (c === 'n') { this.readToken(); return null; }
    /* #(...) is an alias for a list, so vectors and lists read alike */
    if (c === '(') return this.readList('(');
    this.fail('unknown reader macro #' + c);
  };

  Reader.prototype.readToken = function () {
    var start = this.pos;
    while (this.pos < this.src.length) {
      var c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '(' || c === ')' ||
          c === '[' || c === ']' || c === '{' || c === '}' || c === '"' || c === ';' ||
          c === "'" || c === '`' || c === ',') break;
      this.pos++;
    }
    if (start === this.pos) this.fail('empty token');
    return this.src.slice(start, this.pos);
  };

  Reader.prototype.readAtom = function () {
    var startLine = this.line, startCol = this.col();
    var tok = this.readToken();
    var num = parseNumber(tok);
    if (num !== null) return num;
    if (tok === '#t' || tok === 'true') return true;
    if (tok === '#f' || tok === 'false') return false;
    if (tok === '#nil' || tok === 'nil' || tok === 'null') return null;
    if (tok === 'else' || tok === '.') return sym(tok);
    var first = tok.charAt(0);
    if (first >= '0' && first <= '9') {
      throw new AxiomError('malformed number "' + tok + '"', this.pos, startLine, startCol);
    }
    return sym(tok);
  };

  /* Returns a number, or null when the token is not numeric. Rejects things
   * like "1.2.3" and "12abc" instead of silently producing NaN. */
  function parseNumber(tok) {
    if (!tok) return null;
    var i = 0, n = tok.length;
    if (tok[i] === '+' || tok[i] === '-') i++;
    var digits = 0, dot = false, expo = false, sawExp = false;
    for (; i < n; i++) {
      var c = tok[i];
      if (c >= '0' && c <= '9') { digits++; continue; }
      if (c === '.' && !dot && !sawExp) { dot = true; continue; }
      if ((c === 'e' || c === 'E') && !sawExp && digits > 0) {
        sawExp = true;
        var j = i + 1;
        if (tok[j] === '+' || tok[j] === '-') j++;
        if (j >= n || tok[j] < '0' || tok[j] > '9') return null;
        i = j - 1;
        continue;
      }
      return null;
    }
    if (digits === 0) return null;
    var v = parseFloat(tok);
    return isNaN(v) ? null : v;
  }

  /* -------------------------------------------------------- pretty print */

  function inspect(v, depth, maxLen) {
    depth = depth || 0;
    maxLen = maxLen || 80;
    if (v === null || v === undefined) return 'nil';
    var t = typeof v;
    if (t === 'number') {
      if (!isFinite(v)) return v > 0 ? 'inf' : '-inf';
      if (Number.isInteger(v)) return String(v);
      return String(Math.round(v * 1e6) / 1e6);
    }
    if (t === 'string') return depth === 0 ? v : JSON.stringify(v);
    if (t === 'boolean') return v ? '#t' : '#f';
    if (t === 'function') return '#<fn>';
    if (isKeyword(v)) return ':' + v.kw;
    if (isUnquote(v)) return (v.splice ? ',@' : ',') + inspect(v.unquote, depth + 1, maxLen);
    if (Array.isArray(v)) {
      if (v.isRawGenome) return '#<genome ' + v.length + '>';
      if (v.isAgent) return '#<agent ' + (v.name || v.id) + '>';
      if (v.isCell) return '#<cell ' + v.col + ',' + v.row + '>';
      if (depth > 6) return '...';
      var parts = [], i;
      for (i = 0; i < v.length; i++) {
        if (v[i] !== null && typeof v[i] === 'object' && v[i].inList && v[i].unquote && v[i].splice) {
          var inner = v[i].unquote;
          if (Array.isArray(inner)) {
            for (var k = 0; k < inner.length; k++) parts.push(inspect(inner[k], depth + 1, maxLen));
            continue;
          }
        }
        parts.push(inspect(v[i], depth + 1, maxLen));
      }
      var s = '(' + parts.join(' ') + ')';
      if (s.length > maxLen) {
        s = '(' + parts.slice(0, 8).join(' ') + ' \u2026 ' + parts.length + ' items)';
      }
      return s;
    }
    if (t === 'object') {
      if (isSymbol(v)) return v.sym;
      if (v.closure) return '#<closure>';
      if (v.builtin) return '#<builtin ' + v.name + '>';
      if (v.dict) {
        var keys = Object.keys(v.dict);
        if (keys.length === 0) return '{}';
        var ps = keys.map(function (k2) { return ':' + k2 + ' ' + inspect(v.dict[k2], depth + 1, maxLen); });
        return '{' + ps.join(' ') + '}';
      }
      /* A plain object is how the simulation API returns records. Render it as
       * a dict rather than raw JSON so the REPL stays readable. */
      var own = Object.keys(v);
      var plain = own.filter(function (k3) {
        return k3 !== 'isAgent' && k3 !== 'isCell' && k3 !== 'isRawGenome' &&
               k3 !== 'ref' && k3 !== 'genome' && k3 !== 'species';
      });
      if (plain.length && plain.length < own.length + 4) {
        var qs = plain.map(function (k4) { return ':' + k4 + ' ' + inspect(v[k4], depth + 1, maxLen); });
        return '{' + qs.join(' ') + '}';
      }
      if (v.genome) return '#<genome ' + v.genome.length + '>';
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  /* Render a s-expression back to source, respecting nesting. */
  function unparse(v, indent, depth) {
    depth = depth || 0;
    indent = indent || 0;
    if (!Array.isArray(v)) return inspect(v, depth + 1);
    var pad = '';
    for (var p = 0; p < indent; p++) pad += '  ';
    var out = '(', line = pad;
    for (var i = 0; i < v.length; i++) {
      var s = unparse(v[i], indent, depth + 1);
      if (line.length + s.length > 74) { out += '\n' + pad + '    '; line = pad + '    '; }
      out += s + ' ';
      line += s + ' ';
    }
    return out.trim() + ')';
  }

  function read(src) {
    var r = new Reader(src);
    return r.readAll();
  }

  function readOne(src) {
    var forms = read(src);
    if (forms.length !== 1) throw new AxiomError('expected exactly one form, got ' + forms.length);
    return forms[0];
  }

  global.HX = global.HX || {};
  global.HX.Reader = {
    Reader: Reader,
    read: read,
    readOne: readOne,
    inspect: inspect,
    unparse: unparse,
    parseNumber: parseNumber,
    sym: sym,
    kw: kw,
    isSymbol: isSymbol,
    isKeyword: isKeyword,
    isUnquote: isUnquote,
    isList: isList,
    AxiomError: AxiomError
  };

})(typeof window !== 'undefined' ? window : globalThis);