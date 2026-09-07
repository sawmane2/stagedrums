/* StageDrums — live mixer for an audio interface (e.g. Focusrite Scarlett).
   Per channel: trim → HPF → 3-band EQ → noise gate (AudioWorklet) → compressor → makeup → pan → fader → master,
   with a post-fader send to a shared reverb. Master → limiter → output device. */
(function (global) {
  'use strict';
  const SD = global.StageDrums;
  const dB = v => Math.pow(10, v / 20);
  const toDb = v => 20 * Math.log10(Math.max(v, 1e-6));

  const PRESETS = {
    'flat':        { label: 'Flat / off', hpf: 20, low: 0, mid: 0, midHz: 1000, high: 0, gateOn: false, gateThr: -60, compOn: false, compThr: -24, ratio: 2, attack: 0.01, release: 0.15, makeup: 0, rev: 0 },
    'vocal':       { label: 'Vocal', hpf: 100, low: -2, mid: 2, midHz: 3000, high: 3, gateOn: true, gateThr: -45, compOn: true, compThr: -18, ratio: 3, attack: 0.005, release: 0.1, makeup: 2, rev: 0.3 },
    'vocal-bgv':   { label: 'Backing vocal', hpf: 140, low: -4, mid: 1, midHz: 3500, high: 2, gateOn: true, gateThr: -42, compOn: true, compThr: -20, ratio: 4, attack: 0.005, release: 0.12, makeup: 2, rev: 0.4 },
    'acoustic':    { label: 'Acoustic guitar', hpf: 80, low: -3, mid: -3, midHz: 300, high: 2, gateOn: false, gateThr: -55, compOn: true, compThr: -20, ratio: 3, attack: 0.01, release: 0.15, makeup: 1, rev: 0.2 },
    'electric':    { label: 'Electric guitar (DI/amp)', hpf: 90, low: 0, mid: 1, midHz: 1200, high: -1, gateOn: true, gateThr: -50, compOn: true, compThr: -20, ratio: 4, attack: 0.003, release: 0.1, makeup: 1, rev: 0.15 },
    'keys':        { label: 'Keys', hpf: 40, low: 0, mid: 0, midHz: 1000, high: 1, gateOn: false, gateThr: -60, compOn: true, compThr: -18, ratio: 2.5, attack: 0.01, release: 0.2, makeup: 1, rev: 0.2 },
    'bass':        { label: 'Bass', hpf: 35, low: 1, mid: -2, midHz: 500, high: -2, gateOn: false, gateThr: -60, compOn: true, compThr: -20, ratio: 4, attack: 0.02, release: 0.25, makeup: 2, rev: 0 },
    'harmonica':   { label: 'Harmonica / horn mic', hpf: 120, low: -3, mid: -2, midHz: 2500, high: 0, gateOn: true, gateThr: -45, compOn: true, compThr: -16, ratio: 3, attack: 0.005, release: 0.12, makeup: 1, rev: 0.25 },
  };

  const CHANNEL_DEFAULTS = { name: 'Channel', input: 0, trim: 0, pan: 0, fader: 0, mute: false, preset: 'flat',
    hpf: 20, low: 0, mid: 0, midHz: 1000, high: 0,
    gateOn: false, gateThr: -45, gateAtk: 0.005, gateHold: 0.06, gateRel: 0.12, gateRange: -80,
    compOn: false, compThr: -24, ratio: 2, attack: 0.01, release: 0.15, knee: 6, makeup: 0, rev: 0 };

  class Channel {
    constructor(mixer, settings) {
      this.mixer = mixer; const ctx = mixer.ctx; this.ctx = ctx;
      this.s = Object.assign({}, CHANNEL_DEFAULTS, settings);
      this.trim = ctx.createGain();
      this.hpf = ctx.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.Q.value = 0.7;
      this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 200;
      this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.Q.value = 1;
      this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 6000;
      this.gate = mixer.workletOk ? new AudioWorkletNode(ctx, 'stagedrums-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }) : ctx.createGain();
      this.gateState = { open: true, gain: 1 };
      if (this.gate.port) this.gate.port.onmessage = e => { this.gateState = e.data; };
      this.comp = ctx.createDynamicsCompressor();
      this.makeup = ctx.createGain();
      this.meter = ctx.createAnalyser(); this.meter.fftSize = 512;
      this.pan = ctx.createStereoPanner();
      this.fader = ctx.createGain();
      this.revSend = ctx.createGain();
      this.trim.connect(this.hpf); this.hpf.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high);
      this.high.connect(this.gate); this.gate.connect(this.comp); this.comp.connect(this.makeup);
      this.makeup.connect(this.meter); this.makeup.connect(this.pan); this.pan.connect(this.fader);
      this.fader.connect(mixer.master); this.fader.connect(this.revSend); this.revSend.connect(mixer.reverbBus);
      this._buf = new Float32Array(this.meter.fftSize);
      this.apply();
    }
    apply() {
      const s = this.s, now = this.ctx.currentTime;
      const set = (p, v) => { p.cancelScheduledValues(now); p.setTargetAtTime(v, now, 0.01); };
      set(this.trim.gain, dB(s.trim));
      set(this.hpf.frequency, s.hpf); set(this.low.gain, s.low); set(this.mid.gain, s.mid); set(this.mid.frequency, s.midHz); set(this.high.gain, s.high);
      if (this.gate.parameters) {
        const gp = this.gate.parameters;
        gp.get('bypass').value = s.gateOn ? 0 : 1; gp.get('threshold').value = s.gateThr; gp.get('attack').value = s.gateAtk;
        gp.get('hold').value = s.gateHold; gp.get('release').value = s.gateRel; gp.get('range').value = s.gateRange;
      }
      // compressor "off" = threshold 0 dB, ratio 1
      set(this.comp.threshold, s.compOn ? s.compThr : 0); set(this.comp.ratio, s.compOn ? s.ratio : 1);
      set(this.comp.attack, s.attack); set(this.comp.release, s.release); set(this.comp.knee, s.knee);
      set(this.makeup.gain, dB(s.compOn ? s.makeup : 0));
      set(this.pan.pan, s.pan);
      set(this.fader.gain, s.mute ? 0 : dB(s.fader));
      set(this.revSend.gain, s.rev);
    }
    setPreset(name) { const p = PRESETS[name]; if (!p) return; const { label, ...vals } = p; Object.assign(this.s, vals, { preset: name }); this.apply(); }
    connectInput(node, outputIndex = 0) { try { this.src && this.src.disconnect(this.trim); } catch {} this.src = node; this.srcIdx = outputIndex; node.connect(this.trim, outputIndex); }
    /** Returns {level dB, reduction dB, gateOpen} */
    readMeter() {
      this.meter.getFloatTimeDomainData(this._buf);
      let pk = 0; for (let i = 0; i < this._buf.length; i++) { const a = Math.abs(this._buf[i]); if (a > pk) pk = a; }
      return { level: toDb(pk), reduction: this.comp.reduction, gateOpen: this.gateState.open };
    }
    dispose() { for (const n of [this.trim, this.hpf, this.low, this.mid, this.high, this.gate, this.comp, this.makeup, this.meter, this.pan, this.fader, this.revSend]) { try { n.disconnect(); } catch {} } }
  }

  class Mixer {
    constructor(ctx) {
      this.ctx = ctx; this.channels = []; this.stream = null; this.source = null; this.splitter = null; this.inputCount = 0;
      this.workletOk = false;
      this.master = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.05;
      this.masterMeter = ctx.createAnalyser(); this.masterMeter.fftSize = 512; this._mbuf = new Float32Array(512);
      this.master.connect(this.limiter); this.limiter.connect(this.masterMeter); this.limiter.connect(ctx.destination);
      // reverb
      this.reverbBus = ctx.createGain();
      this.reverbPre = ctx.createDelay(0.2);
      this.convolver = ctx.createConvolver();
      this.reverbLp = ctx.createBiquadFilter(); this.reverbLp.type = 'lowpass';
      this.reverbReturn = ctx.createGain();
      this.reverbBus.connect(this.reverbPre); this.reverbPre.connect(this.convolver); this.convolver.connect(this.reverbLp); this.reverbLp.connect(this.reverbReturn); this.reverbReturn.connect(this.master);
      this.masterSettings = { master: 0, revDecay: 1.8, revPre: 0.02, revTone: 5000, revReturn: 0, limiter: true, inputId: '', outputId: '' };
      this.setReverb(this.masterSettings);
    }
    async init() {
      try { await this.ctx.audioWorklet.addModule('gate-worklet.js'); this.workletOk = true; }
      catch (e) { console.warn('Gate worklet unavailable, gates bypassed:', e); this.workletOk = false; }
    }
    /** Route the drum kit's output through the mixer master/limiter. */
    attachDrums(kit) {
      try { kit.comp.disconnect(); } catch {}
      this.drumGain = this.ctx.createGain(); kit.comp.connect(this.drumGain); this.drumGain.connect(this.master);
    }
    async listDevices() {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return { inputs: devs.filter(d => d.kind === 'audioinput'), outputs: devs.filter(d => d.kind === 'audiooutput') };
    }
    /** Open the interface. Asks for as many channels as the device offers, with all browser processing off. */
    async openInput(deviceId) {
      this.closeInput();
      const constraints = { audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: { ideal: 32 }, sampleRate: { ideal: this.ctx.sampleRate },
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        // Chrome-specific extras
        googEchoCancellation: false, googAutoGainControl: false, googNoiseSuppression: false, googHighpassFilter: false,
      } };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = this.stream.getAudioTracks()[0];
      const settings = track.getSettings();
      this.inputCount = settings.channelCount || 2;
      this.inputLabel = track.label;
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.inputCount = Math.max(this.inputCount, this.source.channelCount || 1);
      this.splitter = this.ctx.createChannelSplitter(Math.max(2, this.inputCount));
      this.source.connect(this.splitter);
      this.masterSettings.inputId = deviceId || '';
      for (const ch of this.channels) this._patch(ch);
      return { count: this.inputCount, label: this.inputLabel, sampleRate: settings.sampleRate, latency: settings.latency };
    }
    closeInput() {
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      if (this.source) { try { this.source.disconnect(); } catch {} this.source = null; }
      this.splitter = null;
    }
    _patch(ch) { if (this.splitter) ch.connectInput(this.splitter, Math.min(ch.s.input, this.splitter.numberOfOutputs - 1)); }
    addChannel(settings) { const ch = new Channel(this, settings); this.channels.push(ch); this._patch(ch); return ch; }
    removeChannel(ch) { ch.dispose(); this.channels = this.channels.filter(c => c !== ch); }
    setInput(ch, index) { ch.s.input = index; this._patch(ch); }
    async setOutput(deviceId) {
      if (typeof this.ctx.setSinkId !== 'function') throw new Error('This browser cannot pick an output device (use Chrome/Edge). It will use the system default output.');
      await this.ctx.setSinkId(deviceId || ''); this.masterSettings.outputId = deviceId || '';
    }
    setMaster(v) { this.masterSettings.master = v; this.master.gain.setTargetAtTime(dB(v), this.ctx.currentTime, 0.01); }
    setReverb(o) {
      Object.assign(this.masterSettings, o);
      const m = this.masterSettings;
      if (o.revDecay != null || !this.convolver.buffer) this.convolver.buffer = this._impulse(m.revDecay);
      this.reverbPre.delayTime.value = m.revPre; this.reverbLp.frequency.value = m.revTone;
      this.reverbReturn.gain.setTargetAtTime(dB(m.revReturn), this.ctx.currentTime, 0.01);
    }
    _impulse(decay) {
      const sr = this.ctx.sampleRate, len = Math.max(1, Math.floor(sr * Math.min(8, Math.max(0.2, decay))));
      const buf = this.ctx.createBuffer(2, len, sr);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          const env = Math.pow(1 - t, 2.2) * Math.exp(-3 * t);
          // early reflections: a few sparse taps, then dense diffuse tail
          const noise = Math.random() * 2 - 1;
          lp += (noise - lp) * (0.9 - 0.6 * t); // gets darker as it decays
          d[i] = lp * env * (i < sr * 0.01 ? 0.3 : 1);
        }
      }
      return buf;
    }
    readMaster() {
      this.masterMeter.getFloatTimeDomainData(this._mbuf);
      let pk = 0; for (let i = 0; i < this._mbuf.length; i++) { const a = Math.abs(this._mbuf[i]); if (a > pk) pk = a; }
      return { level: toDb(pk), reduction: this.limiter.reduction };
    }
    serialize() { return { master: this.masterSettings, channels: this.channels.map(c => c.s) }; }
    load(data) {
      if (!data) return;
      if (data.master) { Object.assign(this.masterSettings, data.master); this.setMaster(this.masterSettings.master); this.setReverb({}); }
      for (const ch of this.channels) ch.dispose(); this.channels = [];
      (data.channels || []).forEach(s => this.addChannel(s));
    }
  }

  SD.Mixer = Mixer; SD.MixerPresets = PRESETS; SD.ChannelDefaults = CHANNEL_DEFAULTS;
})(window);
