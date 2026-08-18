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
    this._resetLapTracking();
  }

  // Frame timestamps reset to ~0 at every loop point (sample 0's pts is always
  // ~0), but decode runs ahead of playback — so right at a loop boundary, the
  // frame queue can genuinely contain the tail of one lap (high timestamps)
  // followed by the head of the next (low timestamps). A naive "timestamp
  // strictly ascending" scan breaks there: it sees a small timestamp after a
  // large one, treats the large one as still "in the future", and freezes
  // forever (this was the real bug — decode stalls too, since nothing ever
  // gets consumed off the front of a wedged queue). Fix: track lap count
  // independently for frames (via output-order wrap detection) and for the
  // playback target (via the same heuristic on the caller's wrapped position),
  // then compare both on one monotonically-increasing "global" timeline.
  _resetLapTracking() {
    this.lapIndex = 0; this._lastOutputRawTs = null;
    this.displayLapIndex = 0; this._lastTargetRawTs = null;
  }

  // --- lifecycle -----------------------------------------------------------

  // NOTE: does NOT start decoding on its own — the caller MUST follow this with
  // seekTo(pos) (0 is fine for "start at the beginning") to actually kick off
  // the decode-ahead pump. This is deliberate: a tempo change loads a brand new
  // file and then immediately seeks into it to resume at the right spot, and if
  // loadTempo() auto-pumped from sample 0 first, that seek would have to
  // reset()+reconfigure() a decoder that was JUST configured a moment earlier —
  // two hardware decoder session setups back-to-back for one tempo switch.
  // Observed on a Pixel 6a as a permanent stall (picture frozen forever, only a
  // full Reset recovered it) — some Android hardware decoders don't tolerate
  // being reset that soon after configure(). Requiring an explicit seekTo()
  // after every load means the decoder is configured exactly once per load,
  // full stop, and only genuinely-in-flight decodes ever get reset.
  async loadTempo(arrayBuffer) {
    this._teardownDecoder();
    const info = parseMP4(arrayBuffer);
    this.info = info;
    this.cycleSeconds = info.samples.reduce((a, s) => a + s.duration, 0) / info.timescale;
    this.sampleIdx = 0;
    this._clearQueue();
    this._resetLapTracking();
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
    this._everPumped = false; // nothing fed to this decoder instance yet — seekTo() can skip reset()
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
      try { this.decoder.decode(chunk); this._everPumped = true; } catch (e) { console.error('decode() threw', e); break; }
      this.sampleIdx++;
      if (this.sampleIdx >= samples.length) this.sampleIdx = 0; // loop: sample 0 is always sync
    }
  }

  _onFrame(frame) {
    this.decodedFrameCount++;
    const rawTs = frame.timestamp;
    // Output order is always correct presentation order WITHIN a lap (that's
    // the WebCodecs contract for a correctly-fed decoder); a big backward jump
    // in the raw value is therefore the loop point, not disorder — detect it
    // and fold it into a monotonically-increasing global timestamp so the
    // queue stays comparable straight across the boundary.
    if (this._lastOutputRawTs !== null && rawTs < this._lastOutputRawTs - (this.cycleSeconds * 1e6 * 0.5)) {
      this.lapIndex++;
    }
    this._lastOutputRawTs = rawTs;
    frame.globalTimestamp = this.lapIndex * this.cycleSeconds * 1e6 + rawTs;
    this.frameQueue.push(frame);
    if (this.frameQueue.length > 1) {
      const prev = this.frameQueue[this.frameQueue.length - 2];
      if (frame.globalTimestamp < prev.globalTimestamp) console.warn('Frame arrived out of global order:', frame.globalTimestamp, 'after', prev.globalTimestamp);
    }
  }

  // --- seeking ---------------------------------------------------------------
  // Re-feeds from the nearest keyframe at/before the target, so the very next
  // render() call converges on the right picture within a handful of frames
  // once decode catches up. Only resets+reconfigures the actual hardware
  // decoder if it had already been fed samples (a real seek mid-playback) —
  // right after loadTempo(), the decoder is brand new and has decoded nothing,
  // so there's nothing to abandon and reconfiguring it again is both wasted
  // work and the thing that was stalling decode permanently on Android (see
  // loadTempo()'s comment).

  seekTo(targetSeconds) {
    if (!this.info) return;
    this.seeking = true;
    const keyIdx = this._keyframeIndexFor(targetSeconds);
    this._clearQueue();
    this._resetLapTracking(); // fresh baseline — old lap count is meaningless after a jump
    if (this._everPumped && this.decoder && this.decoder.state === 'configured') {
      try { this.decoder.reset(); } catch {}
      try { this.decoder.configure(this._config); } catch (e) { console.error('re-configure after seek failed', e); }
      this._everPumped = false;
    }
    this.sampleIdx = keyIdx;
    this._pump();
    this.seeking = false;
  }

  _keyframeIndexFor(targetSeconds) {
    const targetUnits = targetSeconds * this.info.timescale;
    let keyIdx = 0;
    for (let i = 0; i < this.info.samples.length; i++) {
      const s = this.info.samples[i];
      if (s.isSync && s.pts <= targetUnits) keyIdx = i; else if (s.pts > targetUnits) break;
    }
    return keyIdx;
  }

  // --- rendering ---------------------------------------------------------------
  // Call every rAF with the current audio-clock-derived playhead position
  // (already wrapped into [0, cycleSeconds)). Picks the right frame, draws it
  // to both canvases from the SAME frame object, and reclaims older frames.

  render(targetSeconds) {
    this._pump(); // keep the buffer topped up every tick, not just on load/seek
    const rawTargetUs = targetSeconds * 1e6;
    // Same wrap-detection heuristic as _onFrame, applied independently to the
    // caller's wrapped position — both sides converge on the same global
    // timeline because they're driven by the same real-time progression, even
    // though neither knows the other's lap count directly.
    if (this._lastTargetRawTs !== null && rawTargetUs < this._lastTargetRawTs - (this.cycleSeconds * 1e6 * 0.5)) {
      this.displayLapIndex++;
    }
    this._lastTargetRawTs = rawTargetUs;
    const globalTargetUs = this.displayLapIndex * this.cycleSeconds * 1e6 + rawTargetUs;
    let chosen = null, chosenIdx = -1;
    for (let i = 0; i < this.frameQueue.length; i++) {
      if (this.frameQueue[i].globalTimestamp <= globalTargetUs) { chosen = this.frameQueue[i]; chosenIdx = i; }
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

  // Blit the full decoded frame to a plain 2D offscreen canvas ONCE per render
  // step, then crop all 9 destination views (8 grid tiles + focus) FROM that
  // canvas rather than directly from the VideoFrame. Some WebKit/Safari
  // WebCodecs builds have inconsistent support for the 9-argument
  // drawImage(source, sx,sy,sw,sh, dx,dy,dw,dh) crop overload specifically
  // when the source is a VideoFrame — observed symptom is exactly "the whole
  // uncropped frame gets forced into every destination box instead of its
  // tile" (reported on real iOS Safari + real footage; this sandbox's
  // browsers can't reproduce it since neither has H.264 decode). Canvas-to-
  // canvas cropped drawImage is one of the oldest, most universally correct
  // Canvas2D code paths, so reading the crop from an intermediate canvas
  // sidesteps the VideoFrame-specific edge case entirely.
  _draw(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    if (!this._offscreen || this._offscreen.width !== w || this._offscreen.height !== h) {
      this._offscreen = document.createElement('canvas');
      this._offscreen.width = w; this._offscreen.height = h;
      this._offscreenCtx = this._offscreen.getContext('2d', { alpha: false });
    }
    this._offscreenCtx.drawImage(frame, 0, 0, w, h); // full-frame blit — no cropping here, universally safe
    drawGridFromSource(this.gridCtx, this._offscreen, w, h, this.muted, this.selected);
    drawFocusFromSource(this.focusCtx, this._offscreen, w, h, this.selected);
  }
}

function tileRect(i, w, h) {
  const tw = w / 4, th = h / 2;
  return [(i % 4) * tw, Math.floor(i / 4) * th, tw, th];
}

function drawGridFromSource(ctx, source, w, h, muted, selected) {
  const S = ctx.canvas.width / 4, Sh = ctx.canvas.height / 2;
  for (let i = 0; i < 8; i++) {
    const [sx, sy, sw, sh] = tileRect(i, w, h);
    const dx = (i % 4) * S, dy = Math.floor(i / 4) * Sh;
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, S, Sh);
    if (muted[i]) { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(dx, dy, S, Sh); }
    ctx.strokeStyle = i === selected ? '#cbe0e6' : 'rgba(203,224,230,0.35)';
    ctx.lineWidth = i === selected ? 4 : 2;
    ctx.strokeRect(dx + 1, dy + 1, S - 2, Sh - 2);
  }
}

function drawFocusFromSource(ctx, source, w, h, selected) {
  const [sx, sy, sw, sh] = tileRect(selected, w, h);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

if (typeof module !== 'undefined') module.exports = { WebCodecsVideoEngine, drawGridFromSource, drawFocusFromSource, tileRect };
