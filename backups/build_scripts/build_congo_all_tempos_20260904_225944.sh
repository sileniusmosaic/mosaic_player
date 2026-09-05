#!/bin/bash
set -e
cd "$(dirname "$0")"

build_tempo () {
  PCT="$1"; SETPTS="$2"
  echo "=== Building congo_yambumba ${PCT}% ==="
  ffmpeg -y \
   -i "01 clave.mov" -i "02 cata.mov" -i "03 erikundi.mov" -i "04 quinto.mov" \
   -i "05 conga.mov" -i "06 tumba.mov" -i "07 coro 1.mov" -i "08 coro 2.mov" \
   -filter_complex "\
[0:v]scale=480:480${SETPTS},fps=30[clave];\
[1:v]scale=480:480${SETPTS},fps=30[cata];\
[2:v]scale=480:480${SETPTS},fps=30[erikundi];\
[3:v]scale=480:480${SETPTS},fps=30[quinto];\
[4:v]scale=480:480${SETPTS},fps=30[conga];\
[5:v]scale=480:480${SETPTS},fps=30[tumba];\
[6:v]scale=480:480${SETPTS},fps=30[coro1];\
[7:v]scale=480:480${SETPTS},fps=30[coro2];\
[clave][cata][erikundi][quinto]hstack=inputs=4[toprow];\
[conga][tumba][coro1][coro2]hstack=inputs=4[botrow];\
[toprow][botrow]vstack=inputs=2[outv]" \
   -map "[outv]" -an -c:v libx264 -crf 23 -preset medium -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart \
   -metadata title="Congo Yambumba" -metadata comment="Mosaic Player ${PCT}% tempo, 30fps, CRF23, 1s keyframes" \
   "video_output/congo_yambumba_4x2_1920x960_${PCT}.mp4"
  echo "Done: congo_yambumba_4x2_1920x960_${PCT}.mp4"
}

build_tempo 100 ""
build_tempo 75 ",setpts=PTS/0.75"
build_tempo 50 ",setpts=PTS/0.5"

echo "=== ALL CONGO BUILDS DONE ==="
for f in video_output/congo_yambumba_4x2_1920x960_*.mp4; do
  ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,r_frame_rate -of default=noprint_wrappers=0 "$f"
  echo "---"
done
