#!/bin/sh
# Download yt-dlp standalone Linux binary for Vercel serverless functions
# Uses yt-dlp_linux (PyInstaller bundle) — no Python dependency needed at runtime

set -e

if [ "$(uname)" = "Linux" ]; then
  echo "Downloading yt-dlp standalone binary for Linux..."
  mkdir -p bin
  curl -L --retry 3 --max-time 120 \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" \
    -o bin/yt-dlp
  chmod +x bin/yt-dlp
  ls -lh bin/yt-dlp
  echo "yt-dlp installed: $(bin/yt-dlp --version)"
else
  echo "Skipping yt-dlp download (not Linux)"
fi
