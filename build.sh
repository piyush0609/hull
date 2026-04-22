#!/bin/bash
# Build standalone binaries for all platforms using bun
# Usage: ./build.sh [version]

set -e

VERSION=${1:-$(node -p "require('./package.json').version")}
OUTDIR="./dist-bin"
mkdir -p "$OUTDIR"

echo "Building toss v$VERSION..."

build() {
  local target=$1
  local outfile=$2
  echo "  → $target"
  bun build --compile src/index.ts --target=$target --outfile "$OUTDIR/$outfile" 2>&1 | tail -1
}

build bun-darwin-arm64 "toss-$VERSION-darwin-arm64"
build bun-darwin-x64   "toss-$VERSION-darwin-x64"
build bun-linux-x64    "toss-$VERSION-linux-x64"
build bun-linux-arm64  "toss-$VERSION-linux-arm64"
build bun-windows-x64  "toss-$VERSION-windows-x64.exe"

echo ""
echo "Done. Binaries in $OUTDIR:"
ls -la "$OUTDIR"

echo ""
echo "Next: upload to GitHub Releases and update install.sh"
