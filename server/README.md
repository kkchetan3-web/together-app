# Together — Termux server

Node.js + Express + Socket.IO watch-party server with WebRTC video call,
chat, HLS video upload (ffmpeg) and an optional Cloudflare quick tunnel.

## Local website first
The server is local-first: `http://localhost:3000` must work even if the
public tunnel fails. Start it with:

```bash
bash ~/together/start.sh
```

Health check:

```bash
node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(console.log)"
```

## Layout
- `server.js` — Express + Socket.IO, rooms, upload, `/ice`, `/link`, `/health`
- `public/index.html` — room UI (Lavender Glass) + WebRTC
- `public/lavender.css` — theme copy (also inlined in index.html)
- `lib/convert.js` — ffmpeg → HLS conversion
- `start.sh` — starts website first, then optional tunnel
- `deploy-termux.sh` — one-command updater
- `turn.txt.example` — template for TURN credentials

## Private files (NOT in git)
`turn.txt`, `media/`, `uploads/`, `link.txt`, logs, PID files and
`node_modules/` stay on the device and are preserved by updates.

## Update from Termux
```bash
bash ~/together-app/server/deploy-termux.sh
```

To deploy a specific branch:
```bash
TOGETHER_REF=branch-name bash ~/together-app/server/deploy-termux.sh
```

## Room creation troubleshooting
- Open `http://localhost:3000`, not the APK, when testing the website.
- The lobby should say “Connected. Create or join a room.”
- Room codes are 4–12 letters/numbers.
- Camera/mic permission is requested after the room is created; denying it
  should not prevent room creation.
- HLS.js is served locally from `/vendor/hls.min.js`; the page does not depend
  on a CDN to make the Create/Join buttons work.
- If the tunnel fails, the local website still runs. Check `server.log` and
  `tunnel.log` in `~/together`.

## TURN (video call across networks)
Copy `turn.txt.example` to `turn.txt` on the device and fill in your Metered
credentials. Without valid TURN, calls across different mobile networks may
fail even when the room/chat/video player work.
