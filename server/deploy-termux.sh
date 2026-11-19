#!/data/data/com.termux/files/usr/bin/bash
# Together server updater for Termux.
# Fetches code from GitHub without changing your repo checkout, copies ONLY code
# into ~/together, preserves turn.txt/media/uploads, installs locked deps, restarts.
# Override the ref with: TOGETHER_REF=branch-name bash deploy-termux.sh
set -euo pipefail
REPO="$HOME/together-app"
APP="$HOME/together"
REPO_URL="https://github.com/kkchetan3-web/together-app.git"
REF="${TOGETHER_REF:-main}"

echo "==> Fetching Together code from ${REF}..."
if [ ! -e "$REPO" ]; then git clone "$REPO_URL" "$REPO"; fi
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null
git -C "$REPO" fetch origin "$REF"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git -C "$REPO" archive --format=tar FETCH_HEAD server | tar -xf - -C "$STAGE"
SRC="$STAGE/server"
[ -f "$SRC/server.js" ] || { echo "ERROR: server code not found."; exit 1; }

echo "==> Backing up current code..."
BK="$APP/.backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK" "$APP/public" "$APP/lib"
for item in server.js package.json package-lock.json lib public start.sh; do
  if [ -e "$APP/$item" ]; then cp -a "$APP/$item" "$BK/"; fi
done

echo "==> Copying new code (preserving turn.txt, media, uploads)..."
cp "$SRC/server.js" "$APP/server.js"
cp "$SRC/lib/convert.js" "$APP/lib/convert.js"
cp "$SRC/public/index.html" "$APP/public/index.html"
cp "$SRC/public/lavender.css" "$APP/public/lavender.css"
cp "$SRC/package.json" "$APP/package.json"
cp "$SRC/package-lock.json" "$APP/package-lock.json"
cp "$SRC/start.sh" "$APP/start.sh"
chmod +x "$APP/start.sh"

if [ -f "$APP/turn.txt" ]; then
  node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!Array.isArray(a))throw new Error("turn.txt must be a JSON array");console.log("turn.txt preserved; JSON valid.");' "$APP/turn.txt"
else
  echo "WARNING: ~/together/turn.txt is missing. Cross-network calls may fail."
fi

echo "==> Installing locked Node dependencies..."
cd "$APP"
npm ci --omit=dev --no-audit --no-fund
node --check server.js
node --check lib/convert.js

echo "==> Restarting local-first Together server..."
echo "Backup: $BK"
exec bash "$APP/start.sh"
