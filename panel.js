/* The front panel of the MSQ-80, drawn as the device: the screen, MASTER and four knobs that change their job with the page,
   transport and page buttons with their lights, eight function buttons whose legends follow the page, a d-pad and a DATA
   wheel, a keybed (the 8 pads and 8 stutters take its place on the drum pages). It sits on the engine's own commands, like
   the touch view: this file only draws the box and sends the same keys. app.js calls msqPanelInit when it starts. */
(function () {
  'use strict';

  var DESIGN_W = 600, H_KEYS = 1056, H_PADS = 1210;
  var VIEW_KEY = 'msq8-view';

  window.msqPanelInit = function (A) {
    var mk = A.mk, K = A.K, F = A.F, PAGE = A.PAGE;
    var dev = A.$('device'), stage = A.$('stage'), panelView = A.$('panelview'), touchView = A.$('touchview');
    var leds = [], knobs = [], master = null, wheel = null, curH = H_KEYS, shown = -1, softEls = [], softIdx = {}, more = null;
    var keysBox = null, padsBox = null;

    function X() { return A.exports(); }

    function place(el, x, y, w, h) {
      el.style.left = x + 'px'; el.style.top = y + 'px';
      if (w) el.style.width = w + 'px';
      if (h) el.style.height = h + 'px';
      dev.appendChild(el);
      return el;
    }

    function legend(text, x, y, w) {
      var d = mk('div', 'legend', text);
      d.style.width = (w || 300) + 'px';
      return place(d, x, y);
    }

    function cstr(ptr) {
      var m = new Uint8Array(X().memory.buffer, ptr, 40), s = '', i;
      for (i = 0; i < 40 && m[i]; ++i) s += String.fromCharCode(m[i]);
      return s;
    }

    // a key of the engine, sent with the given modifiers
    function send(key, sh, ct) { return function (r) { A.key(key, sh, ct, r); }; }

    function lamp(el, test, color) {
      var i = mk('i', 'led');
      if (color) el.classList.add(color);
      el.appendChild(i);
      leds.push({ el: i, test: test });
    }

    function pbtn(label, x, y, w, h, down, rep, test, color) {
      var b = mk('div', 'pbtn');
      b.appendChild(mk('span', 'leg', label));
      if (test) lamp(b, test, color);
      A.press(b, down, null, !!rep);
      return place(b, x, y, w, h);
    }

    // ---------------------------------------------------------------- knobs
    function knobSvg(extra) {
      var ticks = '', i;
      for (i = 0; i <= 10; ++i) ticks += '<line class="tick" x1="0" y1="-45" x2="0" y2="-49" transform="rotate(' + (-135 + 27 * i) + ')"/>';
      return '<svg viewBox="-50 -50 100 100" aria-hidden="true">' + ticks + '<circle class="kb" r="38"/>' + extra + '</svg>';
    }

    // a pot: dragged up or down (or turned with the mouse wheel) it makes detents; its pointer shows `value`
    function makeKnob(cx, cy, r, turn) {
      var el = mk('div', 'knob'), ptr, acc = 0, last = 0, active = false;
      el.innerHTML = knobSvg('<circle class="hi" r="30"/><line class="ptr" x1="0" y1="-10" x2="0" y2="-33"/>');
      ptr = el.querySelector('.ptr');
      place(el, cx - r, cy - r, 2 * r, 2 * r);
      el.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        active = true; last = ev.clientY; acc = 0;
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ok */ }
        A.ensureAudio();
      });
      el.addEventListener('pointermove', function (ev) {
        if (!active) return;
        acc += last - ev.clientY; last = ev.clientY;
        var n = acc < 0 ? Math.ceil(acc / 4) : Math.floor(acc / 4);
        if (n) { acc -= n * 4; turn(n); }
      });
      function end() { active = false; }
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('wheel', function (ev) { ev.preventDefault(); turn(ev.deltaY < 0 ? 1 : -1); }, { passive: false });
      return {
        el: el, label: null, shown: -1,
        set: function (v) {
          var a = Math.round(-135 + 270 * v);
          if (a !== this.shown) { this.shown = a; ptr.setAttribute('transform', 'rotate(' + a + ')'); }
        }
      };
    }

    function buildKnobs() {
      var spots = [[410, 158], [530, 158], [410, 290], [530, 290]], k;
      for (k = 0; k < 4; ++k) (function (n) {
        var kn = makeKnob(spots[n][0], spots[n][1], 32, function (d) { X().msq_web_knob(n, d); });
        kn.label = mk('div', 'klabel', 'KNOB ' + (n + 1));
        kn.label.style.width = '116px';
        place(kn.label, spots[n][0] - 58, spots[n][1] + 38);
        knobs.push(kn);
      })(k);
      master = makeKnob(548, 42, 24, function (d) { X().msq_web_master(d); });
      legend('MASTER', 446, 36, 74).style.textAlign = 'right';
    }

    // ---------------------------------------------------------------- DATA wheel (a left / right)
    function buildWheel() {
      var el = mk('div', 'wheel'), notches = '', i, acc = 0, last = 0, angle = 0, active = false, sh = false, ct = false;
      for (i = 0; i < 24; ++i) notches += '<line class="tick" x1="0" y1="-43" x2="0" y2="-49" transform="rotate(' + (i * 15) + ')"/>';
      el.innerHTML = '<svg viewBox="-50 -50 100 100" aria-hidden="true"><g class="spin">' + notches + '<circle class="kb" r="38"/><circle class="dot" cx="0" cy="-27" r="4"/></g></svg>';
      var spin = el.querySelector('.spin');
      place(el, 408, 738, 124, 124);
      el.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        active = true; last = ev.clientX; acc = 0;
        sh = A.mods.shift; ct = A.mods.ctrl; A.releaseMods();
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ok */ }
        A.ensureAudio();
      });
      el.addEventListener('pointermove', function (ev) {
        if (!active) return;
        acc += ev.clientX - last; last = ev.clientX;
        var n = acc < 0 ? Math.ceil(acc / 9) : Math.floor(acc / 9), s = n < 0 ? -1 : 1, j;
        if (!n) return;
        acc -= n * 9;
        for (j = 0; j < Math.abs(n); ++j) A.key(s < 0 ? K.LEFT : K.RIGHT, sh, ct, j > 0);
        angle += n * 15; spin.setAttribute('transform', 'rotate(' + angle + ')');
      });
      function end() { active = false; }
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('wheel', function (ev) { ev.preventDefault(); A.key(ev.deltaY < 0 ? K.RIGHT : K.LEFT, A.mods.shift, A.mods.ctrl, false); A.releaseMods(); }, { passive: false });
      wheel = el;
      legend('DATA', 408, 868, 124).style.textAlign = 'center';
    }

    // ---------------------------------------------------------------- buttons
    function buildButtons() {
      var x0 = 23, pitch = 70, w = 64, h = 46, i;
      legend('TRANSPORT', x0, 404);
      pbtn('◀◀ REW', x0, 420, w, h, send(K.BACKSPACE, false, false), false);
      pbtn('▶ PLAY', x0 + pitch, 420, w, h, send(K.SPACE, false, false), false, function () { return X().msq_web_state(2); }, 'green');
      pbtn('● REC', x0 + 2 * pitch, 420, w, h, send(F(5), false, false), false, function () { return X().msq_web_state(3); }, 'red');
      pbtn('TEMPO −', x0 + 3 * pitch, 420, w, h, send(K.END, false, false), true);
      pbtn('TEMPO +', x0 + 4 * pitch, 420, w, h, send(K.HOME, false, false), true);
      var sb = pbtn('SHIFT', x0 + 5 * pitch, 420, w, h, function () {}, false);
      sb.classList.add('js-shift');
      sb.addEventListener('pointerdown', function (ev) { ev.preventDefault(); A.toggleMod(true); });
      var cb = pbtn('CTRL', x0 + 6 * pitch, 420, w, h, function () {}, false);
      cb.classList.add('js-ctrl');
      cb.addEventListener('pointerdown', function (ev) { ev.preventDefault(); A.toggleMod(false); });
      pbtn('PANIC', x0 + 7 * pitch, 420, w, h, send(K.ESC, false, false), false).classList.add('warn');

      legend('PAGES', x0, 474);
      [['SOUND', PAGE.SOUND], ['SEQ', PAGE.SEQ], ['SONG', PAGE.SONG], ['NRV8', PAGE.NRV8], ['FX', PAGE.FX]].forEach(function (p, n) {
        pbtn(p[0], x0 + n * pitch, 490, w, h, function () { X().msq_web_page(p[1]); }, false, function () { return X().msq_web_state(0) === p[1]; }, 'amber');
      });
      pbtn('TRACK −', x0 + 5 * pitch, 490, w, h, send(F(3), false, false), false);
      pbtn('TRACK +', x0 + 6 * pitch, 490, w, h, send(F(4), false, false), false);
      pbtn('MUTE', x0 + 7 * pitch, 490, w, h, send(F(6), false, false), false, function () { return X().msq_web_state(8); }, 'red');

      legend('FUNCTIONS', x0, 544);
      for (i = 0; i < 8; ++i) (function (n) {
        var b = mk('div', 'pbtn psoft');
        b.appendChild(mk('span', 'leg', ''));
        b.appendChild(mk('small', 'hint', ''));
        A.press(b, function (r) {
          var s = b._s;
          if (s && (!r || s[4])) A.key(s[1], s[2], s[3], r);
        }, null, true);
        place(b, x0 + (n % 4) * 140, 560 + Math.floor(n / 4) * 52, 134, 46);
        softEls.push(b);
      })(i);
      more = pbtn('MORE ▸', x0, 664, 554, 28, function () {
        var page = X().msq_web_state(0);
        softIdx[page] = (softIdx[page] || 0) + 1;
        refreshSofts(page);
      }, false);
      more.classList.add('more');

      legend('NAVIGATION', x0, 708);
      var cells = [null, ['▲', K.UP], null, ['◀', K.LEFT], ['OK', K.ENTER], ['▶', K.RIGHT], null, ['▼', K.DOWN], null];
      cells.forEach(function (c, n) {
        if (!c) return;
        var sh = false, ct = false;                              // the modifiers latched when it was pressed: held, it repeats with them
        pbtn(c[0], x0 + (n % 3) * 70, 724 + Math.floor(n / 3) * 56, 64, 50, function (r) {
          if (!r) { sh = A.mods.shift; ct = A.mods.ctrl; A.releaseMods(); }
          A.key(c[1], sh, ct, r);
        }, c[1] !== K.ENTER).classList.add('dp');
      });
      pbtn('OCT −', 240, 724, 84, 50, send(K.PGDN, false, false), false);
      pbtn('OCT +', 240, 780, 84, 50, send(K.PGUP, false, false), false);
      buildWheel();
    }

    // the function buttons show the page's shortcuts, eight at a time; MORE turns the set
    function refreshSofts(page) {
      var list = A.SHORT[page] || [], sets = Math.max(1, Math.ceil(list.length / 8)), idx = (softIdx[page] || 0) % sets, i;
      softIdx[page] = idx;
      for (i = 0; i < 8; ++i) {
        var s = list[idx * 8 + i], b = softEls[i];
        b._s = s || null;
        b.classList.toggle('empty', !s);
        b.querySelector('.leg').textContent = s ? s[0] : '';
        b.querySelector('.hint').textContent = s ? s[5] : '';
      }
      more.querySelector('.leg').textContent = sets > 1 ? 'MORE FUNCTIONS ▸  ' + (idx + 1) + '/' + sets : 'FUNCTIONS OF THIS PAGE';
      more.classList.toggle('empty', sets < 2);
    }

    // ---------------------------------------------------------------- the keybed, or the pads
    function buildKeys() {
      var white = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24], bw = 554 / white.length;
      keysBox = mk('div', 'pkeys');
      white.forEach(function (semi) {
        var k = mk('div', 'white', semi % 12 === 0 ? 'C' + (semi / 12) : '');
        A.attachKey(k, semi);
        keysBox.appendChild(k);
      });
      Object.keys(A.BLACK).forEach(function (s) {
        var k = mk('div', 'black');
        k.style.left = ((A.BLACK[s] + 1) * bw - 11) + 'px';
        A.attachKey(k, +s);
        keysBox.appendChild(k);
      });
      place(keysBox, 23, 928, 554, 124);
      legend('KEYBOARD', 23, 910);

      padsBox = mk('div', 'ppads');
      A.VOICE_NAMES.forEach(function (name, v) {
        var b = mk('div', 'ppad pad' + v, name);
        A.press(b, function () { X().msq_web_pad(v); }, null, false);
        padsBox.appendChild(b);
      });
      var lab = mk('div', 'legend', 'STUTTERS · HOLD');
      lab.style.gridColumn = '1 / -1';
      padsBox.appendChild(lab);
      A.STUTTER_NAMES.forEach(function (name, m) {
        var b = mk('div', 'ppad stut', name);
        A.press(b, function () { X().msq_web_stutter(m + 1); }, function () { X().msq_web_stutter(0); }, false);
        padsBox.appendChild(b);
      });
      place(padsBox, 23, 928, 554, 262);
    }

    // ---------------------------------------------------------------- the screen
    function buildScreen() {
      legend('MSQ-80', 24, 14, 200).classList.add('logo');
      legend('SYNTHESIZER · SEQUENCER · RHYTHM NRV8', 24, 52, 330);
      var bez = mk('div', 'bezel');
      place(bez, 18, 80, 320, 320);
      var cv = mk('canvas', null);
      cv.id = 'pscreen'; cv.width = 240; cv.height = 240;
      cv.style.left = '10px'; cv.style.top = '10px';
      bez.appendChild(cv);
      A.addScreen(cv);
      var st = mk('button', 'js-start pstart', 'TAP TO START');
      st.type = 'button';
      st.addEventListener('pointerdown', function (ev) { ev.preventDefault(); A.ensureAudio(); });
      bez.appendChild(st);
    }

    // ---------------------------------------------------------------- layout and what follows the engine
    function fit() {
      var w = panelView.clientWidth || stage.parentNode.clientWidth || 360, s = Math.min(1.12, w / DESIGN_W);
      dev.style.height = curH + 'px';
      dev.style.transform = 'scale(' + s + ')';
      dev.style.left = Math.max(0, (w - DESIGN_W * s) / 2) + 'px';
      stage.style.height = Math.ceil(curH * s) + 'px';
    }

    function relayout(page) {
      var drums = page === PAGE.NRV8 || page === PAGE.FX;
      keysBox.style.display = drums ? 'none' : 'flex';
      padsBox.style.display = drums ? 'grid' : 'none';
      curH = drums ? H_PADS : H_KEYS;
      fit();
    }

    function update() {
      if (panelView.hidden) return;
      var x = X(), page = x.msq_web_state(0), k, i, name;
      if (page !== shown) { shown = page; relayout(page); refreshSofts(page); }
      for (i = 0; i < leds.length; ++i) leds[i].el.classList.toggle('lit', !!leds[i].test());
      for (k = 0; k < 4; ++k) {
        knobs[k].set(x.msq_web_knob_value(k) / 1000);
        name = cstr(x.msq_web_knob_name(k));
        if (knobs[k].label.textContent !== name) knobs[k].label.textContent = name;
      }
      master.set(x.msq_web_master_value() / 1000);
    }

    // ---------------------------------------------------------------- the two views
    function setView(v) {
      panelView.hidden = v !== 'panel';
      touchView.hidden = v !== 'touch';
      A.$('vPanel').classList.toggle('tab-active', v === 'panel');
      A.$('vTouch').classList.toggle('tab-active', v === 'touch');
      try { window.localStorage.setItem(VIEW_KEY, v); } catch (e) { /* ok */ }
      if (v === 'panel') { shown = -1; fit(); }
    }

    buildScreen(); buildKnobs(); buildButtons(); buildKeys();
    A.$('vPanel').addEventListener('click', function () { setView('panel'); });
    A.$('vTouch').addEventListener('click', function () { setView('touch'); });
    window.addEventListener('resize', function () { if (!panelView.hidden) fit(); });
    A.onFrame(update);

    var saved = null;
    try { saved = window.localStorage.getItem(VIEW_KEY); } catch (e) { /* ok */ }
    setView(saved === 'panel' || saved === 'touch' ? saved : (window.innerWidth >= 700 ? 'panel' : 'touch'));
  };
}());
