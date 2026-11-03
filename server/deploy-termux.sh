#!/data/data/com.termux/files/usr/bin/bash
# Together server updater for Termux.
# Pulls the latest code from GitHub, copies ONLY code into ~/together
# (your turn.txt, media/, uploads/ and node_modules/ are preserved), then restarts.
set -e
REPO="$HOME/together-app"
APP="$HOME/together"

echo "⬇️  Pulling latest code..."
cd "$REPO"
git pull --ff-only origin main

echo "🗂  Backing up current code..."
BK="$APP/.backup-$(date +%s)"
mkdir -p "$BK"
cp "$APP/public/index.html" "$BK/" 2>/dev/null || true
cp "$APP/server.js" "$BK/" 2>/dev/null || true
cp "$APP/start.sh" "$BK/" 2>/dev/null || true

echo "📋 Copying new code (keeping your TURN config, media and uploads)..."
mkdir -p "$APP/public" "$APP/lib"
cp "$REPO/server/public/index.html" "$APP/public/index.html"
cp "$REPO/server/public/lavender.css" "$APP/public/lavender.css"
cp "$REPO/server/server.js" "$APP/server.js"
cp "$REPO/server/lib/convert.js" "$APP/lib/convert.js"
cp "$REPO/server/start.sh" "$APP/start.sh"
chmod +x "$APP/start.sh"

cd "$APP"
[ -d node_modules ] || npm install --omit=dev

echo "🚀 Restarting Together..."
exec bash "$APP/start.sh"
