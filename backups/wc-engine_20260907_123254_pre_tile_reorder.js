// WebCodecs video engine for Mosaic Player.
//
// Core idea: decode video frames manually from a fully-fetched MP4 ArrayBuffer,
// and paint BOTH the focus square and the tile grid (shape/count configurable
// per mosaic — see cols/rows/tileCount) from the exact same decoded VideoFrame
// in the same synchronous step. This structurally eliminates
// the old "two independently-timed processes" drift bug (live <video> element vs
// canvas repeatedly snapshotting it) — there is now only one video pipeline,
// sampled once per render step and drawn twice.
//
// The audio engine (Web Audio stems) remains the master clock exactly as before;
// this engine is purely reactive — given "what time is it right now" it produces
// the matching picture. It never advances time itself.

class WebCodecsVideoEngine {
  // cols/rows describe the fixed grid baked into the SOURCE composite video by
  // the ffmpeg build (e.g. 4 columns x 2 rows); tileCount is how many of those
  // cells are actually in use for the current mosaic (a piece with fewer tiles
  // than cols*rows — e.g. 7 — simply leaves the remaining cell(s) blank in the
  // source video and never draws/selects them). Per-mosaic layout is settable
  // after construction via setLayout(), since one player instance now switches
  // between multiple pieces rather than being built for a single fixed grid.
  // gridCanvas draws the whole tileCount grid as one cols x rows composite
  // (mobile layout). gridCanvasLeft/gridCanvasRight are an alternative, mutually
  // exclusive with gridCanvas: each draws one vertical single-column stack of
  // half the tiles (desktop's "tiles flank the focus square" layout) — pass
  // whichever pair matches the layout actually in the DOM; the other stays
  // null and _draw() simply skips it.
  constructor({ gridCanvas, gridCanvasLeft, gridCanvasRight, focusCanvas, onStatus, onError, cols = 4, rows = 2, tileCount = 8, gridColumnMajor = false, gridDestCols }) {
    this.gridCtx = gridCanvas ? gridCanvas.getContext('2d', { alpha: false }) : null;
    this.gridLeftCtx = gridCanvasLeft ? gridCanvasLeft.getContext('2d', { alpha: false }) : null;
    this.gridRightCtx = gridCanvasRight ? gridCanvasRight.getContext('2d', { alpha: false }) : null;
    this.focusCtx = focusCanvas.getContext('2d', { alpha: false });
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    // Desktop-only column-major grid reflow (Sep 2026): tiles read as
    // `gridDestCols` columns filled top-to-bottom, left-to-right, instead of
    // the source's own row-major cols x rows shape. false/undefined (mobile,
    // and every caller before this option existed) reproduces the original
    // row-major destination math in drawGridFromSource() exactly.
    this.gridColumnMajor = gridColumnMajor;
    this.gridDestCols = gridColumnMajor ? (gridDestCols || cols) : cols;
    this.gridDestRows = gridColumnMajor ? Math.ceil((cols * rows) / this.gridDestCols) : rows;
    this.decoder = null;
    this._loader = null;       // set only during a progressive load (loadTempoProgressive()) — see _pump()
    // Bumped at the START of every loadTempo()/loadTempoProgressive() call and
    // captured locally as myGen (Aug 30 2026) — both methods await
    // VideoDecoder.isConfigSupported() before actually installing the new
    // decoder/info/sampleIdx, and a second load starting during that gap (a
    // rapid piece switch, now much more reachable since switching autoplays
    // immediately instead of waiting for a manual Play tap) must not let its
    // OWN completion, arriving out of order, stomp state a newer load already
    // owns. Mirrors mosaic_webcodecs.html's own loadGeneration pattern.
    this._loadGen = 0;
    this.info = null;          // demuxed MP4 info for the current tempo
    this.sampleIdx = 0;        // next sample to feed to the decoder (decode order)
    this.frameQueue = [];      // decoded VideoFrames, in presentation order (by construction)
    this.displayedFrame = null; // the frame currently painted (kept open until replaced)
    this.selected = 0;         // focus tile index 0..tileCount-1
    this.cols = cols; this.rows = rows; this.tileCount = tileCount;
    this.muted = new Array(tileCount).fill(false);
    // Tiles silenced as a SIDE EFFECT of some other tile being soloed (distinct
    // from `muted`, which is only ever true for a tile the user explicitly
    // muted). Drawn as a grey wash rather than the black mute overlay so the
    // two reasons a tile is silent stay visually distinguishable. Owned by the
    // app the same way `muted` is — reassigned by reference whenever solo
    // state changes.
    this.soloDim = new Array(tileCount).fill(false);
    this.cycleSeconds = 0;
    this.decodedFrameCount = 0;
    this.pumpBudgetMs = 6;     // don't let one pump call hog the main thread
    this.maxQueuedFrames = 8;  // decode-ahead buffer depth
    this.destroyed = false;
    this.seeking = false;
    this._resetLapTracking();
  }

  // Switch grid geometry when the app loads a different mosaic. Does NOT touch
  // `muted` — the caller (app) owns that array and reassigns it to match the
  // new tileCount right alongside calling this, same pattern as `engine.muted`
  // already being shared by reference.
  setLayout(cols, rows, tileCount) {
    this.cols = cols; this.rows = rows; this.tileCount = tileCount;
    // Keep the destination shape in sync with any change to the source
    // shape — irrelevant today since every piece shares the same 4x2 source,
    // but keeps a future piece with a different one correct without needing
    // its own special-casing here.
    if (this.gridColumnMajor) this.gridDestRows = Math.ceil((cols * rows) / this.gridDestCols);
    else { this.gridDestCols = cols; this.gridDestRows = rows; }
    if (this.selected >= tileCount) this.selected = 0;
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
    const myGen = ++this._loadGen;
    this._teardownDecoder();
    this._loader = null; // this is the whole-buffer path — make sure a PRIOR progressive load's loader reference doesn't linger and confuse _pump()
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
    // A newer load (loadTempo()/loadTempoProgressive()) may have started and
    // even finished while the await above was in flight — see _loadGen's own
    // comment. Installing a decoder configured for OUR (now-stale) info over
    // that newer load's already-correct state would desync this.info from
    // whatever decoder actually ends up running. Just stop; the newer load
    // owns the engine now.
    if (this._loadGen !== myGen) return;
    this.decoder = new VideoDecoder({
      output: (frame) => this._onFrame(frame),
      error: (e) => { console.error('VideoDecoder error:', e); this.onStatus('Video decode error: ' + e.message, 'error'); this.onError(e); }
    });
    this._config = config;
    this.decoder.configure(config);
    this._everPumped = false; // nothing fed to this decoder instance yet — seekTo() can skip reset()
  }

  // Progressive sibling of loadTempo() (Aug 2026) — configures the decoder
  // from metadata ALONE (already available the instant the loader's moov box
  // has streamed in — see progressive-loader.js) and starts the decode-ahead
  // pump immediately, WITHOUT waiting for the rest of the file (mdat) to
  // download. `_pump()` below becomes byte-availability-aware whenever
  // `this._loader` is set: it feeds whatever samples have actually arrived
  // and stops cleanly (not an error — just "nothing to do yet") at the first
  // one that hasn't, resuming on the next call once more bytes are in.
  //
  // Currently only ever called for a fresh, position-0 load (initial page
  // load, switching between pieces) — see mosaic_webcodecs.html's
  // cfg.progressiveVideo/loadVideoForTempoZero() for why a live mid-playback
  // tempo switch deliberately still uses the original whole-buffer loadTempo()
  // instead: seeking into a spot the download hasn't reached yet needs real
  // HTTP Range support, which this first pass doesn't add.
  async loadTempoProgressive(loader) {
    const myGen = ++this._loadGen;
    this._teardownDecoder();
    const info = loader.info;
    if (!info) throw new Error('loadTempoProgressive() requires loader.info to already be set (metadata not ready yet)');
    this.info = info;
    this._loader = loader;
    this.cycleSeconds = info.samples.reduce((a, s) => a + s.duration, 0) / info.timescale;
    this.sampleIdx = 0;
    this._clearQueue();
    this._resetLapTracking();
    const config = { codec: info.codec, codedWidth: info.codedWidth, codedHeight: info.codedHeight };
    if (info.description && info.description.length) config.description = info.description;
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error('VideoDecoder does not support this stream: ' + info.codec);
    // See loadTempo()'s identical check — a newer load may have already taken
    // over the engine while this awaited. This one matters even more here:
    // switching pieces now autoplays immediately (Aug 30 2026), so a second
    // switch landing while the first's decoder is still spinning up is a real,
    // reachable case now, not just a theoretical one.
    if (this._loadGen !== myGen) return;
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
    this._loader = null;
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
    // Progressive mode (this._loader set, see loadTempoProgressive() above)
    // reads from the loader's own live, still-growing buffer instead of
    // info.buffer, and — critically — must never read a sample whose bytes
    // haven't actually streamed in yet. Whole-buffer mode (the original,
    // unchanged path) has no loader and behaves exactly as before.
    const buf = this._loader ? this._loader.buffer : this.info.buffer;
    while (
      this.decoder.decodeQueueSize < this.maxQueuedFrames &&
      this.frameQueue.length < this.maxQueuedFrames &&
      performance.now() - t0 < this.pumpBudgetMs
    ) {
      const s = samples[this.sampleIdx];
      // Defensive (Aug 30 2026): `this.sampleIdx` and `this.info` are always
      // reassigned together, synchronously, by loadTempo()/loadTempoProgressive()
      // — in the normal case `s` can never be undefined. It's cheap insurance
      // against any future path that manages to observe them a half-step out
      // of sync (e.g. this.info swapped to a piece with fewer samples by a
      // fast follow-up switch) — treated the same as "not downloaded yet":
      // stop cleanly rather than crash, the next tick tries again.
      if (!s) break;
      if (this._loader && !this._loader.hasBytes(s.offset, s.size)) break; // not downloaded yet — stop cleanly, not an error; the next render()/paintAt() tick tries again
      const data = new Uint8Array(buf, s.offset, s.size);
      const chunk = new EncodedVideoChunk({
        type: s.isSync ? 'key' : 'delta',
        timestamp: Math.round((s.pts / this.info.timescale) * 1e6), // microseconds
        duration: Math.round((s.duration / this.info.timescale) * 1e6),
        data
      });
      try { this.decoder.decode(chunk); this._everPumped = true; } catch (e) { console.error('decode() threw', e); break; }
      this.sampleIdx++;
      if (this.sampleIdx >= samples.length) {
        // Don't loop back to sample 0 until the WHOLE file has actually
        // arrived — reaching here at all already implies every sample's
        // bytes were available (offsets only increase), so in practice this
        // guard is a pure safety net, never load-bearing.
        if (this._loader && !this._loader.done) break;
        this.sampleIdx = 0; // loop: sample 0 is always sync
      }
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
    if (this.gridCtx) {
      drawGridFromSource(this.gridCtx, this._offscreen, w, h, this.muted, this.selected, this.cols, this.rows, this.tileCount, this.soloDim, this.gridDestCols, this.gridDestRows, this.gridColumnMajor);
    }
    if (this.gridLeftCtx || this.gridRightCtx) {
      // Split layout: first half of the flat tile index list (reading order —
      // e.g. tiles 1-4 of 8) stacks in the left column, the rest in the right
      // column. A piece with an odd/short tileCount (e.g. 7) just leaves the
      // column's last cell blank, same as the single-grid layout already does.
      const half = Math.ceil((this.cols * this.rows) / 2);
      const leftIdx = [], rightIdx = [];
      for (let i = 0; i < this.tileCount; i++) (i < half ? leftIdx : rightIdx).push(i);
      if (this.gridLeftCtx) drawTileColumn(this.gridLeftCtx, this._offscreen, w, h, leftIdx, this.muted, this.selected, this.cols, this.rows, this.soloDim, half);
      if (this.gridRightCtx) drawTileColumn(this.gridRightCtx, this._offscreen, w, h, rightIdx, this.muted, this.selected, this.cols, this.rows, this.soloDim, half);
    }
    drawFocusFromSource(this.focusCtx, this._offscreen, w, h, this.selected, this.cols, this.rows);
  }
}

// cols/rows = the fixed grid shape baked into the source composite (e.g. 4x2).
function tileRect(i, w, h, cols = 4, rows = 2) {
  const tw = w / cols, th = h / rows;
  return [(i % cols) * tw, Math.floor(i / cols) * th, tw, th];
}

// tileCount = how many of cols*rows cells are actually populated for this
// mosaic (a piece with fewer tiles than cols*rows just never draws/selects
// the remaining cell(s), which are left blank in the source video itself).
// destCols/destRows describe the DESTINATION grid shape on screen — defaults
// to cols/rows (mobile: destination shape matches the source's own shape,
// row-major). Desktop passes a narrower destCols (e.g. 2) and columnMajor
// true, filling each destination column top-to-bottom before moving to the
// next, while `tileRect` above still always crops from the tile's real
// position in the SOURCE composite (cols/rows), which never changes.
function drawGridFromSource(ctx, source, w, h, muted, selected, cols = 4, rows = 2, tileCount = cols * rows, soloDim, destCols = cols, destRows = rows, columnMajor = false) {
  const S = ctx.canvas.width / destCols, Sh = ctx.canvas.height / destRows;
  for (let i = 0; i < tileCount; i++) {
    const [sx, sy, sw, sh] = tileRect(i, w, h, cols, rows);
    const dx = columnMajor ? Math.floor(i / destRows) * S : (i % destCols) * S;
    const dy = columnMajor ? (i % destRows) * Sh : Math.floor(i / destCols) * Sh;
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, S, Sh);
    // Explicit mute always wins the visual (black); a tile silenced only
    // because something ELSE is soloed gets the lighter grey "dimmed" wash.
    if (muted[i]) { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(dx, dy, S, Sh); }
    else if (soloDim && soloDim[i]) { ctx.fillStyle = 'rgba(130,130,130,.55)'; ctx.fillRect(dx, dy, S, Sh); }
    ctx.strokeStyle = i === selected ? '#cbe0e6' : 'rgba(203,224,230,0.35)';
    ctx.lineWidth = i === selected ? 4 : 2;
    ctx.strokeRect(dx + 1, dy + 1, S - 2, Sh - 2);
  }
}

// Desktop split layout: draws `indices` (already the subset destined for this
// particular column, in top-to-bottom order) as a single vertical stack of
// `slots` cells — the canvas itself is expected to be sized for exactly that
// many cells (see the CSS aspect-ratio on .grid-stage-side). Cropping still
// reads each tile from its ORIGINAL position in the source composite via
// tileRect(i, ...) — only the destination placement changes from "2D grid
// cell" to "n-th cell in this column".
function drawTileColumn(ctx, source, w, h, indices, muted, selected, cols, rows, soloDim, slots) {
  const S = ctx.canvas.width, Sh = ctx.canvas.height / slots;
  indices.forEach((i, n) => {
    const [sx, sy, sw, sh] = tileRect(i, w, h, cols, rows);
    const dx = 0, dy = n * Sh;
    ctx.drawImage(source, sx, sy, sw, sh, dx, dy, S, Sh);
    if (muted[i]) { ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(dx, dy, S, Sh); }
    else if (soloDim && soloDim[i]) { ctx.fillStyle = 'rgba(130,130,130,.55)'; ctx.fillRect(dx, dy, S, Sh); }
    ctx.strokeStyle = i === selected ? '#cbe0e6' : 'rgba(203,224,230,0.35)';
    ctx.lineWidth = i === selected ? 4 : 2;
    ctx.strokeRect(dx + 1, dy + 1, S - 2, Sh - 2);
  });
}

function drawFocusFromSource(ctx, source, w, h, selected, cols = 4, rows = 2) {
  const [sx, sy, sw, sh] = tileRect(selected, w, h, cols, rows);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

if (typeof module !== 'undefined') module.exports = { WebCodecsVideoEngine, drawGridFromSource, drawFocusFromSource, tileRect };
