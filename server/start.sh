#!/data/data/com.termux/files/usr/bin/bash
# Together local-first starter. The website on localhost:3000 stays up even
# if cloudflared is missing or the public tunnel cannot be created.
set -u
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"
PORT="${PORT:-3000}"

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

stop_pid_file() {
  if [ -f "$1" ]; then
    kill "$(cat "$1")" 2>/dev/null || true
    rm -f "$1"
  fi
}
stop_pid_file server.pid
stop_pid_file tunnel.pid
# Fallback for older starts that did not write PID files.
pkill -f "node server.js" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1
rm -f link.txt tunnel.log

NODE_PID=""
TUNNEL_PID=""
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
  rm -f server.pid tunnel.pid
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

health_ok() {
  node -e "fetch('http://127.0.0.1:${PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

echo "Starting Together website on port ${PORT}..."
node server.js > server.log 2>&1 &
NODE_PID=$!
echo "$NODE_PID" > server.pid

READY=0
for i in $(seq 1 20); do
  if health_ok; then READY=1; break; fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then break; fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "ERROR: Together website did not start. Last server log:"
  cat server.log 2>/dev/null || true
  exit 1
fi

echo ""
echo "==========================================="
echo " LOCAL WEBSITE READY:"
echo "   http://localhost:${PORT}"
echo "   http://127.0.0.1:${PORT}"
echo "==========================================="

if command -v cloudflared >/dev/null 2>&1; then
  # http2 (TCP 443) is more reliable than QUIC on mobile/hotspot networks.
  cloudflared tunnel --protocol http2 --url "http://localhost:${PORT}" > tunnel.log 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > tunnel.pid
  echo "Starting public link, please wait..."
  LINK=""
  for i in $(seq 1 45); do
    LINK=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log 2>/dev/null | head -1)
    [ -n "$LINK" ] && break
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if [ -n "$LINK" ]; then
    echo "$LINK" > link.txt
    echo ""
    echo "PUBLIC LINK:"
    echo "   $LINK"
  else
    echo ""
    echo "WARNING: Public tunnel is not ready. The local website above still works."
    echo "Check tunnel.log later, or restart when internet is stable."
  fi
else
  echo ""
  echo "WARNING: cloudflared is not installed. The local website above still works."
fi

echo ""
echo "Keep this Termux session open."
echo "To stop: press CTRL + C"
echo "==========================================="
wait "$NODE_PID"
