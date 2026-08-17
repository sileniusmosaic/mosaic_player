// WebCodecs video engine for Mosaic Player.
//
// Core idea: decode video frames manually from a fully-fetched MP4 ArrayBuffer,
// and paint BOTH the focus square and the 8-tile grid from the exact same
// decoded VideoFrame in the same synchronous step. This structurally eliminates
// the old "two independently-timed processes" drift bug (live <video> element vs
// canvas repeatedly snapshotting it) — there is now only one video pipeline,
// sampled once per render step and drawn twice.
//
// The audio engine (Web Audio stems) remains the master clock exactly as before;
// this engine is purely reactive — given "what time is it right now" it produces
// the matching picture. It never advances time itself.

class WebCodecsVideoEngine {
  constructor({ gridCanvas, focusCanvas, onStatus, onError }) {
    this.gridCtx = gridCanvas.getContext('2d', { alpha: false });
    this.focusCtx = focusCanvas.getContext('2d', { alpha: false });
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.decoder = null;
    this.info = null;          // demuxed MP4 info for the current tempo
    this.sampleIdx = 0;        // next sample to feed to the decoder (decode order)
    this.frameQueue = [];      // decoded VideoFrames, in presentation order (by construction)
    this.displayedFrame = null; // the frame currently painted (kept open until replaced)
    this.selected = 0;         // focus tile index 0-7
    this.muted = new Array(8).fill(false);
    this.cycleSeconds = 0;
    this.decodedFrameCount = 0;
    this.pumpBudgetMs = 6;     // don't let one pump call hog the main thread
    this.maxQueuedFrames = 8;  // decode-ahead buffer depth
    this.destroyed = false;
    this.seeking = false;
  }

  // --- lifecycle -----------------------------------------------------------

  async loadTempo(arrayBuffer) {
    this._teardownDecoder();
    const info = parseMP4(arrayBuffer);
    this.info = info;
    this.cycleSeconds = info.samples.reduce((a, s) => a + s.duration, 0) / info.timescale;
    this.sampleIdx = 0;
    this._clearQueue();
    const config = { codec: info.codec, codedWidth: info.codedWidth, codedHeight: info.codedHeight };
    if (info.description && info.description.length) config.description = info.description;
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error('VideoDecoder does not support this stream: ' + info.codec);
    this.decoder = new VideoDecoder({
      output: (frame) => this._onFrame(frame),
      error: (e) => { console.error('VideoDecoder error:', e); this.onStatus('Video decode error: ' + e.message, 'error'); this.onError(e); }
    });
    this._config = config;
    this.decoder.configure(config);
    this._pump(); // start filling the decode-ahead buffer immediately
  }

  destroy() {
    this.destroyed = true;
    this._teardownDecoder();
    this._clearQueue();
  }

  _teardownDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch {}
    }
    this.decoder = null;
  }

  _clearQueue() {
    for (const f of this.frameQueue) { try { f.close(); } catch {} }
    this.frameQueue = [];
    if (this.displayedFrame) { try { this.displayedFrame.close(); } catch {} this.displayedFrame = null; }
  }

  // --- decode pump -----------------------------------------------------------
  // Feeds encoded chunks into the decoder whenever there's room, looping back to
  // sample 0 (always a keyframe) once we run off the end — this is what makes
  // playback loop seamlessly: decode never actually "stops", it just keeps
  // producing frames for the next lap ahead of when the audio clock needs them.

  _pump() {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    const t0 = performance.now();
    const samples = this.info.samples;
    while (
      this.decoder.decodeQueueSize < this.maxQueuedFrames &&
      this.frameQueue.length < this.maxQueuedFrames &&
      performance.now() - t0 < this.pumpBudgetMs
    ) {
      const s = samples[this.sampleIdx];
      const data = new Uint8Array(this.info.buffer, s.offset, s.size);
      const chunk = new EncodedVideoChunk({
        type: s.isSync ? 'key' : 'delta',
        timestamp: Math.round((s.pts / this.info.timescale) * 1e6), // microseconds
        duration: Math.round((s.duration / this.info.timescale) * 1e6),
        data
      });
      try { this.decoder.decode(chunk); } catch (e) { console.error('decode() threw', e); break; }
      this.sampleIdx++;
      if (this.sampleIdx >= samples.length) this.sampleIdx = 0; // loop: sample 0 is always sync
    }
  }

  _onFrame(frame) {
    this.decodedFrameCount++;
    this.frameQueue.push(frame);
    // Frames should already arrive in ascending presentation order (that's the
    // WebCodecs contract for a correctly-fed decoder), but guard against a
    // misbehaving stream rather than silently mis-render.
    if (this.frameQueue.length > 1) {
      const prev = this.frameQueue[this.frameQueue.length - 2];
      if (frame.timestamp < prev.timestamp) console.warn('Frame arrived out of presentation order:', frame.timestamp, 'after', prev.timestamp);
    }
  }

  // --- seeking ---------------------------------------------------------------
  // Resets the decoder and re-feeds from the nearest keyframe at/before the
  // target, so the very next render() call converges on the right picture
  // within a handful of frames once decode catches up.

  seekTo(targetSeconds) {
    if (!this.info) return;
    this.seeking = true;
    const targetUnits = targetSeconds * this.info.timescale;
    let keyIdx = 0;
    for (let i = 0; i < this.info.samples.length; i++) {
      const s = this.info.samples[i];
      if (s.isSync && s.pts <= targetUnits) keyIdx = i; else if (s.pts > targetUnits) break;
    }
    this._clearQueue();
    if (this.decoder && this.decoder.state === 'configured') {
      try { this.decoder.reset(); } catch {}
      try {
        this.decoder.configure({ codec: this.info.codec, codedWidth: this.info.codedWidth, codedHeight: this.info.codedHeight, description: this.info.description });
      } catch (e) { console.error('re-configure after seek failed', e); }
    }
    this.sampleIdx = keyIdx;
    this._pump();
    this.seeking = false;
  }

  // --- rendering ---------------------------------------------------------------
  // Call every rAF with the current audio-clock-derived playhead position
  // (already wrapped into [0, cycleSeconds)). Picks the right frame, draws it
  // to both canvases from the SAME frame object, and reclaims older frames.

  render(targetSeconds) {
    this._pump(); // keep the buffer topped up every tick, not just on load/seek
    const targetUs = targetSeconds * 1e6;
    let chosen = null, chosenIdx = -1;
    for (let i = 0; i < this.frameQueue.length; i++) {
      if (this.frameQueue[i].timestamp <= targetUs) { chosen = this.frameQueue[i]; chosenIdx = i; }
      else break;
    }
    if (chosen) {
      // Close everything strictly older than the chosen frame — keep the chosen
      // one itself in the queue (harmless; it'll be superseded next tick) but
      // never let closed frames linger as false candidates.
      for (let i = 0; i < chosenIdx; i++) { try { this.frameQueue[i].close(); } catch {} }
      this.frameQueue.splice(0, chosenIdx);
      if (this.displayedFrame && this.displayedFrame !== chosen) { try { this.displayedFrame.close(); } catch {} }
      this.displayedFrame = chosen;
      this._draw(chosen);
    }
    // If nothing qualifies yet (decode still catching up, e.g. right after a
    // seek or tempo switch), keep showing whatever was displayed last rather
    // than flashing black — render() is a no-op in that case.
  }

  _draw(frame) {
    drawGridFromFrame(this.gridCtx, frame, this.muted, this.selected);
    drawFocusFromFrame(this.focusCtx, frame, this.selected);
  }
}

function tileRect(i, w, h) {
  const tw = w / 4, th = h / 2;
  return [(i % 4) * tw, Math.floor(i / 4) * th, tw, th];
}

function drawGridFromFrame(ctx, frame, muted, selected) {
  const w = frame.displayWidth, h = frame.displayHeight;
  const S = ctx.canvas.width / 4, Sh = ctx.canvas.height / 2;
  for (let i = 0; i < 8; i++) {
    const [sx, sy, sw, sh] = tileRect(i, w, h);
    const dx = (i % 4) * S, dy = Math.floor(i / 4) * Sh;
    ctx.drawImage(frame, sx, sy, sw, sh, dx, dy, S, Sh);
    if (muted[i]) { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(dx, dy, S, Sh); }
    ctx.strokeStyle = i === selected ? '#63d7ff' : '#050607';
    ctx.lineWidth = i === selected ? 4 : 2;
    ctx.strokeRect(dx + 1, dy + 1, S - 2, Sh - 2);
  }
}

function drawFocusFromFrame(ctx, frame, selected) {
  const w = frame.displayWidth, h = frame.displayHeight;
  const [sx, sy, sw, sh] = tileRect(selected, w, h);
  ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

if (typeof module !== 'undefined') module.exports = { WebCodecsVideoEngine, drawGridFromFrame, drawFocusFromFrame, tileRect };
