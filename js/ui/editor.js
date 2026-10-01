/* ============================================================================
 * HORTUS / ui/editor.js
 *
 * A code editor built from a textarea, a highlight layer and a gutter.
 *
 * Why not a real editor component: there is no build step in this project, no
 * package manager, and no network. A textarea plus a synchronised <pre> gives
 * native text editing (IME, undo, selection, accessibility) for free, and the
 * highlighter is ~120 lines of tokeniser.
 *
 * The one non-obvious requirement: the textarea's text must be transparent
 * with a visible caret, and the <pre> beneath must render the same glyphs at
 * exactly the same metrics. Any difference and the caret drifts away from the
 * text it is supposed to be sitting in.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var U = global.HX.U;

  /* Token kinds and their classes. Ordered by priority in the regex. */
  var SPECIALS = {
    'define': 1, 'def': 1, 'defn': 1, 'set!': 1, 'let': 1, 'let*': 1,
    'if': 1, 'cond': 1, 'when': 1, 'unless': 1, 'do': 1, 'begin': 1,
    'and': 1, 'or': 1, 'not': 1, 'fn': 1, 'lambda': 1, 'quote': 1,
    'quasiquote': 1, 'while': 1, 'repeat': 1, 'each': 1, 'defmacro': 1,
    'else': 1
  };

  var TOKEN_RE = new RegExp([
    /"(?:[^"\\\n]|\\.)*"?/.source,               /* string */
    /;[^\n]*/.source,                             /* comment */
    /-?\d+\.?\d*(?:[eE][-+]?\d+)?/.source,        /* number */
    /'(?:[^\s()\[\]'",`;]*)/.source,              /* quote sugar */
    /`(?:[^\s()\[\]'",`;]*)/.source,              /* quasiquote sugar */
    /,@?/.source,                                 /* unquote */
    /[()\[\]]/.source,                            /* delimiters */
    /[^\s()\[\]'",`;]+/.source,                   /* symbol */
    /\s+/.source,                                 /* whitespace */
    /[\s\S]/.source                               /* anything else */
  ].join('|'), 'g');

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* Tokenise into [{text, cls}] so head position can be detected by looking
   * at the next token, which a single-pass regex cannot do. */
  function tokenize(src) {
    var out = [];
    var m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(src)) !== null) {
      if (m[0] === '') { TOKEN_RE.lastIndex++; continue; }
      out.push({ text: m[0], kind: classify(m[0]), start: m.index });
    }
    return out;
  }

  function classify(t) {
    if (t === '(' || t === ')' || t === '[' || t === ']' || t === '{' || t === '}') return 'delim';
    if (t[0] === ';') return 'comment';
    if (t[0] === '"') return 'string';
    if (/^-?\d/.test(t)) return 'number';
    if (t[0] === "'" || t[0] === '`') return 'quote';
    if (t[0] === ',') return 'unquote';
    if (/^[^\s()\[\]'",`;]+$/.test(t)) return 'symbol';
    return 'plain';
  }

  function highlight(src, env) {
    var toks = tokenize(src);
    var parts = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      var cls = t.kind;
      if (cls === 'symbol') {
        var name = t.text;
        if (SPECIALS[name]) cls = 'special';
        else {
          /* head position: next non-space token is an opener */
          var j = i + 1;
          while (j < toks.length && toks[j].kind === 'plain') j++;
          var isHead = j < toks.length && (toks[j].text === '(');
          var isKnown = env && env.has && env.has(name);
          cls = isKnown ? 'known' : (isHead ? 'call' : 'var');
        }
      }
      parts.push('<span class="tk-' + cls + '">' + escapeHtml(t.text) + '</span>');
    }
    /* a trailing newline needs a placeholder or the last line has no height */
    return parts.join('') + '\n';
  }

  /* ================================================================ Editor */

  function Editor(opts) {
    opts = opts || {};
    this.root = opts.root;
    this.onRun = opts.onRun || function () {};
    this.onChange = opts.onChange || function () {};
    this.env = opts.env || null;
    this.tabWidth = opts.tabWidth || 2;

    this.gutter = document.createElement('div');
    this.gutter.className = 'ed-gutter';

    this.pre = document.createElement('pre');
    this.pre.className = 'ed-highlight';
    this.pre.setAttribute('aria-hidden', 'true');

    this.ta = document.createElement('textarea');
    this.ta.className = 'ed-input';
    this.ta.spellcheck = false;
    this.ta.autocapitalize = 'off';
    this.ta.autocomplete = 'off';
    this.ta.setAttribute('autocorrect', 'off');
    this.ta.setAttribute('aria-label', 'AXIOM program source');
    this.ta.wrap = 'off';

    this.wrap = document.createElement('div');
    this.wrap.className = 'ed-wrap';
    this.wrap.appendChild(this.pre);
    this.wrap.appendChild(this.ta);
    this.root.appendChild(this.gutter);
    this.root.appendChild(this.wrap);

    this._bind();
    this.setValue(opts.value || '');
  }

  Editor.prototype._bind = function () {
    var self = this;
    var ta = this.ta;

    ta.addEventListener('input', function () { self._render(); self.onChange(ta.value); });
    ta.addEventListener('scroll', function () { self._syncScroll(); });
    ta.addEventListener('keydown', function (e) { self._onKey(e); });
    this.root.addEventListener('scroll', function () { self._syncScroll(); });
    window.addEventListener('resize', function () { self._syncScroll(); });
  };

  Editor.prototype._onKey = function (e) {
    var ta = this.ta;
    var key = e.key;

    if (key === 'Tab') {
      e.preventDefault();
      var s = ta.selectionStart, en = ta.selectionEnd;
      if (e.shiftKey) {
        /* outdent the current line */
        var lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
        var lead = ta.value.slice(lineStart, lineStart + this.tabWidth);
        if (/^ +$/.test(lead) && lead.length) {
          ta.value = ta.value.slice(0, lineStart) + ta.value.slice(lineStart + lead.length);
          ta.selectionStart = ta.selectionEnd = s - lead.length;
        }
      } else {
        ta.value = ta.value.slice(0, s) + ' '.repeat(this.tabWidth) + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + this.tabWidth;
      }
      this._render(); this.onChange(ta.value);
      return;
    }

    if (key === 'Enter') {
      /* keep the indentation of the line we are leaving */
      var pos = ta.selectionStart;
      var lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
      var line = ta.value.slice(lineStart, pos);
      var indent = (line.match(/^\s*/) || [''])[0];
      var opensParen = /[([{]\s*$/.test(line.replace(/;.*$/, ''));
      if (opensParen) indent += ' '.repeat(this.tabWidth);
      e.preventDefault();
      var v = ta.value;
      ta.value = v.slice(0, pos) + '\n' + indent + v.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length;
      this._render(); this.onChange(ta.value);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && key === 'Enter') {
      e.preventDefault();
      this.onRun(ta.value);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && key === '/') {
      e.preventDefault();
      this.toggleComment();
    }
  };

  Editor.prototype.toggleComment = function () {
    var ta = this.ta;
    var v = ta.value;
    var s = ta.selectionStart, e = ta.selectionEnd;
    var lineStart = v.lastIndexOf('\n', s - 1) + 1;
    var lineEnd = v.indexOf('\n', e);
    if (lineEnd < 0) lineEnd = v.length;
    var block = v.slice(lineStart, lineEnd);
    var lines = block.split('\n');
    var allCommented = lines.every(function (l) { return /^\s*;/.test(l) || !l.trim(); });
    var out = lines.map(function (l) {
      if (!l.trim()) return l;
      return allCommented ? l.replace(/^(\s*);\s?/, '$1') : l.replace(/^(\s*)/, '$1; ');
    }).join('\n');
    ta.value = v.slice(0, lineStart) + out + v.slice(lineEnd);
    ta.selectionStart = lineStart;
    ta.selectionEnd = lineStart + out.length;
    this._render();
    this.onChange(ta.value);
  };

  Editor.prototype.getValue = function () { return this.ta.value; };

  Editor.prototype.setValue = function (v) {
    this.ta.value = v === undefined || v === null ? '' : String(v);
    this._render();
    this._syncScroll();
  };

  Editor.prototype.insert = function (text) {
    var ta = this.ta;
    var s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus();
    this._render();
    this.onChange(ta.value);
  };

  Editor.prototype.focus = function () { this.ta.focus(); };

  Editor.prototype.setEnv = function (env) { this.env = env; this._render(); };

  Editor.prototype._render = function () {
    var text = this.ta.value;
    this.pre.innerHTML = highlight(text, this.env);
    /* gutter line numbers */
    var lines = text.split('\n').length;
    if (this._lineCount !== lines) {
      this._lineCount = lines;
      var buf = [];
      for (var i = 1; i <= lines; i++) buf.push(i);
      this.gutter.textContent = buf.join('\n');
    }
    this._syncScroll();
  };

  Editor.prototype._syncScroll = function () {
    this.gutter.style.transform = 'translateY(' + (-this.ta.scrollTop) + 'px)';
    this.pre.scrollTop = this.ta.scrollTop;
    this.pre.scrollLeft = this.ta.scrollLeft;
  };

  global.HX = global.HX || {};
  global.HX.Editor = Editor;
  global.HX.highlight = highlight;

})(typeof window !== 'undefined' ? window : globalThis);