// Progressive MP4 loader (Aug 2026) — streams a video URL into memory and
// detects the moov box (container metadata: sample table, codec config) the
// instant it has FULLY arrived, instead of waiting for the whole file.
// Deliberately reuses mp4-demuxer.js's parseMP4() completely unchanged: every
// sample offset it returns is an absolute byte offset into the file, so as
// long as we hand parseMP4() a buffer that reflects exactly what has
// downloaded so far (a truncated prefix, not the eventual full file), it
// either throws (moov not fully in yet — completely normal, not a real
// error) or succeeds with a correct, complete sample table — even though
// most of `mdat` (the actual frame bytes) hasn't downloaded yet.
//
// This only works because every file this project's ffmpeg pipeline produces
// is "faststart" (`-movflags +faststart`): moov comes before mdat, so moov is
// available after only a small fraction of the download (a few KB to a few
// tens of KB, since moov's size scales with sample COUNT, not with video
// content/bitrate or file size). A non-faststart file would still parse
// correctly with this loader — it just wouldn't get the progressive benefit,
// since parseMP4() wouldn't succeed until the whole file (including the moov
// box dumped at the very end) had arrived.
//
// Once `info` (the parseMP4 result) is available, `hasBytes(offset,size)`
// tells the caller whether a given sample's bytes have streamed in yet, so a
// decode pump (see wc-engine.js's loadTempoProgressive()/_pump()) can feed
// samples to a VideoDecoder strictly in order, only ever as far ahead as the
// download has actually reached.
//
// Proven out first as a standalone prototype (correctness-tested in Node
// against real files, byte-by-byte and in varied chunk sizes, then measured
// end-to-end with a real WebCodecs decoder under a throttled connection)
// before being wired into the app itself — see mosaic_webcodecs.html's
// cfg.progressiveVideo and loadVideoForTempoZero() for how it's actually used.

function ensureCapacity(loader, minBytes) {
  if (loader.buffer && loader.buffer.byteLength >= minBytes) return;
  const newSize = Math.max(minBytes, loader.buffer ? loader.buffer.byteLength * 2 : (1 << 20));
  const newBuffer = new ArrayBuffer(newSize);
  if (loader.bytes) new Uint8Array(newBuffer).set(loader.bytes.subarray(0, loader.bytesReceived));
  loader.buffer = newBuffer;
  loader.bytes = new Uint8Array(newBuffer);
  // CRITICAL: if metadata was already parsed against the OLD buffer, its
  // `info.buffer` reference is now a stale, orphaned ArrayBuffer that will
  // never receive another byte — every sample read through it past this point
  // would either throw (out of range) or silently return old/garbage data.
  // Re-point it at the new buffer so it's always the live one. This is only
  // reachable when the server didn't send a usable Content-Length and we had
  // to grow after metadata was already parsed; fetchWithRetry() always passes
  // the real content-length through, so in normal operation capacity is
  // reserved exactly once up front and this never fires.
  if (loader.info) loader.info.buffer = newBuffer;
}

class ProgressiveMP4Loader {
  constructor({ onMetadata, onProgress } = {}) {
    this.onMetadata = onMetadata || (() => {});
    this.onProgress = onProgress || (() => {});
    this.buffer = null;       // full backing ArrayBuffer (grows as bytes arrive)
    this.bytes = null;        // Uint8Array view over `buffer`
    this.bytesReceived = 0;
    this.totalBytes = null;   // from Content-Length, when known
    this.info = null;         // parseMP4() result, set the instant moov is fully in
    this.done = false;
  }

  _tryParseMetadata() {
    if (this.info) return; // already have it — no need to keep re-parsing every chunk
    try {
      // A truncated COPY of exactly what's arrived so far — NOT the live
      // growing buffer. parseMP4()'s box walk must see a buffer whose length
      // genuinely reflects what's downloaded, or a moov box that's only
      // half-arrived could be misread as a complete (but corrupt) one.
      const prefix = this.buffer.slice(0, this.bytesReceived);
      const info = parseMP4(prefix);
      info.buffer = this.buffer; // swap in the REAL growing buffer for sample reads
      this.info = info;
      this.onMetadata(info);
    } catch (e) {
      // Expected/normal until moov has fully arrived — deliberately silent.
    }
  }

  // True once sample bytes [offset, offset+size) have fully streamed in.
  hasBytes(offset, size) { return this.bytesReceived >= offset + size; }

  // Feed one chunk (Uint8Array) as it streams in. Call setTotalBytes() first
  // when the size is known (normal case — every response from this project's
  // R2/Cloudflare setup sends Content-Length) to reserve the whole file in
  // one allocation and avoid ever growing/copying mid-stream.
  setTotalBytes(n) {
    this.totalBytes = n || null;
    if (!this.buffer && this.totalBytes) ensureCapacity(this, this.totalBytes);
  }

  push(chunk) {
    ensureCapacity(this, this.bytesReceived + chunk.length);
    this.bytes.set(chunk, this.bytesReceived);
    this.bytesReceived += chunk.length;
    if (!this.info) this._tryParseMetadata();
    this.onProgress(this.bytesReceived, this.totalBytes);
  }

  finish() {
    this.done = true;
    if (!this.info) this._tryParseMetadata(); // last chance (e.g. a tiny file)
  }
}
