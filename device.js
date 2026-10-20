/* The editor's tabs: DEVICE (connect to the FM-1 over USB, send a project or a demo into its flash slots, read one back, save, play, a test of the link), LIVE (the FM-1's
   screen and lights mirrored, its panel and the computer keyboard play it) and VISUAL (the emulator's own screen, panel and touch views, kept apart so that the others have the room).
   app.js calls msqDeviceInit when it starts; the SysEx side is link.js. */
(function () {
  'use strict';
  var L = window.MsqLink;

  var BTN = ['FX', 'SEL', 'ENV', 'LFO', 'EDIT', 'GLO', 'HOME', 'SAVE', 'ARP', 'SEQ', 'PLAY', 'REC', 'OCT-', 'OCT+'];
  var BTN_FUNC = ['LAYER', 'SHIFT', 'ENVELOPES', 'CTRL / LFO TAB', 'SQ80 EDIT', 'MIXER', 'TRACK', 'SAVE/LOAD', 'ARP', 'SEQUENCERS', '', '', '', ''];
  var KNOBS = [[105, 100, 24, 'MASTER'], [215, 100, 24, 'SELECT'], [105, 205, 24, 'PRESETS'], [215, 205, 24, 'ALGORITHM'],
    [610, 100, 22, 'KNOB1'], [714, 100, 22, 'KNOB2'], [818, 100, 22, 'KNOB3'], [922, 100, 22, 'KNOB4']];
  var WHITE = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];
  var BLACK = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25], BLACK_AFTER = [0, 1, 2, 4, 5, 7, 8, 9, 11, 12, 14];
  var KB = { x: 36, y: 340, w: 928, h: 270 }, SCREEN = { x: 318, y: 62, w: 200, h: 200 };
  var THEME_LED = [[255, 176, 48], [80, 170, 255], [255, 64, 160]];                 // the lights follow the screen's theme
  var MIN_GAP = 15, MAX_GAP = 200, IDLE_GAP = 40;                                     // ms between screen requests (adaptive) / after a still screen
  var TAB_KEY = 'msq8-tab';

  function buttonRect(b) {
    if (b >= 12) return [b === 12 ? 72 : 170, 268, 82, 38];
    return [582 + (b % 6) * 63, b < 6 ? 174 : 236, 54, 48];
  }
  function keyRect(k) {
    var pitch = (KB.w - 24) / 16, kw = pitch * 0.78, i = WHITE.indexOf(k);
    if (i >= 0) return [KB.x + 12 + i * pitch + (pitch - kw) / 2, KB.y + KB.h * 0.43, kw, KB.h * 0.52, true];
    i = BLACK.indexOf(k);
    return [KB.x + 12 + (BLACK_AFTER[i] + 1) * pitch - kw / 2, KB.y + KB.h * 0.06, kw, KB.h * 0.33, false];
  }

  function rr(g, x, y, w, h, r, fill, stroke, lw) {
    g.beginPath(); g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
    g.fillStyle = fill; g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
  }
  function circle(g, x, y, r, fill, stroke) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2; g.stroke(); }
  }
  function text(g, s, x, y, size, color, weight) {
    g.font = (weight || 400) + ' ' + size + 'px "Bahnschrift SemiCondensed", "Bahnschrift", "Segoe UI", sans-serif';
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(s, x, y);
  }
  function mix(a, b, t) {                                                            // a and b: '#rrggbb' or 'rgb(r,g,b)'
    function p(c) { return c.charAt(0) === '#' ? [1, 3, 5].map(function (i) { return parseInt(c.slice(i, i + 2), 16); }) : c.match(/\d+/g).map(Number); }
    var x = p(a), y = p(b);
    return 'rgb(' + x.map(function (v, i) { return Math.round(v + (y[i] - v) * t); }).join(',') + ')';
  }

  // ====================================================================== LIVE
  function Live(canvas, statusEl) {
    var self = this;
    this.cv = canvas; this.status = statusEl;
    this.lcd = document.createElement('canvas');
    this.lcd.width = this.lcd.height = L.LCD;
    this.lctx = this.lcd.getContext('2d');
    this.img = this.lctx.createImageData(L.LCD, L.LCD);
    this.lctx.fillStyle = '#05070a'; this.lctx.fillRect(0, 0, L.LCD, L.LCD);
    this.lctx.fillStyle = '#5d6370'; this.lctx.font = '600 15px "Segoe UI", sans-serif'; this.lctx.textAlign = 'center';
    this.lctx.fillText('NO SIGNAL', L.LCD / 2, L.LCD / 2 - 4);
    this.lctx.font = '12px "Segoe UI", sans-serif';
    this.lctx.fillText('connect the FM-1 (DEVICE tab)', L.LCD / 2, L.LCD / 2 + 16);
    this.lights = { lit: 0, glow: 0x3FFF, keys: 0, theme: 0, page: 0 };
    this.link = null; this.running = false; this.loopId = 0;
    this.paused = function () { return false; };
    this.held = {}; this.latched = {}; this.pointers = {};
    this.knobDeg = KNOBS.map(function () { return 0; });
    this.inputs = Promise.resolve();
    this._bindPointer();
    if (window.ResizeObserver) new ResizeObserver(function () { self.draw(); }).observe(canvas);
    this.draw();
  }

  Live.prototype.interactive = function () { return !!this.link; };

  // the computer keyboard plays the FM-1 too (physical key positions, so QWERTY and AZERTY alike); active(): the LIVE tab is shown
  Live.prototype.bindKeyboard = function (active) {
    var self = this;
    var B = { Space: 10, Enter: 11, NumpadEnter: 11, Escape: 6, Delete: 8, ShiftLeft: 1, ShiftRight: 1, F1: 6, F2: 4, F3: 5, F4: 0, F5: 9, KeyZ: 12, KeyX: 13 };
    var KEY = {};
    'QWERTYUI'.split('').forEach(function (c, i) { KEY['Key' + c] = WHITE[i]; });
    'ASDFGHJK'.split('').forEach(function (c, i) { KEY['Key' + c] = WHITE[8 + i]; });
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus'].forEach(function (c, i) { KEY[c] = BLACK[i]; });
    var KNOB = { PageUp: [4, 1], PageDown: [4, -1], Home: [5, 1], End: [5, -1], NumpadAdd: [6, 1], NumpadSubtract: [6, -1], NumpadMultiply: [7, 1], NumpadDivide: [7, -1] };
    var ARROW = { ArrowUp: [1, -1], ArrowDown: [1, 1], ArrowLeft: [3, -1], ArrowRight: [3, 1] };      // up / down SELECT, left / right ALGORITHM
    function usable(e) {
      return active() && self.interactive() && !e.ctrlKey && !e.metaKey && !e.altKey &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement);
    }
    document.addEventListener('keydown', function (e) {
      if (!usable(e)) return;
      var done = true;
      if (ARROW[e.code]) self._turn(ARROW[e.code][0], ARROW[e.code][1]);
      else if (KNOB[e.code]) self._turn(KNOB[e.code][0], KNOB[e.code][1]);
      else if (e.code === 'Tab') self._turn(2, e.shiftKey ? -1 : 1);
      else if (e.code === 'Backspace') { if (!e.repeat) { self._press('b1', true); self._press('b8', true); self._press('b8', false); self._press('b1', false); } }
      else if (B.hasOwnProperty(e.code)) { if (!e.repeat) self._press('b' + B[e.code], true); }
      else if (KEY.hasOwnProperty(e.code)) { if (!e.repeat) self._press('k' + KEY[e.code], true); }
      else done = false;
      if (done) e.preventDefault();
    });
    document.addEventListener('keyup', function (e) {
      if (!self.interactive()) return;
      if (B.hasOwnProperty(e.code)) self._press('b' + B[e.code], false);
      else if (KEY.hasOwnProperty(e.code)) self._press('k' + KEY[e.code], false);
    });
  };

  Live.prototype._send = function (kind, id, value) {
    if (!this.interactive()) return;
    var self = this, link = this.link;
    this.inputs = this.inputs.then(function () { return link.input(kind, id, value); }).then(function (l) {
      var k; for (k in l) self.lights[k] = l[k];
      self.draw();
    }).catch(function (e) { self.status.textContent = 'Input lost: ' + e.message; });
  };
  Live.prototype._press = function (key, on) {                                       // key: 'b3' or 'k12'
    var kind = key.charAt(0) === 'b' ? 0 : 1, id = +key.slice(1);
    if (on === !!this.held[key]) return;
    if (on) this.held[key] = true; else delete this.held[key];
    this._send(kind, id, on ? 1 : 0);
    this.draw();
  };
  Live.prototype.releaseAll = function () {
    var k;
    for (k in this.held) if (this.held.hasOwnProperty(k)) this._press(k, false);
    this.latched = {}; this.pointers = {};
  };
  Live.prototype._turn = function (id, steps) {
    this.knobDeg[id] = (this.knobDeg[id] + steps * 15) % 360;
    this._send(2, id, steps);
    this.draw();
  };

  Live.prototype._unit = function (e) {
    var r = this.cv.getBoundingClientRect();
    return [(e.clientX - r.left) * 1000 / r.width, (e.clientY - r.top) * 1000 / r.width];
  };
  Live.prototype._hit = function (ux, uy) {
    var i, b, k, a;
    for (i = 0; i < KNOBS.length; i++) {
      a = KNOBS[i];
      if (Math.pow(ux - a[0], 2) + Math.pow(uy - a[1], 2) <= Math.pow(a[2] + 14, 2)) return { type: 'knob', id: i };
    }
    for (b = 0; b < 14; b++) { a = buttonRect(b); if (ux >= a[0] && ux < a[0] + a[2] && uy >= a[1] && uy < a[1] + a[3]) return { type: 'button', id: b }; }
    for (k = 0; k < 27; k++) { a = keyRect(k); if (ux >= a[0] && ux < a[0] + a[2] && uy >= a[1] && uy < a[1] + a[3]) return { type: 'key', id: k }; }
    return null;
  };

  Live.prototype._bindPointer = function () {
    var self = this, cv = this.cv;
    cv.style.touchAction = 'none';
    cv.oncontextmenu = function (e) { e.preventDefault(); };
    cv.addEventListener('pointerdown', function (e) {
      if (!self.interactive()) return;
      var h = self._hit.apply(self, self._unit(e)), key;
      if (!h) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (x) { /* ok */ }
      if (h.type === 'button') {
        key = 'b' + h.id;
        if (e.button === 2 || e.shiftKey) {                                         // hold / let go: combinations with one mouse
          if (self.latched[key]) { delete self.latched[key]; self._press(key, false); } else { self.latched[key] = true; self._press(key, true); }
          return;
        }
        self._press(key, true);
        self.pointers[e.pointerId] = { type: 'button', key: key };
      } else if (h.type === 'key') {
        key = 'k' + h.id;
        self._press(key, true);
        self.pointers[e.pointerId] = { type: 'key', key: key };
      } else if (h.id > 0) {                                                        // not MASTER: the pot is the hardware's
        self.pointers[e.pointerId] = { type: 'knob', id: h.id, acc: 0, lastY: e.clientY };
      }
    });
    cv.addEventListener('pointermove', function (e) {
      var p = self.pointers[e.pointerId], h, steps;
      if (!p) return;
      if (p.type === 'key') {                                                       // glide across the keys
        h = self._hit.apply(self, self._unit(e));
        if (h && h.type === 'key' && 'k' + h.id !== p.key) { self._press(p.key, false); p.key = 'k' + h.id; self._press(p.key, true); }
      } else if (p.type === 'knob') {
        p.acc += p.lastY - e.clientY; p.lastY = e.clientY;
        steps = Math.trunc(p.acc / 10);
        if (steps) { p.acc -= steps * 10; self._turn(p.id, steps); }
      }
    });
    function up(e) {
      var p = self.pointers[e.pointerId];
      delete self.pointers[e.pointerId];
      if (p && (p.type === 'button' || p.type === 'key')) self._press(p.key, false);
    }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', function (e) {
      if (!self.interactive()) return;
      var h = self._hit.apply(self, self._unit(e));
      if (!h || h.type !== 'knob' || h.id === 0) return;
      e.preventDefault();
      self._turn(h.id, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    window.addEventListener('blur', function () { self.releaseAll(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) self.releaseAll(); });
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // One loop at a time (a new start retires the old one), and paced: Windows' MIDI input is read more slowly than the FM-1 can answer; a request every few ms floods it, frames
  // get lost and the port stops delivering anything. At most ~20 screen requests a second, fewer while nothing changes.
  Live.prototype.start = function (link) {
    var self = this, id, reset = true, bands = 0, t0 = performance.now(), frames = 0, fails = 0, last = 0, gap = MIN_GAP;
    this.releaseAll();
    this.link = link;
    this.cv.style.cursor = 'pointer';
    id = (this.loopId = this.loopId + 1);
    this.running = true;
    this.img = this.lctx.createImageData(L.LCD, L.LCD);
    function alive() { return self.running && self.loopId === id; }
    function step() {
      if (!alive()) return Promise.resolve();
      if (!self.link || self.paused()) { reset = true; return sleep(150).then(step); }
      var wait = last + gap - performance.now();
      return (wait > 0 ? sleep(wait) : Promise.resolve()).then(function () {
        last = performance.now();
        return self.link.screenPack(reset);
      }).then(function (r) {
        var took, i, b;
        fails = 0;
        if (!alive()) return null;
        took = performance.now() - last;
        gap = took > 250 ? Math.min(MAX_GAP, gap * 2) : Math.max(MIN_GAP, gap * 0.9);     // a late reply: the MIDI input struggles, back off; else speed up again
        reset = false;
        for (i in r) if (i !== 'bands') self.lights[i] = r[i];
        for (i = 0; i < r.bands.length; i++) {
          b = r.bands[i];
          L.decodeBand(b.data, self.img.data, b.band * L.LCD * L.BAND_ROWS * 4);
          self.lctx.putImageData(self.img, 0, 0, 0, b.band * L.BAND_ROWS, L.LCD, L.BAND_ROWS);
        }
        bands += r.bands.length;
        if (bands) frames++;
        bands = 0;
        self.draw();
        if (performance.now() - t0 > 1000) { self.status.textContent = 'Live: ' + frames + ' update' + (frames === 1 ? '' : 's') + ' / s (pace ' + Math.round(gap) + ' ms)'; frames = 0; t0 = performance.now(); }
        return r.bands.length ? null : sleep(IDLE_GAP);                                   // a still screen: look again a little later
      }).catch(function (e) {
        gap = Math.min(MAX_GAP, gap * 2);
        fails++;
        self.status.textContent = 'No screen from the FM-1 (' + e.message + '), retrying…';
        reset = true;
        return sleep(500);
      }).then(step);
    }
    step();
  };
  Live.prototype.stop = function () { this.releaseAll(); this.running = false; this.link = null; this.cv.style.cursor = 'default'; this.draw(); };

  Live.prototype.draw = function () {
    var cv = this.cv, dpr = window.devicePixelRatio || 1, w = Math.max(200, cv.clientWidth), h = w * 640 / 1000, g, s, Lt = this.lights, led, accent, self = this;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
    g = cv.getContext('2d'); s = cv.width / 1000;
    led = THEME_LED[Lt.theme] || THEME_LED[0];
    accent = 'rgb(' + led.join(',') + ')';
    g.setTransform(s, 0, 0, s, 0, 0);
    g.fillStyle = '#131518'; g.fillRect(0, 0, 1000, 640);
    rr(g, 4, 4, 992, 632, 44, '#3a3d42');
    KNOBS.forEach(function (k, i) {
      var x = k[0], y = k[1], r = k[2], a = self.knobDeg[i] * Math.PI / 180, sa = Math.sin(a), ca = Math.cos(a);
      circle(g, x, y, r + 5, '#26282c');
      circle(g, x, y, r, '#1f2124', '#44474c');
      g.strokeStyle = '#e8e8ea'; g.lineWidth = 6; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x + sa * (r - 5), y - ca * (r - 5)); g.lineTo(x + sa * (r - 15), y - ca * (r - 15)); g.stroke();
      text(g, k[3], x, y - r - 12, 17, '#e8e8ea', 600);
    });
    rr(g, 58, 258, 210, 58, 14, '#26282c');
    rr(g, 300, 44, 236, 236, 26, '#111214');
    rr(g, 568, 160, 400, 140, 18, '#26282c');
    for (var b = 0; b < 14; b++) {
      var rc = buttonRect(b), x0 = rc[0], y0 = rc[1], bw = rc[2], bh = rc[3], lit = Lt.lit >> b & 1, glow = Lt.glow >> b & 1, held = this.held['b' + b];
      rr(g, x0, y0, bw, bh, 9, lit ? accent : glow ? mix('#2e3135', accent, 0.13) : '#2e3135', this.latched['b' + b] ? '#6fc3ff' : held ? accent : '#4a4d52', held ? 3 : 1.5);
      var ink = lit ? '#1b1205' : '#e8e8ea', fn = lit ? '#3c2305' : '#f0a043';
      if (b === 10) { text(g, 'PLAY', x0 + bw / 2, y0 + bh / 2 - 1, 12, ink, 600); text(g, 'STOP', x0 + bw / 2, y0 + bh / 2 + 12, 12, ink, 600); }
      else if (BTN_FUNC[b]) { text(g, BTN[b], x0 + bw / 2, y0 + bh / 2 + 1, 15, ink, 600); text(g, BTN_FUNC[b], x0 + bw / 2, y0 + bh - 7, 9, fn, 600); }
      else text(g, BTN[b], x0 + bw / 2, y0 + bh / 2 + 5, 15, ink, 600);
    }
    rr(g, KB.x, KB.y, KB.w, KB.h, 18, '#26282c');
    for (var k = 0; k < 27; k++) {
      var kr = keyRect(k), on = Lt.keys >> k & 1, kh = this.held['k' + k];
      rr(g, kr[0], kr[1], kr[2], kr[3], kr[2] / 2, on || kh ? (kr[4] ? accent : mix('#000000', accent, 0.75)) : kr[4] ? '#d9dadc' : '#c9cacd', kh ? '#ffffff' : null, 3);
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(this.lcd, SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h);
  };

  // ====================================================================== the tabs and the DEVICE tab
  window.msqDeviceInit = function (A) {
    var $ = A.$, app = $('app'), tabs = ['device', 'live', 'visual'], link = null, transport = null, midi = null, info = null, busy = false, live = null, linkLive = false;
    var seed = function () { return ((Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0) || 1; };

    function showTab(name) {
      if (tabs.indexOf(name) < 0) name = 'device';
      tabs.forEach(function (t) {
        $('tab-' + t).hidden = t !== name;
        $('tabbtn-' + t).classList.toggle('tab-active', t === name);
      });
      app.setAttribute('data-tab', name);
      if (name === 'live') { if (live) live.draw(); }
      try { window.localStorage.setItem(TAB_KEY, name); } catch (e) { /* ok */ }
      window.dispatchEvent(new Event('resize'));                                       // the panel view fits itself to the width it has now
    }
    tabs.forEach(function (t) { $('tabbtn-' + t).addEventListener('click', function () { showTab(t); }); });

    // ---- the log, the status
    function log(msg) {
      var el = $('d-log'), d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
      el.textContent += pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '  ' + msg + '\n';
      if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-12000);
      el.scrollTop = el.scrollHeight;
    }
    function status(msg) { $('d-status').textContent = msg; }
    function progress(n, total) { $('d-bar').style.width = (total ? Math.round(100 * n / total) : 0) + '%'; }

    var onlineButtons = ['d-send', 'd-read', 'd-save', 'd-play', 'd-stop', 'd-test'];
    function enable() { onlineButtons.forEach(function (id) { $(id).disabled = !link || busy; }); $('d-slot').disabled = !link || busy; }
    function pill() {
      var el = $('linkpill');
      el.textContent = link ? 'FM-1: ' + (info ? info.version : 'connected') : 'FM-1: not connected';
      el.classList.toggle('off', !link);
    }
    function showInfo() {
      var dl = $('d-info');
      dl.innerHTML = '';
      function row(k, v) { var a = document.createElement('dt'), b = document.createElement('dd'); a.textContent = k; b.textContent = v; dl.appendChild(a); dl.appendChild(b); }
      if (!info) return;
      row('Firmware', info.version); row('Link protocol', String(info.proto)); row('Flash', info.flash ? 'yes' : 'no');
      row('Project slots', info.slots + ' (up to ' + Math.floor(info.maxProject / 1024) + ' KB each)'); row('Slot in use', String(info.slot + 1));
      row('Playing', info.playing ? 'yes' : 'no');
    }

    function work(label, fn) {                                                         // one transfer at a time, the buttons off, the progress on
      if (busy) return Promise.resolve();
      busy = true; enable(); progress(0, 0); status(label + '…'); log(label + '…');
      var t0 = performance.now();
      return fn().then(function (msg) {
        var s = ((performance.now() - t0) / 1000).toFixed(1) + ' s';
        status((msg || label) + ' (' + s + ')'); log((msg || label) + ' (' + s + ')');
        return link ? link.info().then(function (i) { info = i; showInfo(); pill(); }, function () {}) : null;
      }).catch(function (e) {
        status('Failed: ' + e.message); log('FAILED: ' + e.message);
      }).then(function () { busy = false; enable(); });
    }

    // ---- connect
    function fillPorts(access) {
      var ins = [], outs = [], sel;
      access.inputs.forEach(function (p) { ins.push(p); });
      access.outputs.forEach(function (p) { outs.push(p); });
      function fill(id, list) {
        sel = $(id); var old = sel.value; sel.innerHTML = '';
        list.forEach(function (p) { var o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
        if (old && list.some(function (p) { return p.id === old; })) { sel.value = old; return; }
        var best = list.filter(function (p) { return /MSQ|FM-?1|JMC|VAVE|SLICE|Felucca/i.test(p.name); })[0];
        if (best) sel.value = best.id;
      }
      fill('d-in', ins); fill('d-out', outs);
    }

    function disconnect(why) {
      if (live) live.stop();
      linkLive = false;
      if (transport) transport.close();
      link = null; transport = null; info = null;
      pill(); showInfo(); enable();
      $('d-connect').textContent = 'Connect to the FM-1';
      if (why) { status(why); log(why); }
    }

    function connect() {
      if (link) { disconnect('Disconnected.'); return; }
      status('Asking the browser for MIDI access…');
      L.midiAccess().then(function (access) {
        midi = access;
        fillPorts(access);
        access.onstatechange = function () {
          fillPorts(access);
          if (link && !(access.inputs.get(transport.input.id) && access.outputs.get(transport.output.id))) disconnect('The FM-1 was unplugged.');
        };
        var inp = access.inputs.get($('d-in').value), out = access.outputs.get($('d-out').value);
        if (!inp || !out) throw new L.LinkError('no MIDI port: plug the FM-1 in USB (running the MSQ-80 firmware m2.59 or later), then connect again');
        transport = new L.MidiTransport(inp, out);
        link = new L.Link(transport);
        return link.info({ timeout: 1500, tries: 2 });
      }).then(function (i) {
        info = i;
        if (i.proto !== 1) { disconnect('This firmware speaks link protocol ' + i.proto + ', this page protocol 1: use the page that goes with the firmware.'); return; }
        $('d-slot').value = String(i.slot);
        $('d-connect').textContent = 'Disconnect';
        pill(); showInfo(); enable();
        status('Connected to the FM-1 (' + i.version + ').'); log('connected: firmware ' + i.version + ', protocol ' + i.proto + ', slot ' + (i.slot + 1) + ', ' + (i.playing ? 'playing' : 'stopped'));
        linkLive = true;
        if (live) live.start(link);
      }).catch(function (e) {
        if (link && !info) { if (transport) transport.close(); link = null; transport = null; }
        status('Could not connect: ' + (e && e.message ? e.message : e)); log('connect failed: ' + (e && e.message ? e.message : e));
        pill(); enable();
      });
    }
    $('d-connect').addEventListener('click', connect);

    function slot() { return +$('d-slot').value || 0; }
    $('d-slot').addEventListener('change', function () { if (link) link.slot(slot()).catch(function () {}); });

    // ---- the transfers
    $('d-send').addEventListener('click', function () {
      var bytes = A.projectBytes(true), s = slot();
      if (!bytes) { status('This page has no project to send.'); return; }
      work('Sending the project to slot ' + (s + 1), function () {
        return link.sendProject(s, bytes, progress, true).then(function () { return 'Project sent to slot ' + (s + 1) + ' (' + bytes.length + ' bytes), loaded on the FM-1'; });
      });
    });
    $('d-read').addEventListener('click', function () {
      work('Reading the FM-1\'s project', function () {
        return link.save().then(function (s) {                                          // the live project goes to its slot first, then it is read from there
          $('d-slot').value = String(s);
          return link.readProject(s, progress).then(function (bytes) {
            if (!A.loadBytes(bytes)) throw new L.LinkError('this page could not load what the FM-1 sent');
            return 'Project read from slot ' + (s + 1) + ' (' + bytes.length + ' bytes), now on this page';
          });
        });
      });
    });
    $('d-save').addEventListener('click', function () {
      work('Saving on the FM-1', function () { return link.save().then(function (s) { return 'Saved in slot ' + (s + 1) + ' of the FM-1'; }); });
    });
    $('d-play').addEventListener('click', function () { if (link) link.transport(1).then(function (p) { log(p ? 'playing' : 'not playing'); }, function (e) { log('FAILED: ' + e.message); }); });
    $('d-stop').addEventListener('click', function () { if (link) link.transport(0).then(function () { log('stopped'); }, function (e) { log('FAILED: ' + e.message); }); });
    $('d-test').addEventListener('click', function () {
      work('Testing the link', function () {
        var times = [], i = 0, t;
        function one() {
          if (i++ >= 10) return Promise.resolve();
          t = performance.now();
          return link.info({ timeout: 1000, tries: 1 }).then(function () { times.push(performance.now() - t); return one(); });
        }
        return one().then(function () {
          t = performance.now();
          return link.screenPack(true);
        }).then(function (r) {
          var sorted = times.slice().sort(function (a, b) { return a - b; }), ms = performance.now() - t;
          log('INFO x10: min ' + sorted[0].toFixed(0) + ' ms, median ' + sorted[5].toFixed(0) + ' ms, max ' + sorted[9].toFixed(0) + ' ms');
          log('SCREEN_PACK (everything): ' + r.bands.length + ' bands in ' + ms.toFixed(0) + ' ms');
          return 'Link test done: median ' + sorted[5].toFixed(0) + ' ms a request';
        });
      });
    });

    // ---- the demos: a project of each, in this page (then it can be played here or sent); a second press within 3 s does it, so that a click by chance loses nothing
    [['demoNeon', 1, 'NEON GRID'], ['demoAcid', 0, 'ACID BREAK'], ['demoIron', 2, 'IRON HALL'], ['demoMotor', 3, 'MOTOR CITY']].forEach(function (d) {
      var btn = $(d[0]), armed = 0;
      btn.addEventListener('click', function () {
        if (!armed) {
          btn.textContent = 'SURE?'; btn.classList.add('warn');
          armed = setTimeout(function () { armed = 0; btn.textContent = d[2]; btn.classList.remove('warn'); }, 3000);
          return;
        }
        clearTimeout(armed); armed = 0; btn.textContent = d[2]; btn.classList.remove('warn');
        A.exports().msq_web_demo(d[1], seed());
        A.autosave();
        status('Demo ' + d[2] + ' is the project of this page: send it to the FM-1 (DEVICE), or play it (VISUAL).');
        log('demo ' + d[2] + ' loaded in the page');
      });
    });

    // ---- LIVE
    live = new Live($('l-panel'), $('l-status'));
    live.paused = function () { return busy || $('tab-live').hidden; };
    live.bindKeyboard(function () { return !$('tab-live').hidden; });

    enable(); pill();
    if (!navigator.requestMIDIAccess) { status('This browser has no Web MIDI: use Chrome or Edge to talk to the FM-1.'); $('d-connect').disabled = true; }
    var first = 'device';
    try { first = window.localStorage.getItem(TAB_KEY) || 'device'; } catch (e) { /* ok */ }
    if (/^#(device|live|visual)$/.test(window.location.hash)) first = window.location.hash.slice(1);        // a link can open a tab: ...#live
    showTab(first);
  };
}());
