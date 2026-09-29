# Audio tempo-variant pipeline — how to build 75%/50%(/25%) stems correctly

Written Sep 29 2026, after losing the original working process (it lived only in an
old Claude conversation, never written down, and couldn't be recovered — see
`mosaic-educator-app` memory for the full story). This is the durable answer so
that never happens again. Read this before building tempo audio for any piece.

## 1. Do the time-stretch itself in Logic, not with an external tool

Pitch-correct tempo change belongs inside the DAW, not as a separate command-line
pass on an already-bounced file. Community consensus (Gearspace, Sound on Sound
forums) rates Logic's own elastic-audio algorithm above Pro Tools' Elastic Audio
for this kind of work, so there's no reason to reach for Pro Tools here even
though it's installed.

- **Verified directly on Pat's own Logic Pro (screenshot, Sep 29 2026)** — this
  version's actual Flex Time algorithm list is: Automatic (Polyphonic), Monophonic,
  Slicing, Rhythmic, Polyphonic, Speed (FX), Tempophone (FX). There is no
  "Complex"/"Complex Pro" in this version — that was unverified web research
  (older/different Logic version terminology) and has been replaced with the real
  options below. Don't reintroduce "Complex Pro" into instructions for this rig.
- For a continuous, non-pitched percussive texture like a shaker (as opposed to a
  clean single hit), use **Flex Time – Rhythmic**: Apple's own description of this
  algorithm ("material with a mix of rhythmic and sustained sound, not strongly
  transient-per-hit like a drum loop") matches a shaker's continuous rustle plus
  periodic accents better than Slicing (built for hard-transient drum loops with
  silence between hits — risks chopping/gapping a continuous shake) or
  Monophonic/Polyphonic (pitch-tracking algorithms, wrong for non-pitched
  percussion). **Automatic (Polyphonic)** is Logic's general-purpose default and
  is worth A/B-ing against Rhythmic by ear — Flex lets you switch the algorithm
  and re-audition instantly, so compare both on the actual take before picking.
  Never use **Speed (FX)** or **Tempophone (FX)** — both are labelled FX for a
  reason (varispeed pitch-drop and robotic/granular artifacting respectively),
  not general-purpose quality algorithms.
- Bounce **offline** (File > Export > Selection as Audio File, not real-time Flex
  playback captured live) — offline rendering gets Logic's best-quality pass,
  real-time playback doesn't always use the same quality tier.
- If it still sounds smeared even through Rhythmic, the fallback is a command-line
  re-stretch with Rubber Band's **R3 engine** (`rubberband-r3` / `--fine`) and the
  **`--detector-perc`** flag (percussive transient detector) — this is the
  documented best setting for single-instrument percussive material, and notably
  NOT what earlier Shaker attempts in this project used (they ran plain rubberband
  with no engine/detector specified, i.e. defaults) — worth trying properly once,
  deliberately, if it's ever needed, but Logic's own Flex Time should be tried
  first since it's the process Pat already trusts and controls end to end.

## 2. Loop cleanliness — no fade needed if the export is sample-accurate

A fade/crossfade is a band-aid for an inexact cut, not a requirement. If a loop
already sounds clean in Logic, the only thing that can still break it downstream
is the export not landing on the exact same sample boundary Logic is using.

- Set the Cycle/Loop region to the exact intended loop points.
- Before bouncing, zoom all the way into the waveform at the very first and very
  last sample of the region and confirm both sit at, or essentially at, a
  zero-crossing. This is a 10-second visual check, not processing — it's what
  actually prevents a DC-offset click, independent of how musically clean the
  loop sounds soloed.
- Bounce that exact region to WAV, no normalize, no added silence/tail.
- Do not fade in/out. It's unnecessary once the cut point itself is accurate, and
  a fade that isn't needed just quietly changes the sound of the loop's edges.

## 3. Delivery format — why AAC has been the real risk, and when WAV is worth it

Confirmed from real sources, not assumption (see citations at bottom):

- **AAC has a genuine, well-documented gapless-looping problem.** Encoders pad
  output to whole frames with a variable amount of silent "priming" — FFmpeg's AAC
  encoder adds 1024 samples, Apple's own encoder adds 2112 — and different
  browsers trim that padding differently (or not at all) when decoding. This is a
  real, general issue independent of anything specific to this project.
- It's made worse here specifically: this app's stems are raw ADTS `.aac` (not
  `.m4a`) **because `.m4a`'s edit-list metadata — the mechanism that would tell a
  player exactly where real content starts — broke `decodeAudioData` early in
  this project** (see memory). Raw ADTS has no such metadata at all, so
  `loadBank()`'s truncation is flying blind on exactly where the encoder's padding
  ends, per browser, per decoder. That's the actual mechanism behind "loops fine
  at 100%, glitches at 75/50" — the padding is a fixed number of samples
  regardless of tempo, so it's a proportionally bigger share of a shorter/faster
  loop.
- **WAV (PCM) has none of this.** No frames, no padding, decodes to the exact
  authored sample count on every browser, guaranteed. Confirmed directly in this
  project already (headless Chromium decode test, Sep 2026): WAV landed within 1
  sample of the exact mathematical target length even under a mismatched
  AudioContext sample rate; AAC's equivalent error was ~1024 samples.
- **Opus** is architecturally the best-designed compressed format for exactly
  this (a real "pre-skip" field built for gapless loops) and much smaller than
  WAV — but Safari/iOS's real-world support for decoding it via
  `decodeAudioData` is still inconsistent; `<audio>`-element support only reached
  "full" on `caniuse` as of iOS 18.4, and Web Audio decode support isn't
  guaranteed to match that. Given this app needs to keep working on older/varied
  devices (tested down to Android 9 on a OnePlus 5), Opus isn't safe to switch to
  yet. Worth revisiting in a year or two.

**Practical rule going forward**: bounce WAV from Logic at the exact loop length
(step 2). For a piece with few simultaneous real audio tracks (Shaker/solo pieces,
this new conga piece if it's similarly light), ship that WAV straight to the
browser — the file-size cost is one real track, trivial once cached, and WAV
decode is if anything cheaper on the CPU than AAC decode (closer to a memory copy
than a real decode). For a piece with many simultaneous stems (Flip Swing/Abakuá,
7-8 tracks at once), the same size multiplier across that many files is a
meaningful bandwidth cost — keep those as AAC unless one of them ever reports this
same loop-click bug, in which case the fix is identical: switch that one piece's
stems to WAV.

## Sources
- [Sounds fun — Jake Archibald](https://jakearchibald.com/2016/sounds-fun/) — the core AAC/MP3 priming-sample problem and the gap-detection workaround
- [A brief history of gapless audio — Vimeo Engineering Blog](https://medium.com/vimeo-engineering-blog/a-brief-history-of-gapless-audio-and-what-you-can-do-about-it-ea9e1c343215) — codec-by-codec comparison (AAC/MP3/Vorbis/Opus), FFmpeg vs Apple encoder priming sample counts
- [WebAudio API GitHub discussion #2505](https://github.com/WebAudio/web-audio-api/discussions/2505) — maintainer confirmation that this is inconsistent browser decoder behavior, not a spec-level limitation
- [Rubber Band Library usage/technical docs](https://breakfastquay.com/rubberband/usage.txt) — R3 engine (`--fine`) and `--detector-perc` as the documented best settings for percussive material
- [Opus browser support — caniuse.com](https://caniuse.com/opus) — Safari/iOS Opus support timeline
