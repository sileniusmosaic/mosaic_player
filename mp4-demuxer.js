// Minimal, dependency-free MP4 (ISO BMFF) demuxer for a single H.264 video track.
// Written specifically for the Mosaic Player WebCodecs rewrite: we always fully
// fetch each video file into memory first (existing architecture), so this demuxer
// only needs to work against a complete in-memory ArrayBuffer — no streaming, no
// partial-box handling, no progressive-download edge cases.
//
// Returns: { codec, codedWidth, codedHeight, description (Uint8Array = raw avcC
// AVCDecoderConfigurationRecord), timescale, samples: [{offset,size,dts,pts,duration,isSync}] }
// Sample byte ranges point directly into the original ArrayBuffer (via a Uint8Array
// view) — the caller slices/copies only when handing bytes to EncodedVideoChunk.

function parseMP4(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const len = arrayBuffer.byteLength;

  function readBoxes(start, end) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(
        bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]
      );
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        const hi = view.getUint32(offset + 8);
        const lo = view.getUint32(offset + 12);
        size = hi * 4294967296 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) break; // malformed/truncated — stop rather than misread
      boxes.push({ type, start: offset, headerSize, size, bodyStart: offset + headerSize, bodyEnd: offset + size });
      offset += size;
    }
    return boxes;
  }
  function find(boxes, type) { return boxes.find(b => b.type === type); }

  const top = readBoxes(0, len);
  const moov = find(top, 'moov');
  if (!moov) throw new Error('MP4 parse error: no moov box found');
  const moovChildren = readBoxes(moov.bodyStart, moov.bodyEnd);
  const traks = moovChildren.filter(b => b.type === 'trak');
  if (!traks.length) throw new Error('MP4 parse error: no trak boxes found');

  let result = null;
  for (const trak of traks) {
    const trakChildren = readBoxes(trak.bodyStart, trak.bodyEnd);
    const mdia = find(trakChildren, 'mdia');
    if (!mdia) continue;
    const mdiaChildren = readBoxes(mdia.bodyStart, mdia.bodyEnd);
    const hdlr = find(mdiaChildren, 'hdlr');
    if (!hdlr) continue;
    const handlerType = String.fromCharCode(
      bytes[hdlr.bodyStart + 8], bytes[hdlr.bodyStart + 9], bytes[hdlr.bodyStart + 10], bytes[hdlr.bodyStart + 11]
    );
    if (handlerType !== 'vide') continue; // we only want the video track

    const mdhd = find(mdiaChildren, 'mdhd');
    const mdhdVersion = bytes[mdhd.bodyStart];
    const timescale = mdhdVersion === 1
      ? view.getUint32(mdhd.bodyStart + 20)
      : view.getUint32(mdhd.bodyStart + 12);

    const minf = find(mdiaChildren, 'minf');
    const minfChildren = readBoxes(minf.bodyStart, minf.bodyEnd);
    const stbl = find(minfChildren, 'stbl');
    const stblChildren = readBoxes(stbl.bodyStart, stbl.bodyEnd);

    // --- edts/elst: edit list. Encoders with B-frames (ours: High Profile) bias every
    // composition time upward by a constant so it never needs a negative ctts offset,
    // then use a single edit-list entry to say "presentation actually starts at
    // media_time, not 0" — i.e. that bias must be subtracted back out, or every frame
    // displays late relative to the audio clock by that constant amount. ---
    let editListBias = 0;
    const edts = find(trakChildren, 'edts');
    if (edts) {
      const edtsChildren = readBoxes(edts.bodyStart, edts.bodyEnd);
      const elst = find(edtsChildren, 'elst');
      if (elst) {
        const elstVersion = bytes[elst.bodyStart];
        const elstCount = view.getUint32(elst.bodyStart + 4);
        if (elstCount >= 1) {
          // First entry only — a single edit segment is what every real-world encoder
          // here produces; media_time is already in this track's own timescale.
          const entryStart = elst.bodyStart + 8;
          editListBias = elstVersion === 1 ? Number(view.getBigInt64(entryStart + 8)) : view.getInt32(entryStart + 4);
        }
      }
    }

    // --- stsd: codec config (avc1 -> avcC) ---
    const stsd = find(stblChildren, 'stsd');
    const stsdEntryStart = stsd.bodyStart + 8; // skip version+flags(4)+entry_count(4)
    const entrySize = view.getUint32(stsdEntryStart);
    const entryType = String.fromCharCode(
      bytes[stsdEntryStart + 4], bytes[stsdEntryStart + 5], bytes[stsdEntryStart + 6], bytes[stsdEntryStart + 7]
    );
    // VisualSampleEntry fixed fields start right after the 8-byte box header.
    const vseBody = stsdEntryStart + 8;
    const codedWidth = view.getUint16(vseBody + 24);
    const codedHeight = view.getUint16(vseBody + 26);
    const childBoxesStart = vseBody + 78; // fixed VisualSampleEntry field block is 78 bytes
    const childBoxesEnd = stsdEntryStart + entrySize;
    const sampleEntryChildren = readBoxes(childBoxesStart, childBoxesEnd);
    let codec, description;
    if (entryType === 'avc1' || entryType === 'avc3') {
      const avcC = find(sampleEntryChildren, 'avcC');
      if (!avcC) throw new Error('MP4 parse error: no avcC box found (not a standard AVC file)');
      description = bytes.slice(avcC.bodyStart, avcC.bodyEnd); // raw AVCDecoderConfigurationRecord
      const profile = description[1], compat = description[2], level = description[3];
      const hex = n => n.toString(16).padStart(2, '0');
      codec = 'avc1.' + hex(profile) + hex(compat) + hex(level);
    } else if (entryType === 'vp09') {
      // Test-harness-only path (this project's real files are H.264/avc1) — used
      // here purely because this sandbox's headless Chromium build lacks H.264
      // decode support, so VP9 stand-in files are what let the render/loop/seek
      // pipeline itself be verified live rather than only on paper.
      const vpcC = find(sampleEntryChildren, 'vpcC');
      if (!vpcC) throw new Error('MP4 parse error: no vpcC box found');
      const profileByte = bytes[vpcC.bodyStart + 4];
      const levelByte = bytes[vpcC.bodyStart + 5];
      const bitDepthByte = bytes[vpcC.bodyStart + 6] >> 4;
      const pad2 = n => String(n).padStart(2, '0');
      codec = 'vp09.' + pad2(profileByte) + '.' + pad2(levelByte) + '.' + pad2(bitDepthByte);
      description = new Uint8Array(0); // VP9 needs no out-of-band description for WebCodecs
    } else {
      throw new Error('Unsupported codec sample entry: ' + entryType + ' (only H.264/avc1 is supported)');
    }

    // --- stts: (sample_count, sample_delta) -> per-sample decode duration, cumulative DTS ---
    const stts = find(stblChildren, 'stts');
    const sttsCount = view.getUint32(stts.bodyStart + 4);
    const sampleDurations = [];
    {
      let p = stts.bodyStart + 8;
      for (let i = 0; i < sttsCount; i++) {
        const count = view.getUint32(p), delta = view.getUint32(p + 4);
        for (let j = 0; j < count; j++) sampleDurations.push(delta);
        p += 8;
      }
    }
    const sampleCountTotal = sampleDurations.length;

    // --- ctts: (sample_count, sample_offset) -> per-sample PTS-DTS offset (optional; B-frames) ---
    const ctts = find(stblChildren, 'ctts');
    const compositionOffsets = new Array(sampleCountTotal).fill(0);
    if (ctts) {
      const cttsVersion = bytes[ctts.bodyStart];
      const cttsCount = view.getUint32(ctts.bodyStart + 4);
      let p = ctts.bodyStart + 8, idx = 0;
      for (let i = 0; i < cttsCount; i++) {
        const count = view.getUint32(p);
        const offset = cttsVersion === 0 ? view.getUint32(p + 4) : view.getInt32(p + 4);
        for (let j = 0; j < count && idx < sampleCountTotal; j++) compositionOffsets[idx++] = offset;
        p += 8;
      }
    }

    // --- stsz: per-sample byte sizes (or one fixed size for all) ---
    const stsz = find(stblChildren, 'stsz');
    const fixedSize = view.getUint32(stsz.bodyStart + 4);
    const stszCount = view.getUint32(stsz.bodyStart + 8);
    const sampleSizes = new Array(stszCount);
    if (fixedSize !== 0) {
      sampleSizes.fill(fixedSize);
    } else {
      let p = stsz.bodyStart + 12;
      for (let i = 0; i < stszCount; i++) { sampleSizes[i] = view.getUint32(p); p += 4; }
    }

    // --- stsc: (first_chunk, samples_per_chunk, sample_desc_index) -> expand to per-chunk sample counts ---
    const stsc = find(stblChildren, 'stsc');
    const stscCount = view.getUint32(stsc.bodyStart + 4);
    const stscEntries = [];
    {
      let p = stsc.bodyStart + 8;
      for (let i = 0; i < stscCount; i++) {
        stscEntries.push({ firstChunk: view.getUint32(p), samplesPerChunk: view.getUint32(p + 4) });
        p += 12;
      }
    }

    // --- stco/co64: chunk file offsets ---
    let stco = find(stblChildren, 'stco');
    let chunkOffsets, use64 = false;
    if (!stco) { stco = find(stblChildren, 'co64'); use64 = true; }
    if (!stco) throw new Error('MP4 parse error: no stco/co64 box found');
    const chunkCount = view.getUint32(stco.bodyStart + 4);
    chunkOffsets = new Array(chunkCount);
    {
      let p = stco.bodyStart + 8;
      for (let i = 0; i < chunkCount; i++) {
        if (use64) { const hi = view.getUint32(p), lo = view.getUint32(p + 4); chunkOffsets[i] = hi * 4294967296 + lo; p += 8; }
        else { chunkOffsets[i] = view.getUint32(p); p += 4; }
      }
    }

    // --- stss: sync sample (keyframe) table (optional — absence means every sample is sync) ---
    const stss = find(stblChildren, 'stss');
    let syncSamples = null; // 1-based sample numbers
    if (stss) {
      const stssCount = view.getUint32(stss.bodyStart + 4);
      syncSamples = new Set();
      let p = stss.bodyStart + 8;
      for (let i = 0; i < stssCount; i++) { syncSamples.add(view.getUint32(p)); p += 4; }
    }

    // --- expand stsc into per-chunk sample counts, then walk chunks assigning sample offsets ---
    const samples = new Array(sampleCountTotal);
    let sampleIdx = 0, dtsAccum = 0;
    for (let chunkIdx = 0; chunkIdx < chunkOffsets.length; chunkIdx++) {
      const chunkNumber1based = chunkIdx + 1;
      let samplesPerChunk = stscEntries[stscEntries.length - 1].samplesPerChunk;
      for (let e = 0; e < stscEntries.length; e++) {
        const cur = stscEntries[e], next = stscEntries[e + 1];
        if (chunkNumber1based >= cur.firstChunk && (!next || chunkNumber1based < next.firstChunk)) {
          samplesPerChunk = cur.samplesPerChunk;
          break;
        }
      }
      let byteOffset = chunkOffsets[chunkIdx];
      for (let s = 0; s < samplesPerChunk; s++) {
        if (sampleIdx >= sampleCountTotal) break;
        const size = sampleSizes[sampleIdx];
        const duration = sampleDurations[sampleIdx];
        const isSync = syncSamples ? syncSamples.has(sampleIdx + 1) : true;
        samples[sampleIdx] = {
          offset: byteOffset,
          size,
          dts: dtsAccum,
          pts: dtsAccum + compositionOffsets[sampleIdx] - editListBias,
          duration,
          isSync
        };
        byteOffset += size;
        dtsAccum += duration;
        sampleIdx++;
      }
    }

    result = { codec, codedWidth, codedHeight, description, timescale, samples, buffer: arrayBuffer };
    break; // first video track found — Mosaic files are single-video-track
  }
  if (!result) throw new Error('MP4 parse error: no video track found');
  return result;
}

if (typeof module !== 'undefined') module.exports = { parseMP4 };
