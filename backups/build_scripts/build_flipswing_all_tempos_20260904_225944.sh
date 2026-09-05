#!/bin/bash
set -e
cd "$(dirname "$0")"

build_tempo () {
  PCT="$1"; SETPTS="$2"
  echo "=== Building flip_swing ${PCT}% ==="
  ffmpeg -y \
   -i "bass flip swing.mov" -i "coro 1 flip swing.mov" -i "coro 2 flip swing.mov" -i "repenique flip swing.mov" \
   -i "guitar 1 flip swing.mov" -i "guitar 2 flip swing.mov" -i "kit flip swing.mov" -i "agogo flip swing.mov" \
   -filter_complex "\
[0:v]scale=480:480${SETPTS},fps=30[bass];\
[1:v]scale=480:480${SETPTS},fps=30[coro1];\
[2:v]scale=480:480${SETPTS},fps=30[coro2];\
[3:v]scale=480:480${SETPTS},fps=30[repenique];\
[4:v]scale=480:480${SETPTS},fps=30[guitar1];\
[5:v]scale=480:480${SETPTS},fps=30[guitar2];\
[6:v]scale=480:480${SETPTS},fps=30[kit];\
[7:v]scale=480:480${SETPTS},fps=30[agogo];\
[bass][coro1][coro2][repenique]hstack=inputs=4:shortest=1[toprow];\
[guitar1][guitar2][kit][agogo]hstack=inputs=4:shortest=1[botrow];\
[toprow][botrow]vstack=inputs=2:shortest=1[outv]" \
   -map "[outv]" -an -c:v libx264 -crf 23 -preset medium -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart -shortest \
   -metadata title="Flip Swing" -metadata comment="Mosaic Player ${PCT}% tempo, 30fps, CRF23, 1s keyframes" \
   "video_output/flip_swing_4x2_1920x960_${PCT}.mp4"
  echo "Done: flip_swing_4x2_1920x960_${PCT}.mp4"
}

build_tempo 100 ""
build_tempo 75 ",setpts=PTS/0.75"
build_tempo 50 ",setpts=PTS/0.5"

echo "=== ALL FLIP SWING BUILDS DONE ==="
for f in video_output/flip_swing_4x2_1920x960_*.mp4; do
  ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,r_frame_rate -of default=noprint_wrappers=0 "$f"
  echo "---"
done
