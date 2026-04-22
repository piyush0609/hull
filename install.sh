#!/bin/sh
# hull installer — downloads prebuilt binary from GitHub Releases
# Fallback: installs via npm if binary download fails
# Usage: curl -fsSL https://raw.githubusercontent.com/piyush0609/hull/main/install.sh | sh

set -e

REPO="piyush0609/hull"
NPM_PKG="hull-cli"
MIN_NODE=18
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  linux)   OS="linux" ;;
  darwin)  OS="darwin" ;;
  mingw*|msys*|cygwin*) OS="windows" ;;
  *)       echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Windows uses .exe
EXT=""
[ "$OS" = "windows" ] && EXT=".exe"

echo "Installing hull for $OS-$ARCH..."

# Try GitHub Releases binary first
if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO-"
else
  echo "curl or wget required."
  exit 1
fi

# Get latest version from GitHub API
LATEST_URL="https://api.github.com/repos/$REPO/releases/latest"
VERSION=$($FETCH "$LATEST_URL" 2>/dev/null | grep '"tag_name":' | head -1 | sed -E 's/.*"v?([^"]+)".*/\1/')

if [ -n "$VERSION" ]; then
  BINARY="hull-$VERSION-$OS-$ARCH$EXT"
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/v$VERSION/$BINARY"

  echo "Downloading hull v$VERSION..."
  if $FETCH "$DOWNLOAD_URL" > "/tmp/hull$EXT" 2>/dev/null; then
    chmod +x "/tmp/hull$EXT"

    # Try system install, fallback to user local
    if mv "/tmp/hull$EXT" "$INSTALL_DIR/hull" 2>/dev/null; then
      echo "✅ hull installed to $INSTALL_DIR/hull"
    else
      USER_BIN="$HOME/.local/bin"
      mkdir -p "$USER_BIN"
      mv "/tmp/hull$EXT" "$USER_BIN/hull"
      echo "✅ hull installed to $USER_BIN/hull"
      echo "   Add to PATH: export PATH=\"$USER_BIN:\$PATH\""
    fi

    echo ""
    echo "Next steps:"
    echo "  hull doctor    # Check prerequisites"
    echo "  hull deploy    # Deploy your hull"
    exit 0
  fi
fi

# Fallback: npm install
echo "Binary download failed. Falling back to npm..."

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js $MIN_NODE+ required for npm install."
  echo "Install from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
  echo "Error: Node.js $MIN_NODE+ required. Found: $(node -v)"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm required."
  exit 1
fi

npm install -g "$NPM_PKG"

echo ""
echo "✅ hull installed via npm"
echo "  hull doctor    # Check prerequisites"
echo "  hull deploy    # Deploy your hull"
