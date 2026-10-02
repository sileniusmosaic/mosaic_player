#!/usr/bin/env bash
# rename_afrobeat_stems.sh
#
# Takes a folder of output from Logic Pro's File > Export > All Tracks as
# Audio Files (run once per tempo pass) and copies/renames those files into
# Mosaic/Afrobeat/ under this app's required stem convention:
#   NN_instrument_afrobeat.wav        (100%, no suffix)
#   NN_instrument_afrobeat_75.wav     (75%)
#   NN_instrument_afrobeat_50.wav     (50%)
# matching tempoUrls() in mosaic_webcodecs.html, which inserts "_<percent>"
# right before the extension and leaves 100% bare.
#
# Matches loosely by instrument keyword (case-insensitive substring), so it
# doesn't matter exactly what Logic's own Pattern field named the file --
# "Tumba.wav", "Tumba_afrobeat.wav", "01 Tumba.wav" etc. all match "tumba".
#
# Usage:
#   tools/rename_afrobeat_stems.sh <logic_export_folder> <100|75|50>
#
# Run once per tempo, after each Logic export pass, e.g.:
#   tools/rename_afrobeat_stems.sh ~/Desktop/afrobeat_100 100
#   tools/rename_afrobeat_stems.sh ~/Desktop/afrobeat_75  75
#   tools/rename_afrobeat_stems.sh ~/Desktop/afrobeat_50  50
#
# Instrument order/index below matches MOSAICS.afrobeat.names in
# mosaic_webcodecs.html (Tumba/Conga/Quinto) plus the four new instruments
# in the order Pat listed them (Clave, Shekere, Agogo, Bell) -- if that
# order or the stemFiles array ever changes, update the MAP line to match.

set -euo pipefail

SRC="${1:?Usage: $0 <logic_export_folder> <100|75|50>}"
TEMPO="${2:?Usage: $0 <logic_export_folder> <100|75|50>}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Mosaic/Afrobeat"

case "$TEMPO" in
  100) SUFFIX="" ;;
  75)  SUFFIX="_75" ;;
  50)  SUFFIX="_50" ;;
  *) echo "tempo must be 100, 75, or 50" >&2; exit 1 ;;
esac

MAP="01:tumba 02:conga 03:quinto 04:clave 05:shekere 06:agogo 07:bell"

mkdir -p "$DEST"
shopt -s nocaseglob nullglob

for pair in $MAP; do
  idx="${pair%%:*}"
  name="${pair##*:}"
  matches=("$SRC"/*"$name"*)
  if [ "${#matches[@]}" -eq 0 ]; then
    echo "WARNING: no file found for '$name' in $SRC -- skipped" >&2
    continue
  fi
  if [ "${#matches[@]}" -gt 1 ]; then
    echo "ERROR: multiple files matched '$name' in $SRC:" >&2
    printf '  %s\n' "${matches[@]}" >&2
    exit 1
  fi
  src_file="${matches[0]}"
  ext="${src_file##*.}"
  out="$DEST/${idx}_${name}_afrobeat${SUFFIX}.${ext}"
  cp -v "$src_file" "$out"
done

shopt -u nocaseglob nullglob
echo "Done. Files placed in $DEST"
