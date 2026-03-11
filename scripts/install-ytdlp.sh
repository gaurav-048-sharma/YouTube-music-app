#!/bin/sh
# Download yt-dlp Linux binary for Vercel serverless functions
# Only runs on Linux (Vercel build environment)

set -e

if [ "$(uname)" = "Linux" ]; then
  echo "Downloading yt-dlp for Linux..."
  mkdir -p bin
  curl -L --retry 3 --max-time 60 \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
    -o bin/yt-dlp
  chmod +x bin/yt-dlp
  echo "yt-dlp installed: $(bin/yt-dlp --version)"
else
  echo "Skipping yt-dlp download (not Linux)"
fi
