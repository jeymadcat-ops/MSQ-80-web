/* MSQ-80 on the web: the engine (WebAssembly, one instance, this thread), the audio (a ScriptProcessor pulling it), the
   screen (a canvas), and the touch panel: pages, transport, a d-pad, shortcut buttons that follow the page, a
   keyboard and the drum pads. The commands are the engine's own keys: this page only sends them. */
(function () {
  'use strict';

  // The engine's command keys (engine/msq_keys.h)
  var K = { UP: 1, DOWN: 2, LEFT: 3, RIGHT: 4, ENTER: 5, DELETE: 6, INSERT: 7, TAB: 8, ESC: 9, BACKSPACE: 10, SPACE: 11,
            HOME: 12, END: 13, PGUP: 14, PGDN: 15 };
  function F(n) { return 15 + n; }                               // F1 = 16 ... F11 = 26
  var PAGE = { SOUND: 0, SEQ: 1, NRV8: 2, SONG: 3, FX: 4 };
  var PAGE_TABS = [['SQ80 EDIT', PAGE.SOUND], ['SQ80 SEQ', PAGE.SEQ], ['SONG', PAGE.SONG], ['NRV8', PAGE.NRV8], ['FX', PAGE.FX]];
  var VOICE_NAMES = ['KICK', 'SNARE', 'HAT', 'CLAP', 'CY', 'TOM', 'NUT', 'SYN'];
  var STUTTER_NAMES = ['1/4', '1/8', '1/16', '1/32', 'REVERSE', 'GRAINS', 'SPIN ▼', 'SPIN ▲'];
  var AUTOSAVE_KEY = 'msq8-autosave';
  var THEME_KEY = 'msq8-theme';

  function $(id) { return document.getElementById(id); }

  var x = null;                                                  // the wasm exports
  var ctx = null;                                                // the audio context
  var mods = { shift: false, ctrl: false };                      // the latched SHIFT / CTRL of the touch d-pad
  var shownPage = -1;

  // ------------------------------------------------------------------ the engine
  function b64ToBytes(s) {
    var bin = atob(s), n = bin.length, out = new Uint8Array(n), i;
    for (i = 0; i < n; ++i) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var s = '', i, CH = 0x8000;
    for (i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  function boot() {
    var getBytes = window.MSQ_WASM_B64
      ? Promise.resolve(b64ToBytes(window.MSQ_WASM_B64))
      : fetch('msq8.wasm').then(function (r) { return r.arrayBuffer(); }).then(function (b) { return new Uint8Array(b); });
    return getBytes.then(function (bytes) { return WebAssembly.compile(bytes); }).then(function (module) {
      var imports = {}, list = WebAssembly.Module.imports(module), i;
      for (i = 0; i < list.length; ++i) {                        // the engine asks nothing of the system: stubs
        if (!imports[list[i].module]) imports[list[i].module] = {};
        imports[list[i].module][list[i].name] = function () { return 0; };
      }
      return WebAssembly.instantiate(module, imports);
    }).then(function (inst) {
      x = inst.exports;
      if (x._initialize) x._initialize();
      x.msq_web_init(((Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0) || 1);
      var v = new Uint8Array(x.memory.buffer, x.msq_web_version(), 16), s = '', k;
      for (k = 0; k < 16 && v[k]; ++k) s += String.fromCharCode(v[k]);
      $('ver').textContent = s;
      applyTheme(storedTheme());
      restore();
    });
  }

  function mem() { return x.memory.buffer; }

  // The screen's theme (0 default, 1 the SQ-80's blue LCD). The page around it takes the blue too.
  function storedTheme() {
    try { return +window.localStorage.getItem(THEME_KEY) || 0; } catch (e) { return 0; }
  }

  function applyTheme(t) {
    var now = x.msq_web_theme(t);
    document.body.classList.toggle('sq80', now === 1);
    try { window.localStorage.setItem(THEME_KEY, String(now)); } catch (e) { /* ok */ }
    return now;
  }

  // ------------------------------------------------------------------ audio
  var phase = 0, primed = false, prevL = 0, prevR = 0, nextL = 0, nextR = 0;

  function pull(count) {                                         // `count` frames at the engine's rate, as floats
    var l = new Float32Array(count), r = new Float32Array(count), done = 0, n, p, a, i;
    while (done < count) {
      n = Math.min(2048, count - done);
      p = x.msq_web_render(n);
      a = new Int16Array(mem(), p, n * 2);
      for (i = 0; i < n; ++i) { l[done + i] = a[2 * i] / 32768; r[done + i] = a[2 * i + 1] / 32768; }
      done += n;
    }
    return { l: l, r: r };
  }

  function onAudio(e) {
    var L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1), n = L.length;
    var ratio = x.msq_web_rate() / ctx.sampleRate, p, k;
    if (ratio === 1) {
      p = pull(n);
      L.set(p.l); R.set(p.r);
      return;
    }
    if (!primed) {                                               // two frames in hand, the one before and the one after the position
      p = pull(2);
      prevL = p.l[0]; prevR = p.r[0]; nextL = p.l[1]; nextR = p.r[1]; phase = 0; primed = true;
    }
    var adv = Math.floor(phase + n * ratio);
    p = pull(adv);
    var bl = new Float32Array(adv + 2), br = new Float32Array(adv + 2);
    bl[0] = prevL; bl[1] = nextL; br[0] = prevR; br[1] = nextR;
    bl.set(p.l, 2); br.set(p.r, 2);
    for (k = 0; k < n; ++k) {
      var pos = phase + k * ratio, i = Math.floor(pos), f = pos - i;
      L[k] = bl[i] * (1 - f) + bl[i + 1] * f;
      R[k] = br[i] * (1 - f) + br[i + 1] * f;
    }
    prevL = bl[adv]; nextL = bl[adv + 1]; prevR = br[adv]; nextR = br[adv + 1];
    phase = phase + n * ratio - adv;
  }

  function ensureAudio() {
    if (!x) return;
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { var ns = document.querySelectorAll('.js-start'), ni; for (ni = 0; ni < ns.length; ++ni) ns[ni].textContent = 'NO WEB AUDIO HERE'; return; }
    try { ctx = new AC({ sampleRate: x.msq_web_rate() }); } catch (e) { ctx = new AC(); }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e2) { /* the silent switch of iOS */ }
    var proc = ctx.createScriptProcessor(2048, 0, 2);
    proc.onaudioprocess = onAudio;
    proc.connect(ctx.destination);
    window.__msqProc = proc;                                     // kept alive
    ctx.resume();
    var st = document.querySelectorAll('.js-start'), si;
    for (si = 0; si < st.length; ++si) st[si].classList.add('hidden');
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(function () {}); } catch (e3) { /* the screen may sleep */ }
  }

  // ------------------------------------------------------------------ screen
  var screens = [], lastDraw = 0, frameHooks = [];
  function addScreen(canvas) {
    var c = canvas.getContext('2d');
    screens.push({ canvas: canvas, ctx: c, img: c.createImageData(240, 240) });
  }

  function draw(now) {
    window.requestAnimationFrame(draw);
    if (!x || now - lastDraw < 30) return;
    lastDraw = now;
    var pixels = new Uint8ClampedArray(mem(), x.msq_web_frame(), 240 * 240 * 4), i;
    for (i = 0; i < screens.length; ++i) {
      if (screens[i].canvas.closest('[hidden]')) continue;      // the view that is not shown
      screens[i].img.data.set(pixels);
      screens[i].ctx.putImageData(screens[i].img, 0, 0);
    }
    sync();
    for (i = 0; i < frameHooks.length; ++i) frameHooks[i]();
  }

  // ------------------------------------------------------------------ commands
  function key(k, shift, ctrl, repeat) {
    ensureAudio();
    if (x) x.msq_web_key(k, shift ? 1 : 0, ctrl ? 1 : 0, repeat ? 1 : 0);
  }

  // a button: `down(repeat)` when pressed (and again while held, if `rep`), `up()` when let go
  function press(el, down, up, rep) {
    var active = false, t1 = 0, t2 = 0;
    function stop() {
      if (!active) return;
      active = false;
      el.classList.remove('on');
      clearTimeout(t1); clearInterval(t2);
      if (up) up();
    }
    el.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      if (active) return;
      active = true;
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* not captured: pointerleave will end it */ }
      el.classList.add('on');
      ensureAudio();
      down(false);
      if (rep) t1 = setTimeout(function () { t2 = setInterval(function () { down(true); }, 90); }, 380);
    });
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    el.addEventListener('pointerleave', stop);
    el.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    return el;
  }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function toggleMod(shift) {                                    // SHIFT / CTRL of any view: one state, shown on every latch
    var on = shift ? (mods.shift = !mods.shift) : (mods.ctrl = !mods.ctrl), l = document.querySelectorAll(shift ? '.js-shift' : '.js-ctrl'), i;
    for (i = 0; i < l.length; ++i) l[i].classList.toggle('latched', on);
  }

  function releaseMods() {
    mods.shift = mods.ctrl = false;
    var l = document.querySelectorAll('.js-shift, .js-ctrl'), i;
    for (i = 0; i < l.length; ++i) l[i].classList.remove('latched');
  }

  // ------------------------------------------------------------------ the panel
  function buildFixed() {
    var pages = $('pages'), tr = $('transport'), dp = $('dpad'), md = $('mods');
    PAGE_TABS.forEach(function (t) {
      var b = mk('button', 'btn', t[0]);
      b.type = 'button'; b.dataset.page = t[1];
      press(b, function () { if (x) x.msq_web_page(t[1]); }, null, false);
      pages.appendChild(b);
    });

    function tbtn(label, k, sh, rep) {
      var b = mk('button', 'btn', label);
      b.type = 'button';
      press(b, function (r) { key(k, sh, false, r); }, null, rep);
      tr.appendChild(b);
      return b;
    }
    tbtn('⏮', K.BACKSPACE, false, false).setAttribute('aria-label', 'Rewind');
    var play = tbtn('▶', K.SPACE, false, false); play.id = 'btnPlay'; play.setAttribute('aria-label', 'Play / stop');
    var rec = tbtn('●', F(5), false, false); rec.id = 'btnRec'; rec.setAttribute('aria-label', 'Record');
    tbtn('BPM −8', K.END, true, true);
    tbtn('−', K.END, false, true).setAttribute('aria-label', 'Slower');
    tbtn('+', K.HOME, false, true).setAttribute('aria-label', 'Faster');
    tbtn('BPM +8', K.HOME, true, true);

    var cells = [null, ['▲', K.UP], null, ['◀', K.LEFT], ['OK', K.ENTER], ['▶', K.RIGHT], null, ['▼', K.DOWN], null];
    cells.forEach(function (c) {
      if (!c) { dp.appendChild(mk('div')); return; }
      var b = mk('button', 'btn', c[0]);
      b.type = 'button';
      var sh = false, ct = false;                                // the modifiers latched when it was pressed: a held button keeps them while it repeats
      press(b, function (r) {
        if (!r) { sh = mods.shift; ct = mods.ctrl; releaseMods(); }
        key(c[1], sh, ct, r);
      }, null, c[1] !== K.ENTER);
      dp.appendChild(b);
    });

    ['SHIFT', 'CTRL'].forEach(function (name) {
      var b = mk('button', 'btn', name);
      b.type = 'button'; b.classList.add(name === 'SHIFT' ? 'js-shift' : 'js-ctrl');
      b.addEventListener('pointerdown', function (ev) { ev.preventDefault(); toggleMod(name === 'SHIFT'); });
      md.appendChild(b);
    });
    var esc = mk('button', 'btn warn', 'PANIC');
    esc.type = 'button';
    press(esc, function () { key(K.ESC, false, false, false); }, null, false);
    md.appendChild(esc);
  }

  // The shortcut buttons of each page: [label, key, shift, ctrl, repeat, hint]
  var SHORT = {};
  SHORT[PAGE.SOUND] = [
    ['PROG −', K.TAB, 1, 0, 0, 'track'], ['PROG +', K.TAB, 0, 0, 0, 'track'], ['TRACK −', F(3), 0, 0, 0, ''], ['TRACK +', F(4), 0, 0, 0, ''],
    ['RANDOM', F(11), 0, 0, 0, 'new sound'], ['OCT −', K.PGDN, 0, 0, 0, ''], ['OCT +', K.PGUP, 0, 0, 0, ''], ['MUTE', F(6), 0, 0, 0, 'track'],
    ['LIB −', K.LEFT, 0, 1, 0, 'library'], ['LIB +', K.RIGHT, 0, 1, 0, 'library'], ['GROUP −', K.LEFT, 1, 1, 0, 'bass lead pad'], ['GROUP +', K.RIGHT, 1, 1, 0, 'bass lead pad']
  ];
  SHORT[PAGE.SEQ] = [
    ['MUTE', F(6), 0, 0, 0, 'track'], ['QUANT', F(7), 0, 0, 0, 'track'], ['GRID', F(7), 1, 0, 0, 'value'], ['LOOP', F(8), 0, 0, 0, ''],
    ['COPY', F(9), 0, 0, 0, 'to next'], ['MERGE', F(9), 1, 0, 0, 'into next'], ['+ BAR', K.INSERT, 0, 0, 0, ''], ['− BAR', K.INSERT, 0, 1, 0, ''],
    ['RND SOUND', F(11), 0, 0, 0, 'track'], ['RND PATTERN', F(11), 1, 0, 0, 'track'], ['TRACK −', F(3), 0, 0, 0, ''], ['TRACK +', F(4), 0, 0, 0, ''],
    ['PROG −', K.TAB, 1, 0, 0, ''], ['PROG +', K.TAB, 0, 0, 0, ''], ['SEQ −', K.PGDN, 0, 1, 0, ''], ['SEQ +', K.PGUP, 0, 1, 0, ''],
    ['TRANSPOSE −', K.DOWN, 0, 1, 1, '1 semitone'], ['TRANSPOSE +', K.UP, 0, 1, 1, '1 semitone'], ['LEVEL −', K.LEFT, 0, 1, 1, 'track'], ['LEVEL +', K.RIGHT, 0, 1, 1, 'track'],
    ['TIME SIG', F(8), 1, 0, 0, 'empty seq'], ['ERASE TRACK', K.DELETE, 0, 0, 0, 'twice'], ['ERASE SEQ', K.DELETE, 1, 0, 0, 'twice']
  ];
  SHORT[PAGE.NRV8] = [
    ['PITCH −', K.DOWN, 1, 0, 1, 'step'], ['PITCH +', K.UP, 1, 0, 1, 'step'], ['DECAY −', K.LEFT, 1, 0, 1, 'step'], ['DECAY +', K.RIGHT, 1, 0, 1, 'step'],
    ['KNOB ▲', K.UP, 0, 1, 0, 'pick'], ['KNOB ▼', K.DOWN, 0, 1, 0, 'pick'], ['KNOB −', K.LEFT, 0, 1, 1, 'value'], ['KNOB +', K.RIGHT, 0, 1, 1, 'value'],
    ['PATTERN −', K.TAB, 1, 0, 0, ''], ['PATTERN +', K.TAB, 0, 0, 0, ''], ['LENGTH −', K.INSERT, 0, 1, 0, ''], ['LENGTH +', K.INSERT, 0, 0, 0, ''],
    ['CLEAR', K.DELETE, 0, 0, 0, 'step'], ['MUTE', F(6), 0, 0, 0, 'voice'], ['CRUSH', F(8), 0, 0, 0, ''], ['ERASE PAT', K.DELETE, 1, 0, 0, 'twice'],
    ['RND KIT', F(11), 0, 0, 0, ''], ['RND BEAT', F(11), 1, 0, 0, '']
  ];
  SHORT[PAGE.FX] = [
    ['RESET', K.DELETE, 0, 0, 0, 'this one'], ['RESET ALL', K.DELETE, 1, 0, 0, ''], ['RANDOM', F(11), 0, 0, 0, 'musical'], ['MUTE', F(6), 0, 0, 0, ''],
    ['−4', K.LEFT, 1, 0, 1, ''], ['+4', K.RIGHT, 1, 0, 1, '']
  ];
  SHORT[PAGE.SONG] = [
    ['MODE', K.ENTER, 0, 0, 0, 'play song'], ['INSERT', K.INSERT, 0, 0, 0, 'step'], ['DELETE', K.DELETE, 0, 0, 0, 'step'], ['LOOP', F(8), 0, 0, 0, ''],
    ['REPEATS −', K.LEFT, 0, 1, 1, ''], ['REPEATS +', K.RIGHT, 0, 1, 1, ''], ['SONG −', K.PGDN, 0, 1, 0, ''], ['SONG +', K.PGUP, 0, 1, 0, '']
  ];

  function buildShortcuts(page) {
    var box = $('shortcuts');
    box.innerHTML = '';
    (SHORT[page] || []).forEach(function (s) {
      var b = mk('button', 'btn');
      b.type = 'button';
      b.appendChild(document.createTextNode(s[0]));
      if (s[5]) b.appendChild(mk('small', '', s[5]));
      press(b, function (r) { key(s[1], s[2], s[3], r); }, null, !!s[4]);
      box.appendChild(b);
    });
  }

  // ---- the keyboard: two octaves and a C, from the keyboard octave of the engine (OCT ± moves it)
  var WHITE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
  var BLACK = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5, 13: 7, 15: 8, 18: 10, 20: 11, 22: 12 };   // semitone -> index of the white key before it
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var heldTouch = {};                                            // pointerId -> note

  function noteFor(semi) { return x.msq_web_state(10) + semi; }

  function attachKey(el, semi) {
    el.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      ensureAudio();
      try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ok */ }
      var n = noteFor(semi);
      heldTouch[ev.pointerId] = n;
      el.classList.add('on');
      if (x) x.msq_web_note(n, 1);
    });
    function up(ev) {
      var n = heldTouch[ev.pointerId];
      if (n === undefined) return;
      delete heldTouch[ev.pointerId];
      el.classList.remove('on');
      if (x) x.msq_web_note(n, 0);
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  }

  function buildPiano() {
    var piano = $('piano'), w = 100 / WHITE.length;
    WHITE.forEach(function (semi, i) {
      var k = mk('div', 'white', semi % 12 === 0 ? 'C' + (semi / 12) : '');
      k.dataset.semi = semi;
      attachKey(k, semi);
      piano.appendChild(k);
    });
    Object.keys(BLACK).forEach(function (s) {
      var semi = +s, k = mk('div', 'black');
      k.style.left = ((BLACK[s] + 1) * w - 2.7) + '%';
      attachKey(k, semi);
      piano.appendChild(k);
    });
    var bar = $('pianobar');
    var down = mk('button', 'btn', 'OCT −'), up = mk('button', 'btn', 'OCT +'), mid = mk('div', 'mid', '');
    down.type = up.type = 'button'; mid.id = 'octlabel';
    press(down, function () { key(K.PGDN, false, false, false); }, null, false);
    press(up, function () { key(K.PGUP, false, false, false); }, null, false);
    bar.appendChild(down); bar.appendChild(mid); bar.appendChild(up);
  }

  // ---- the drum pages: the 8 pads and the 8 stutters (held)
  function buildPads() {
    var pads = $('pads'), i;
    for (i = 0; i < 8; ++i) (function (v) {
      var b = mk('button', 'btn pad' + v, VOICE_NAMES[v]);
      b.type = 'button';
      press(b, function () { if (x) x.msq_web_pad(v); }, null, false);
      pads.appendChild(b);
    })(i);
    pads.appendChild(mk('div', 'label', 'STUTTERS — HOLD'));
    for (i = 0; i < 8; ++i) (function (m) {
      var b = mk('button', 'btn stut', STUTTER_NAMES[m - 1]);
      b.type = 'button';
      press(b, function () { if (x) x.msq_web_stutter(m); }, function () { if (x) x.msq_web_stutter(0); }, false);
      pads.appendChild(b);
    })(i + 1);
  }

  // what follows the engine: the page tabs, the transport lights, which panel is shown
  function sync() {
    var page = x.msq_web_state(0), playing = x.msq_web_state(2), rec = x.msq_web_state(3);
    if (page !== shownPage) {
      shownPage = page;
      var tabs = $('pages').children, i;
      for (i = 0; i < tabs.length; ++i) tabs[i].classList.toggle('tab-active', +tabs[i].dataset.page === page);
      buildShortcuts(page);
      var drums = page === PAGE.NRV8 || page === PAGE.FX;
      $('pads').style.display = drums ? 'grid' : 'none';
      $('piano').style.display = drums ? 'none' : 'flex';
      $('pianobar').style.display = drums ? 'none' : 'grid';
    }
    $('btnPlay').classList.toggle('live', !!playing);
    $('btnPlay').textContent = playing ? '■' : '▶';
    $('btnRec').classList.toggle('rec', !!rec);
    $('octlabel').textContent = 'KEYS FROM C' + (x.msq_web_state(10) / 12 - 1);
  }

  // ------------------------------------------------------------------ the PC keyboard
  var PIANO = {                                                  // KeyboardEvent.code (a position on the keyboard, whatever the layout) -> semitones
    KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28
  };
  var COMMANDS = { ArrowUp: K.UP, ArrowDown: K.DOWN, ArrowLeft: K.LEFT, ArrowRight: K.RIGHT, Enter: K.ENTER, Delete: K.DELETE, Insert: K.INSERT, Tab: K.TAB,
                   Escape: K.ESC, Backspace: K.BACKSPACE, Space: K.SPACE, Home: K.HOME, End: K.END, PageUp: K.PGUP, PageDown: K.PGDN };
  var heldKey = {};                                              // code -> note

  function onKeyDown(ev) {
    if (!x) return;
    var ctrl = ev.ctrlKey || ev.metaKey, code = ev.code, k;
    if (ctrl && code === 'KeyS') { ev.preventDefault(); if (!ev.repeat) saveFile(); return; }
    if (ctrl && code === 'KeyO') { ev.preventDefault(); if (!ev.repeat) $('file').click(); return; }
    if (!ctrl && PIANO.hasOwnProperty(code)) {
      ev.preventDefault();
      if (ev.repeat || heldKey[code] !== undefined) return;
      ensureAudio();
      heldKey[code] = noteFor(PIANO[code]);
      x.msq_web_note(heldKey[code], 1);
      return;
    }
    k = COMMANDS[code];
    if (!k && /^F([1-9]|1[01])$/.test(code)) k = F(+code.slice(1));
    if (k) { ev.preventDefault(); key(k, ev.shiftKey, ctrl, ev.repeat); }
  }

  function onKeyUp(ev) {
    if (!x || heldKey[ev.code] === undefined) return;
    x.msq_web_note(heldKey[ev.code], 0);
    delete heldKey[ev.code];
  }

  function releaseAll() {
    var c;
    for (c in heldKey) if (heldKey.hasOwnProperty(c)) { x.msq_web_note(heldKey[c], 0); delete heldKey[c]; }
  }

  // ------------------------------------------------------------------ project files
  function projectBytes(quiet) {
    var len = x.msq_web_save(quiet ? 1 : 0);
    return len > 0 ? new Uint8Array(mem(), x.msq_web_file(), len).slice() : null;
  }

  function autosave() {
    if (!x) return;
    try {
      var b = projectBytes(true);
      if (b) window.localStorage.setItem(AUTOSAVE_KEY, bytesToB64(b));
    } catch (e) { /* private mode, or full: the download still works */ }
  }

  function restore() {
    try {
      var s = window.localStorage.getItem(AUTOSAVE_KEY);
      if (!s) return;
      var b = b64ToBytes(s);
      if (b.length > x.msq_web_file_max()) return;
      new Uint8Array(mem(), x.msq_web_file(), b.length).set(b);
      x.msq_web_load(b.length);                                  // refused if damaged: the demo stays
    } catch (e) { /* no storage */ }
  }

  function stamp() {
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'msq8-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  // A browser download of `bytes` (a normal page). `name` ends in .msq8.
  function browserDownload(bytes, name) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1500);
  }

  // SAVE FILE. A page inside the claude.ai viewer cannot start a download itself: it asks the viewer through the
  // `downloads` capability, which takes a short list of extensions, so there the project goes as a .txt holding the
  // same code COPY CODE gives. LOAD FILE reads both.
  function saveFile() {
    var claude = window.claude;
    if (claude && typeof claude.use === 'function') {
      claude.use('downloads').then(function (dl) {
        if (!dl) { plainSave(); return; }
        var code = projectCode();
        if (!code) return;
        dl.save({ filename: stamp() + '.txt', data: code }).then(autosave, function (e) {
          if (!e || e.code !== 'declined') x.msq_web_message(4);       // not a refusal: the code box is the way out
          if (!e || e.code !== 'declined') { $('pastebox').hidden = false; $('code').value = code; }
        });
      }, plainSave);
      return;
    }
    plainSave();
  }

  function plainSave() {
    var b = projectBytes(false);
    if (!b) return;
    browserDownload(b, stamp() + '.msq8');
    autosave();
  }

  // a project in memory (a file, a pasted code): into the engine
  function loadBytes(b) {
    if (!b || b.length < 12 || b.length > x.msq_web_file_max()) { x.msq_web_message(1); return false; }
    new Uint8Array(mem(), x.msq_web_file(), b.length).set(b);
    if (x.msq_web_load(b.length) !== 0) return false;
    autosave();
    return true;
  }

  function loadFile(file) {
    var rd = new FileReader();
    rd.onload = function () {
      var b = new Uint8Array(rd.result);
      if (b.length > 5 && b[0] === 77 && b[1] === 83 && b[2] === 81 && b[3] === 56 && b[4] !== 58) loadBytes(b);              // "MSQ8" and a version: the binary file
      else loadBytes(codeToBytes(typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(b) : String.fromCharCode.apply(null, b)));   // the text code, in a .txt
    };
    rd.onerror = function () { x.msq_web_message(1); };
    rd.readAsArrayBuffer(file);
  }

  // A project as text: the same bytes in base64, with a tag in front. It travels through any chat or note, and a
  // page that cannot save files (a sandboxed one) can still keep a project this way.
  var CODE_TAG = 'MSQ8:';

  function projectCode() {
    var b = projectBytes(false);
    return b ? CODE_TAG + bytesToB64(b) : '';
  }

  function codeToBytes(text) {
    var t = String(text).replace(/\s+/g, '');
    if (t.indexOf(CODE_TAG) === 0) t = t.slice(CODE_TAG.length);
    if (!t || /[^A-Za-z0-9+\/=]/.test(t)) return null;
    try { return b64ToBytes(t); } catch (e) { return null; }
  }

  function wireFiles() {
    var input = $('file'), newBtn = $('btnNew'), armed = 0, box = $('pastebox'), area = $('code');
    $('btnSave').addEventListener('click', function () { ensureAudio(); saveFile(); });
    $('btnLoad').addEventListener('click', function () { input.value = ''; input.click(); });
    input.addEventListener('change', function () { if (input.files && input.files[0]) loadFile(input.files[0]); });

    $('btnCopy').addEventListener('click', function () {
      var code = projectCode();
      if (!code) return;
      function manual() {                                        // no clipboard here: the code in a box, selected, to copy by hand
        box.hidden = false; area.value = code; area.focus(); area.select();
        x.msq_web_message(4);
      }
      try {
        window.navigator.clipboard.writeText(code).then(function () { x.msq_web_message(3); }, manual);
      } catch (e) { manual(); }
    });
    $('btnPaste').addEventListener('click', function () { box.hidden = !box.hidden; if (!box.hidden) { area.value = ''; area.focus(); } });
    $('btnCodeLoad').addEventListener('click', function () {
      if (loadBytes(codeToBytes(area.value))) { box.hidden = true; area.value = ''; }
      else if (!codeToBytes(area.value)) x.msq_web_message(1);
    });

    newBtn.addEventListener('click', function () {
      ensureAudio();
      if (!armed) {                                              // two taps: a new project loses the one in the machine
        armed = setTimeout(function () { armed = 0; newBtn.textContent = 'NEW'; newBtn.classList.remove('warn'); }, 3000);
        newBtn.textContent = 'SURE?'; newBtn.classList.add('warn');
        return;
      }
      clearTimeout(armed); armed = 0;
      newBtn.textContent = 'NEW'; newBtn.classList.remove('warn');
      try { window.localStorage.removeItem(AUTOSAVE_KEY); } catch (e) { /* ok */ }
      releaseAll();
      x.msq_web_init(((Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0) || 1);
      x.msq_web_message(0);
    });
  }

  // ------------------------------------------------------------------ start
  function start() {
    addScreen($('screen'));
    buildFixed(); buildPiano(); buildPads(); wireFiles();
    $('start').addEventListener('pointerdown', function (ev) { ev.preventDefault(); ensureAudio(); });
    $('btnTheme').addEventListener('click', function () { if (x) applyTheme(storedTheme() + 1 >= 2 ? 0 : storedTheme() + 1); });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', function () { if (x) releaseAll(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) autosave(); });
    window.addEventListener('pagehide', autosave);
    setInterval(autosave, 8000);
    boot().then(function () { window.requestAnimationFrame(draw); }).catch(function (e) {
      var st = document.querySelectorAll('.js-start'), si;
      for (si = 0; si < st.length; ++si) { st[si].classList.remove('hidden'); st[si].textContent = 'COULD NOT START: ' + (e && e.message ? e.message : e); }
    });
    window.msq = { K: K, F: F, PAGE: PAGE, exports: function () { return x; } };   // for the console
    window.msqApp = {                                                              // what the panel view (panel.js) builds on
      K: K, F: F, PAGE: PAGE, VOICE_NAMES: VOICE_NAMES, STUTTER_NAMES: STUTTER_NAMES, SHORT: SHORT, mods: mods, WHITE: WHITE, BLACK: BLACK,
      $: $, mk: mk, press: press, key: key, attachKey: attachKey, toggleMod: toggleMod, releaseMods: releaseMods, addScreen: addScreen,
      exports: function () { return x; }, mem: mem, ensureAudio: ensureAudio, onFrame: function (fn) { frameHooks.push(fn); },
      projectBytes: projectBytes, loadBytes: loadBytes, autosave: autosave                          // the project of the page, for the DEVICE tab
    };
    if (window.msqPanelInit) window.msqPanelInit(window.msqApp);
    if (window.msqDeviceInit) window.msqDeviceInit(window.msqApp);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());
