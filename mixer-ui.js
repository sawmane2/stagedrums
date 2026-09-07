/* StageDrums — mixer panel UI (channel strips, meters, presets, device pickers). */
(function (global) {
  'use strict';
  const SD = global.StageDrums;
  const LS = 'stagedrums.mixer';
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function setupMixerUI(ctx, kit) {
    const mixer = new SD.Mixer(ctx);
    let ready = false, raf = null;
    const panel = $('mixerPanel'), strips = $('strips');
    const saved = JSON.parse(localStorage.getItem(LS) || 'null');
    const save = () => localStorage.setItem(LS, JSON.stringify(Object.assign(mixer.serialize(), { auto: $('mixAuto').checked })));

    async function ensureReady() {
      if (ready) return; ready = true;
      await mixer.init(); mixer.attachDrums(kit);
      if (saved) mixer.load(saved);
      if (!mixer.channels.length) { mixer.addChannel({ name: 'Vocal', input: 0, preset: 'vocal' }).setPreset('vocal'); mixer.addChannel({ name: 'Guitar', input: 1, preset: 'electric' }).setPreset('electric'); }
      $('mixMaster').value = mixer.masterSettings.master; $('mixRevDecay').value = mixer.masterSettings.revDecay; $('mixRevReturn').value = mixer.masterSettings.revReturn; $('mixRevTone').value = mixer.masterSettings.revTone;
      renderStrips();
    }

    async function refreshDevices() {
      try {
        const { inputs, outputs } = await mixer.listDevices();
        const inSel = $('mixInput'), outSel = $('mixOutput');
        inSel.innerHTML = inputs.map(d => `<option value="${d.deviceId}">${esc(d.label || 'Audio input')}</option>`).join('') || '<option value="">(allow microphone access to list devices)</option>';
        outSel.innerHTML = '<option value="">System default output</option>' + outputs.map(d => `<option value="${d.deviceId}">${esc(d.label || 'Audio output')}</option>`).join('');
        if (mixer.masterSettings.inputId) inSel.value = mixer.masterSettings.inputId;
        if (mixer.masterSettings.outputId) outSel.value = mixer.masterSettings.outputId;
        // prefer a Focusrite / Scarlett if nothing chosen
        if (!inSel.value) { const f = inputs.find(d => /focusrite|scarlett|clarett/i.test(d.label)); if (f) inSel.value = f.deviceId; }
      } catch (e) { $('mixStatus').textContent = 'Cannot list devices: ' + e.message; }
    }

    async function startInterface() {
      await ensureReady();
      if (ctx.state === 'suspended') await ctx.resume();
      $('mixStatus').textContent = 'Opening…';
      try {
        const info = await mixer.openInput($('mixInput').value || undefined);
        await refreshDevices(); // labels appear after permission
        $('mixStatus').textContent = `${info.label || 'Interface'} — ${info.count} input${info.count === 1 ? '' : 's'} @ ${info.sampleRate || ctx.sampleRate} Hz` + (info.count < 3 ? '  (browser gave a stereo pair: channels 1–2)' : '');
        $('mixStatus').className = 'pill ok';
        if ($('mixOutput').value) { try { await mixer.setOutput($('mixOutput').value); } catch (e) { console.warn(e); } }
        renderStrips(); startMeters(); save();
      } catch (e) { $('mixStatus').textContent = 'Could not open input: ' + e.message; $('mixStatus').className = 'pill warn'; }
    }
    function stopInterface() { mixer.closeInput(); $('mixStatus').textContent = 'Interface closed'; $('mixStatus').className = 'pill'; }

    // ---------- strips ----------
    function slider(label, key, min, max, step, fmt) {
      return `<label class="prm"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}"><b data-v="${key}"></b></label>`;
    }
    const FMT = { trim: v => `${(+v).toFixed(0)} dB`, fader: v => v <= -60 ? '−∞' : `${(+v).toFixed(0)} dB`, pan: v => Math.abs(v) < 0.05 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`,
      hpf: v => `${Math.round(v)} Hz`, low: v => `${(+v).toFixed(0)} dB`, mid: v => `${(+v).toFixed(0)} dB`, midHz: v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)} Hz`, high: v => `${(+v).toFixed(0)} dB`,
      gateThr: v => `${(+v).toFixed(0)} dB`, gateRel: v => `${Math.round(v * 1000)} ms`, compThr: v => `${(+v).toFixed(0)} dB`, ratio: v => `${(+v).toFixed(1)}:1`, attack: v => `${Math.round(v * 1000)} ms`, release: v => `${Math.round(v * 1000)} ms`, makeup: v => `+${(+v).toFixed(0)} dB`, rev: v => `${Math.round(v * 100)}%` };
    function stripHtml(ch, i) {
      const inputs = Array.from({ length: Math.max(2, mixer.inputCount || 2) }, (_, n) => `<option value="${n}" ${ch.s.input === n ? 'selected' : ''}>In ${n + 1}</option>`).join('');
      const presets = Object.entries(SD.MixerPresets).map(([k, p]) => `<option value="${k}" ${ch.s.preset === k ? 'selected' : ''}>${p.label}</option>`).join('');
      return `<div class="strip" data-i="${i}">
        <div class="strip-head"><input class="sname" value="${esc(ch.s.name)}"><button class="small danger srem" title="Remove">✕</button></div>
        <div class="strip-row"><select class="sinput">${inputs}</select><select class="spreset">${presets}</select></div>
        <div class="meter"><div class="lvl"></div><div class="gr"></div><span class="gate-led" title="Gate"></span></div>
        <div class="grp"><div class="grp-title">Input</div>${slider('Trim', 'trim', -20, 20, 1)}${slider('HPF', 'hpf', 20, 400, 5)}</div>
        <div class="grp"><div class="grp-title">EQ</div>${slider('Low', 'low', -12, 12, 1)}${slider('Mid', 'mid', -12, 12, 1)}${slider('Mid Hz', 'midHz', 200, 8000, 50)}${slider('High', 'high', -12, 12, 1)}</div>
        <div class="grp"><div class="grp-title"><label class="chk"><input type="checkbox" data-k="gateOn"> Gate</label></div>${slider('Thresh', 'gateThr', -80, -10, 1)}${slider('Release', 'gateRel', 0.02, 1, 0.01)}</div>
        <div class="grp"><div class="grp-title"><label class="chk" title="The browser compressor adds automatic makeup gain; Makeup here is extra."><input type="checkbox" data-k="compOn"> Comp</label></div>${slider('Thresh', 'compThr', -50, 0, 1)}${slider('Ratio', 'ratio', 1, 12, 0.5)}${slider('Attack', 'attack', 0.001, 0.1, 0.001)}${slider('Release', 'release', 0.03, 1, 0.01)}${slider('Makeup', 'makeup', 0, 18, 1)}</div>
        <div class="grp"><div class="grp-title">Send / out</div>${slider('Reverb', 'rev', 0, 1, 0.01)}${slider('Pan', 'pan', -1, 1, 0.05)}${slider('Fader', 'fader', -60, 10, 1)}
          <button class="small smute ${ch.s.mute ? 'on' : ''}">Mute</button></div>
      </div>`;
    }
    function renderStrips() {
      strips.innerHTML = mixer.channels.map(stripHtml).join('') + `<button id="addStrip" class="strip add">+ Add channel</button>`;
      mixer.channels.forEach((ch, i) => {
        const el = strips.querySelector(`.strip[data-i="${i}"]`);
        const sync = () => {
          el.querySelectorAll('input[type=range]').forEach(r => { r.value = ch.s[r.dataset.k]; const v = el.querySelector(`[data-v="${r.dataset.k}"]`); if (v) v.textContent = (FMT[r.dataset.k] || (x => x))(+r.value); });
          el.querySelectorAll('input[type=checkbox][data-k]').forEach(c => { c.checked = !!ch.s[c.dataset.k]; });
        };
        sync();
        el.querySelectorAll('input[type=range]').forEach(r => r.oninput = () => { ch.s[r.dataset.k] = +r.value; ch.apply(); const v = el.querySelector(`[data-v="${r.dataset.k}"]`); if (v) v.textContent = (FMT[r.dataset.k] || (x => x))(+r.value); save(); });
        el.querySelectorAll('input[type=checkbox][data-k]').forEach(c => c.onchange = () => { ch.s[c.dataset.k] = c.checked; ch.apply(); save(); });
        el.querySelector('.sname').onchange = e => { ch.s.name = e.target.value; save(); };
        el.querySelector('.sinput').onchange = e => { mixer.setInput(ch, +e.target.value); save(); };
        el.querySelector('.spreset').onchange = e => { ch.setPreset(e.target.value); sync(); save(); };
        el.querySelector('.smute').onclick = e => { ch.s.mute = !ch.s.mute; ch.apply(); e.target.classList.toggle('on', ch.s.mute); save(); };
        el.querySelector('.srem').onclick = () => { if (confirm(`Remove ${ch.s.name}?`)) { mixer.removeChannel(ch); renderStrips(); save(); } };
      });
      $('addStrip').onclick = () => { const n = mixer.channels.length; mixer.addChannel({ name: `Ch ${n + 1}`, input: Math.min(n, Math.max(1, mixer.inputCount - 1)) }); renderStrips(); save(); };
    }

    // ---------- meters ----------
    function startMeters() {
      if (raf) return;
      const tick = () => {
        raf = null;
        if (panel.hidden) return;
        mixer.channels.forEach((ch, i) => {
          const el = strips.querySelector(`.strip[data-i="${i}"]`); if (!el) return;
          const m = ch.readMeter();
          el.querySelector('.lvl').style.width = `${Math.max(0, Math.min(100, (m.level + 60) / 60 * 100))}%`;
          el.querySelector('.lvl').classList.toggle('hot', m.level > -3);
          el.querySelector('.gr').style.width = `${Math.max(0, Math.min(100, -m.reduction / 24 * 100))}%`;
          el.querySelector('.gate-led').classList.toggle('open', !ch.s.gateOn || m.gateOpen);
        });
        const mm = mixer.readMaster();
        $('masterLvl').style.width = `${Math.max(0, Math.min(100, (mm.level + 60) / 60 * 100))}%`;
        $('masterLvl').classList.toggle('hot', mm.level > -1);
        $('masterGr').style.width = `${Math.max(0, Math.min(100, -mm.reduction / 12 * 100))}%`;
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    // ---------- panel controls ----------
    $('btnMixer').onclick = async () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) { await ensureReady(); await refreshDevices(); startMeters(); }
    };
    $('mixClose').onclick = () => { panel.hidden = true; };
    $('mixStart').onclick = startInterface;
    $('mixStop').onclick = stopInterface;
    $('mixOutput').onchange = async () => { try { await ensureReady(); await mixer.setOutput($('mixOutput').value); save(); } catch (e) { alert(e.message); } };
    $('mixInput').onchange = () => { if (mixer.stream) startInterface(); };
    $('mixMaster').oninput = () => { mixer.setMaster(+$('mixMaster').value); $('mixMasterV').textContent = `${$('mixMaster').value} dB`; save(); };
    $('mixRevDecay').oninput = () => { mixer.setReverb({ revDecay: +$('mixRevDecay').value }); $('mixRevDecayV').textContent = `${(+$('mixRevDecay').value).toFixed(1)} s`; save(); };
    $('mixRevReturn').oninput = () => { mixer.setReverb({ revReturn: +$('mixRevReturn').value }); $('mixRevReturnV').textContent = `${$('mixRevReturn').value} dB`; save(); };
    $('mixRevTone').oninput = () => { mixer.setReverb({ revTone: +$('mixRevTone').value }); $('mixRevToneV').textContent = `${Math.round($('mixRevTone').value / 100) / 10}k`; save(); };
    $('mixAuto').checked = !!(saved && saved.auto); $('mixAuto').onchange = save;
    if (saved && saved.auto && navigator.mediaDevices) {
      // auto-start after the first user gesture (audio needs one anyway)
      const once = async () => { document.removeEventListener('pointerdown', once); try { await startInterface(); } catch {} };
      document.addEventListener('pointerdown', once);
    }
    return mixer;
  }
  SD.setupMixerUI = setupMixerUI;
})(window);
