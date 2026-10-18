/* The MSQ-80 link, the page's side (engine/msq_link.c is the FM-1's): SysEx requests to the FM-1 over Web MIDI.
   Frames: F0 7D 4D 38 <cmd> <args> F7. u32 = 5 x 7 bits LSB first, u14 = 2 bytes, data = pack7 (groups of up to 7 bytes after a byte holding their top bits).
   One request at a time, one reply each, retried on silence: Windows' MIDI input stops delivering if it is flooded (SLICE64-FM's lessons). */
(function () {
  'use strict';

  var CMD = { INFO: 1, PROJECT_INFO: 2, PROJECT_BEGIN: 3, PROJECT_WRITE: 4, PROJECT_END: 5, PROJECT_READ: 6, SAVE: 7, LOAD: 8, TRANSPORT: 9, SLOT: 10, SCREEN_PACK: 11, INPUT: 12 };
  var RC_TEXT = ['ok', 'bad arguments', 'flash error', 'CRC mismatch', 'transfer not started', 'no flash', 'the FM-1 could not load the project'];
  var CHUNK = 256;
  var HEAD = [0xF0, 0x7D, 0x4D, 0x38];

  function u32(v) { var o = [], i; for (i = 0; i < 5; i++) o.push(Math.floor(v / Math.pow(128, i)) & 0x7F); return o; }
  function u14(v) { return [v & 0x7F, (v >> 7) & 0x7F]; }
  function getU32(a, i) { return (a[i] | a[i + 1] << 7 | a[i + 2] << 14 | a[i + 3] << 21) + a[i + 4] * 0x10000000; }

  function pack7(bytes) {
    var out = [], i, j, k, mask;
    for (i = 0; i < bytes.length; i += 7) {
      k = Math.min(7, bytes.length - i); mask = 0;
      for (j = 0; j < k; j++) mask |= (bytes[i + j] >> 7) << j;
      out.push(mask);
      for (j = 0; j < k; j++) out.push(bytes[i + j] & 0x7F);
    }
    return out;
  }
  function unpack7(a, start, end) {
    var out = [], i = start || 0, mask, k, j;
    end = end === undefined ? a.length : end;
    while (i < end) {
      mask = a[i++]; k = Math.min(7, end - i);
      for (j = 0; j < k; j++) out.push(a[i + j] | ((mask >> j) & 1) << 7);
      i += k;
    }
    return Uint8Array.from(out);
  }

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), n, k, c;
    for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  }());
  function crc32(bytes, crc) {
    var i;
    crc = ~(crc || 0) >>> 0;
    for (i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return ~crc >>> 0;
  }

  function LinkError(message) { this.name = 'LinkError'; this.message = message; this.stack = (new Error(message)).stack; }
  LinkError.prototype = Object.create(Error.prototype);

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // transport: { send(Uint8Array), onFrame } (the Link sets onFrame)
  function Link(transport) {
    var self = this;
    this.t = transport;
    this.pending = null;
    this.queue = Promise.resolve();
    transport.onFrame = function (f) { self._frame(f); };
  }

  Link.prototype._frame = function (f) {
    if (f.length < 6 || f[0] !== 0xF0 || f[1] !== 0x7D || f[2] !== 0x4D || f[3] !== 0x38) return;
    var p = this.pending, args = f.subarray(5, f.length - 1);
    if (p && f[4] === p.cmd) { this.pending = null; clearTimeout(p.timer); p.resolve(args); }
  };

  Link.prototype._once = function (cmd, args, timeout) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { self.pending = null; reject(new LinkError('no answer (command ' + cmd + ')')); }, timeout);
      self.pending = { cmd: cmd, resolve: resolve, timer: timer };
      self.t.send(Uint8Array.from(HEAD.concat([cmd], args, [0xF7])));
    });
  };

  // one request at a time, retried on silence
  Link.prototype.request = function (cmd, args, opts) {
    var self = this, o = opts || {}, timeout = o.timeout || 1500, tries = o.tries || 3;
    function run() {
      var i = 0, last;
      function next() {
        if (i >= tries) return Promise.reject(last);
        i++;
        return self._once(cmd, args || [], timeout).catch(function (e) { last = e; return next(); });
      }
      return next();
    }
    var p = this.queue.then(run, run);
    this.queue = p.catch(function () {});
    return p;
  };

  function checkRc(rc, what) {
    if (rc !== 0) throw new LinkError(what + ': ' + (RC_TEXT[rc] || 'error ' + rc));
  }

  function lights(a) { return { lit: getU32(a, 0), glow: getU32(a, 5), keys: getU32(a, 10), theme: a[15] & 7, page: a[15] >> 3 }; }

  Link.prototype.info = function (opts) {
    return this.request(CMD.INFO, [], opts).then(function (a) {
      var s = '', i;
      for (i = 11; i < a.length && a[i]; i++) s += String.fromCharCode(a[i]);
      return { proto: a[0], flash: !!(a[1] & 1), slots: a[2], maxProject: getU32(a, 3), slot: a[8], playing: !!a[9], page: a[10], version: s };
    });
  };

  Link.prototype.projectInfo = function (slot) {
    return this.request(CMD.PROJECT_INFO, [slot]).then(function (a) {
      return { slot: a[0], present: !!a[1], length: getU32(a, 2), crc: getU32(a, 7) };
    });
  };

  // a project into a slot of the FM-1 (flash), and (load) into the machine: begin, the pieces of 256 bytes one by one, end
  Link.prototype.sendProject = function (slot, bytes, progress, load) {
    var self = this, off = 0;
    function pieces() {
      if (off >= bytes.length) return Promise.resolve();
      var chunk = bytes.subarray(off, Math.min(off + CHUNK, bytes.length)), at = off;
      return self.request(CMD.PROJECT_WRITE, u32(at).concat(pack7(chunk)), { timeout: 3000 }).then(function (a) {
        checkRc(a[5], 'project');
        off = at + chunk.length;
        if (progress) progress(off, bytes.length);
        return pieces();
      });
    }
    return self.request(CMD.PROJECT_BEGIN, [slot].concat(u32(bytes.length)), { timeout: 12000, tries: 1 }).then(function (a) {
      checkRc(a[0], 'project');
      return pieces();
    }).then(function () {
      return self.request(CMD.PROJECT_END, u32(crc32(bytes)).concat([load ? 1 : 0]), { timeout: 10000, tries: 1 });
    }).then(function (a) { checkRc(a[0], 'project'); });
  };

  // the project stored in a slot, read 256 bytes at a time
  Link.prototype.readProject = function (slot, progress) {
    var self = this;
    return this.projectInfo(slot).then(function (inf) {
      if (!inf.present) throw new LinkError('slot ' + (slot + 1) + ' is empty');
      var out = new Uint8Array(inf.length), off = 0;
      function next() {
        if (off >= inf.length) {
          if (crc32(out) !== inf.crc) throw new LinkError('the project read does not match its CRC');
          return Promise.resolve(out);
        }
        var n = Math.min(CHUNK, inf.length - off), at = off;
        return self.request(CMD.PROJECT_READ, [slot].concat(u32(at), u14(n))).then(function (a) {
          var d = unpack7(a, 8);
          if (getU32(a, 1) !== at || d.length !== n) throw new LinkError('bad read reply');
          out.set(d, at);
          off = at + n;
          if (progress) progress(off, inf.length);
          return next();
        });
      }
      return next();
    });
  };

  Link.prototype.save = function () {
    return this.request(CMD.SAVE, [], { timeout: 15000, tries: 1 }).then(function (a) { checkRc(a[0], 'save'); return a[1]; });
  };
  Link.prototype.load = function (slot) {
    return this.request(CMD.LOAD, [slot], { timeout: 8000, tries: 1 }).then(function (a) { checkRc(a[0], 'load'); });
  };
  Link.prototype.transport = function (op) { return this.request(CMD.TRANSPORT, [op]).then(function (a) { return !!a[0]; }); };
  Link.prototype.slot = function (slot) { return this.request(CMD.SLOT, [slot]).then(function (a) { return a[0]; }); };

  // the screen mirror: the changed bands of 8 rows in ONE frame (Windows' MIDI stack loses back-to-back SysEx), and the panel lights
  Link.prototype.screenPack = function (reset) {
    return this.request(CMD.SCREEN_PACK, [reset ? 1 : 0], { timeout: 2000, tries: 1 }).then(function (a) {
      var bands = [], p = 17, k, band, len, packed, r = lights(a);
      for (k = 0; k < a[16] && p < a.length; k++) {
        band = a[p]; len = a[p + 1] | a[p + 2] << 7; packed = len + Math.ceil(len / 7);
        bands.push({ band: band, data: unpack7(a, p + 3, p + 3 + packed) });
        p += 3 + packed;
      }
      r.bands = bands;
      return r;
    });
  };

  // the editor's panel plays the FM-1 (kind 0 button, 1 key, 2 knob; value 1 / 0 or detents)
  Link.prototype.input = function (kind, id, value) {
    return this.request(CMD.INPUT, [kind, id].concat(u14(value + 8192)), { timeout: 800, tries: 3 }).then(lights);
  };

  // ------------------------------------------------------------------ the screen: a band of 8 rows (encoding byte first) into RGBA pixels
  var LCD = 240, BAND_ROWS = 8, BANDS = LCD / BAND_ROWS;
  function decodeBand(d, rgba, offset) {
    var n = LCD * BAND_ROWS, i, k, np, pal, base, p, r, c, v, o;
    function put(idx, col) {
      var q = offset + idx * 4;
      rgba[q] = (col >> 8 & 0xF8) | (col >> 13); rgba[q + 1] = (col >> 3 & 0xFC) | (col >> 9 & 3); rgba[q + 2] = (col << 3 & 0xF8) | (col >> 2 & 7); rgba[q + 3] = 255;
    }
    if (d[0] === 0) { c = d[1] | d[2] << 8; for (i = 0; i < n; i++) put(i, c); return; }
    if (d[0] === 1) {                                // n colours, 4 bits a pixel
      np = d[1]; pal = [];
      for (k = 0; k < np; k++) pal.push(d[2 + 2 * k] | d[3 + 2 * k] << 8);
      base = 2 + 2 * np;
      for (i = 0; i < n; i++) put(i, pal[(d[base + (i >> 1)] >> (i & 1 ? 4 : 0)) & 15]);
      return;
    }
    if (d[0] === 4) {                                // palette and runs: (length - 1) << 4 | colour
      np = d[1]; pal = [];
      for (k = 0; k < np; k++) pal.push(d[2 + 2 * k] | d[3 + 2 * k] << 8);
      i = 0;
      for (p = 2 + 2 * np; p < d.length && i < n; p++) {
        c = pal[d[p] & 15];
        for (r = (d[p] >> 4) + 1; r > 0 && i < n; r--) put(i++, c);
      }
      return;
    }
    for (i = 0; i < n; i++) {                        // RGB332 (more than 16 colours: lossy)
      v = d[1 + i]; o = offset + i * 4;
      rgba[o] = (v & 0xE0) * 255 / 224; rgba[o + 1] = (v << 3 & 0xE0) * 255 / 224; rgba[o + 2] = (v & 3) * 85; rgba[o + 3] = 255;
    }
  }
  function rgb565ToRgba(c) { return [(c >> 8 & 0xF8) | (c >> 13), (c >> 3 & 0xFC) | (c >> 9 & 3), (c << 3 & 0xF8) | (c >> 2 & 7), 255]; }

  // ------------------------------------------------------------------ Web MIDI (Chrome / Edge, SysEx permission)
  function midiAccess() {
    if (!navigator.requestMIDIAccess) return Promise.reject(new LinkError('this browser has no Web MIDI: use Chrome or Edge'));
    return navigator.requestMIDIAccess({ sysex: true });
  }

  function MidiTransport(input, output) {
    var self = this;
    this.input = input; this.output = output; this.onFrame = null; this.buf = [];
    input.onmidimessage = function (e) { self._data(e.data); };
  }
  MidiTransport.prototype._data = function (d) {
    var i, b;
    for (i = 0; i < d.length; i++) {
      b = d[i];
      if (b === 0xF0) this.buf = [b];
      else if (this.buf.length) {
        if (b >= 0xF8) continue;                       // realtime inside SysEx
        this.buf.push(b);
        if (b === 0xF7) { var f = Uint8Array.from(this.buf); this.buf = []; if (this.onFrame) this.onFrame(f); }
      }
    }
  };
  MidiTransport.prototype.send = function (bytes) { this.output.send(bytes); };
  MidiTransport.prototype.close = function () { this.input.onmidimessage = null; };

  var root = typeof window !== 'undefined' ? window : globalThis;
  root.MsqLink = { CMD: CMD, CHUNK: CHUNK, Link: Link, LinkError: LinkError, MidiTransport: MidiTransport, midiAccess: midiAccess,
    LCD: LCD, BAND_ROWS: BAND_ROWS, BANDS: BANDS, decodeBand: decodeBand, rgb565ToRgba: rgb565ToRgba,
    crc32: crc32, pack7: pack7, unpack7: unpack7, u32: u32, u14: u14, getU32: getU32, sleep: sleep, RC_TEXT: RC_TEXT };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MsqLink;   // the node test
}());
