#!/bin/sh
# Render the app icon SVGs: 512px runtime icons (app_icon.rs), 96px previews
# for the Settings picker, .ico files for Windows, and the installed icon set
# from color-light.svg.
# Needs rsvg-convert (librsvg). Run from anywhere.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../../.." && pwd)
mkdir -p "$root/dist/app-icons"
for svg in "$here"/*.svg; do
  name=$(basename "$svg" .svg)
  rsvg-convert -w 512 -h 512 "$svg" -o "$here/$name.png"
  rsvg-convert -w 96 -h 96 "$svg" -o "$root/dist/app-icons/$name.png"
done
source=$(mktemp -t chatpane-icon-XXXXXX.png)
set=$(mktemp -d -t chatpane-icon-set-XXXXXX)
trap 'rm -rf "$source" "$set"' EXIT
# Windows shows a chosen icon through its shortcuts, which take .ico files
# (windows/taskbar_icon.rs). color-light is the installed icon.
for name in color-dark mono-light mono-dark; do
  rsvg-convert -w 1024 -h 1024 "$here/$name.svg" -o "$source"
  (cd "$root" && bun run icon "$source" -o "$set")
  cp "$set/icon.ico" "$here/$name.ico"
done
rsvg-convert -w 1024 -h 1024 "$here/color-light.svg" -o "$source"
(cd "$root" && bun run icon "$source")
