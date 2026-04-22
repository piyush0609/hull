#!/bin/sh
# toss installer — prefers source install (88KB) when Node.js is available.
# Falls back to 57MB standalone binary only if Node.js is missing.
# Usage: curl -fsSL https://raw.githubusercontent.com/piyush0609/hull/main/install.sh | sh

set -e

REPO="piyush0609/hull"
VERSION="${VERSION:-main}"
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

EXT=""
[ "$OS" = "windows" ] && EXT=".exe"

echo "Installing toss..."

# Prefer source install when Node.js is available — much smaller than binary
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    echo "Node.js $(node -v) found. Installing from source (fast, ~100KB)..."

    SRC_DIR="${HOME}/.toss/src"
    rm -rf "$SRC_DIR"
    mkdir -p "$SRC_DIR"

    # Download source tarball
    TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$TARBALL_URL" | tar -xz -C "$SRC_DIR" --strip-components=1
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "$TARBALL_URL" | tar -xz -C "$SRC_DIR" --strip-components=1
    else
      echo "curl or wget required."
      exit 1
    fi

    # Install dependencies and build
    echo "Installing dependencies..."
    cd "$SRC_DIR"
    npm install --silent

    echo "Building..."
    npm run build --silent

    # Install wrapper script
    BIN_DIR="${HOME}/.local/bin"
    mkdir -p "$BIN_DIR"

    cat > "$BIN_DIR/toss" << 'EOF'
#!/bin/sh
exec node "${HOME}/.toss/src/dist/index.js" "$@"
EOF
    chmod +x "$BIN_DIR/toss"

    # Add to PATH if needed
    SHELL_NAME=$(basename "${SHELL:-/bin/sh}")
    case "$SHELL_NAME" in
      bash)  PROFILE="$HOME/.bashrc" ;;
      zsh)   PROFILE="$HOME/.zshrc" ;;
      fish)  PROFILE="$HOME/.config/fish/config.fish" ;;
      *)     PROFILE="$HOME/.profile" ;;
    esac

    if [ -f "$PROFILE" ] && ! grep -q "$BIN_DIR" "$PROFILE" 2>/dev/null; then
      echo "" >> "$PROFILE"
      echo "# Added by toss installer" >> "$PROFILE"
      echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$PROFILE"
      echo "✅ Added $BIN_DIR to PATH in $PROFILE"
      echo "   Restart your terminal or run: source $PROFILE"
    fi

    echo ""
    echo "✅ toss installed from source (~100KB download)"
    echo "   toss doctor    # Check prerequisites"
    echo "   toss deploy    # Deploy your toss"
    exit 0
  fi
fi

# Fallback: standalone binary (57MB, no Node.js required)
echo "Node.js 18+ not found. Downloading standalone binary (~57MB)..."

if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO-"
else
  echo "curl or wget required."
  exit 1
fi

LATEST_URL="https://api.github.com/repos/$REPO/releases/latest"
VERSION=$($FETCH "$LATEST_URL" 2>/dev/null | grep '"tag_name":' | head -1 | sed -E 's/.*"v?([^"]+)".*/\1/')

if [ -n "$VERSION" ]; then
  BINARY="toss-${VERSION}-${OS}-${ARCH}${EXT}"
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/v$VERSION/$BINARY"

  echo "Downloading toss v$VERSION..."
  if $FETCH "$DOWNLOAD_URL" > "/tmp/toss${EXT}" 2>/dev/null; then
    chmod +x "/tmp/toss${EXT}"

    if mv "/tmp/toss${EXT}" "$INSTALL_DIR/toss" 2>/dev/null; then
      echo "✅ toss installed to $INSTALL_DIR/toss"
    else
      USER_BIN="$HOME/.local/bin"
      mkdir -p "$USER_BIN"
      mv "/tmp/toss${EXT}" "$USER_BIN/toss"
      echo "✅ toss installed to $USER_BIN/toss"

      SHELL_NAME=$(basename "${SHELL:-/bin/sh}")
      case "$SHELL_NAME" in
        bash)  PROFILE="$HOME/.bashrc" ;;
        zsh)   PROFILE="$HOME/.zshrc" ;;
        fish)  PROFILE="$HOME/.config/fish/config.fish" ;;
        *)     PROFILE="$HOME/.profile" ;;
      esac

      if [ -f "$PROFILE" ] && ! grep -q "$USER_BIN" "$PROFILE" 2>/dev/null; then
        echo "" >> "$PROFILE"
        echo "# Added by toss installer" >> "$PROFILE"
        echo "export PATH=\"$USER_BIN:\$PATH\"" >> "$PROFILE"
        echo "✅ Added $USER_BIN to PATH in $PROFILE"
        echo "   Restart your terminal or run: source $PROFILE"
      fi
    fi

    echo ""
    echo "Next steps:"
    echo "  toss doctor    # Check prerequisites"
    echo "  toss deploy    # Deploy your toss"
    exit 0
  fi
fi

echo "Install failed. Binary download and source install both unavailable."
echo "Please install Node.js 18+ and try again: https://nodejs.org"
exit 1
