# Together — Termux server

Node.js + Express + Socket.IO watch-party server with WebRTC video call,
chat, HLS video upload (ffmpeg) and a Cloudflare quick tunnel.

## Layout
- `server.js` — Express + Socket.IO, rooms, upload, `/ice` (TURN), `/link`
- `public/index.html` — room UI (Lavender Glass, One UI inspired) + WebRTC
- `public/lavender.css` — the theme (also inlined in index.html)
- `lib/convert.js` — ffmpeg → HLS conversion
- `start.sh` — starts node + cloudflared, prints the public link
- `deploy-termux.sh` — one-command updater for Termux
- `turn.txt.example` — template for your TURN credentials

## Your private files (NOT in git)
`turn.txt` (TURN credentials), `media/`, `uploads/`, `link.txt`, logs and
`node_modules/` stay on your device and are never overwritten by updates.

## Update from Termux
```bash
bash ~/together-app/server/deploy-termux.sh
```

## TURN (video call across networks)
Copy `turn.txt.example` to `turn.txt` on the device and fill in your Metered
credentials. Without TURN, calls only work when both devices are on the same
Wi-Fi. The `/ice` endpoint serves this file to the browser.
