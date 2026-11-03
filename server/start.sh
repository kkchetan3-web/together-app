#!/data/data/com.termux/files/usr/bin/bash
cd ~/together
termux-wake-lock
pkill -f "node server.js" 2>/dev/null
pkill -f cloudflared 2>/dev/null
rm -f link.txt tunnel.log
trap 'pkill -f "node server.js"; pkill -f cloudflared' EXIT

node server.js > server.log 2>&1 &
sleep 2

# http2 (TCP 443) is more reliable than QUIC on mobile/hotspot networks.
cloudflared tunnel --protocol http2 --url http://localhost:3000 > tunnel.log 2>&1 &
echo "Starting public link, please wait..."
LINK=""
for i in $(seq 1 40); do
    LINK=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1)
    [ -n "$LINK" ] && break
    sleep 1
done
if [ -z "$LINK" ]; then
    echo "Could not get a public link. Check your internet and try again."
    exit 1
fi
echo "$LINK" > link.txt
echo ""
echo "=========================================="
echo " READY! Public link:"
echo "   $LINK"
echo "=========================================="
echo " Open Chrome on this tablet:"
echo "   http://localhost:3000"
echo " Keep this Termux session running."
echo " To stop: press CTRL + C"
echo "=========================================="
wait
