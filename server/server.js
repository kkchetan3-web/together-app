const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { convert, probePartial, startStreamConvert } = require('./lib/convert');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '2.4.0-lavender-oneui';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const uploadsDir = path.join(ROOT, 'uploads');
const mediaDir = path.join(ROOT, 'media');
const chatImgDir = path.join(mediaDir, 'chat');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(chatImgDir, { recursive: true });

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'together',
        version: VERSION,
        rooms: rooms.size,
        uptime: Math.round(process.uptime()),
        turnConfigured: fs.existsSync(path.join(ROOT, 'turn.txt')),
        maxUploadGB: Math.round(MAX_UPLOAD_BYTES / 1024 ** 3)
    });
});

app.get('/vendor/hls.min.js', (req, res) => {
    res.sendFile(path.join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js'));
});

app.use(express.static(path.join(ROOT, 'public')));
app.use('/media', express.static(mediaDir));

app.get('/link', (req, res) => {
    try { res.type('text').send(fs.readFileSync(path.join(ROOT, 'link.txt'), 'utf8').trim()); }
    catch { res.type('text').send(''); }
});

// Quota-free public relay: Metered Open Relay "static auth" (REST secret).
// The secret is published by Metered for the Open Relay Project; credentials
// minted from it do NOT consume a personal Metered plan quota. Time-limited.
function openrelayRest() {
    const secret = 'openrelayprojectsecret';
    const username = Math.floor(Date.now() / 1000) + 86400 + ':together';
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    return {
        urls: [
            'turn:staticauth.openrelay.metered.ca:80',
            'turn:staticauth.openrelay.metered.ca:443',
            'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
            'turns:staticauth.openrelay.metered.ca:443?transport=tcp'
        ],
        username, credential
    };
}

app.get('/ice', (req, res) => {
    const clean = [];
    try {
        const data = fs.readFileSync(path.join(ROOT, 'turn.txt'), 'utf8').trim();
        if (data) {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                for (const e of parsed) {
                    if (!e || !e.urls) continue;
                    const entry = {
                        urls: Array.isArray(e.urls) ? e.urls.map((u) => String(u).trim()) : String(e.urls).trim()
                    };
                    // Trim stray whitespace (a trailing space in the credential
                    // silently breaks TURN authentication).
                    if (e.username != null) entry.username = String(e.username).trim();
                    if (e.credential != null) entry.credential = String(e.credential).trim();
                    const ph = /xxxx|your_|placeholder/i.test(entry.username || '') || /xxx|your_|placeholder/i.test(entry.credential || '');
                    if (ph) continue; // skip redacted / example placeholders
                    clean.push(entry);
                }
            }
        }
    } catch {}
    // User TURN first (if quota remains), then the quota-free public relay, then STUN.
    res.json(clean.concat([openrelayRest(), { urls: 'stun:stun.l.google.com:19302' }]));
});

// Maximum room video upload. Override with MAX_UPLOAD_GB env if ever needed.
const MAX_UPLOAD_BYTES = Math.max(1, Math.round((Number(process.env.MAX_UPLOAD_GB) || 5) * 1024 ** 3));
const upload = multer({ dest: uploadsDir, limits: { fileSize: MAX_UPLOAD_BYTES } });
const chatImgUpload = multer({ dest: uploadsDir, limits: { fileSize: 5 * 1024 ** 2 } });
const rooms = new Map();
const roomState = new Map();
const roomBookmarks = new Map();
let queue = Promise.resolve();
rooms.set('TOGETHER', new Map());

function normalizeRoom(value) {
    const room = String(value || '').trim().toUpperCase();
    return /^[A-Z0-9]{4,12}$/.test(room) ? room : null;
}
function normalizeCid(value) {
    const cid = String(value || '').trim();
    return /^[A-Za-z0-9_-]{8,64}$/.test(cid) ? cid : null;
}

// Every media folder a room creates, so "clear from room" can delete them all.
const roomMedia = new Map(); // room -> Set(mediaId)
function trackMedia(room, id) {
    if (!roomMedia.has(room)) roomMedia.set(room, new Set());
    roomMedia.get(room).add(id);
}

// Shared pipeline: takes a fully-uploaded temp file and converts it to HLS.
function startProcessing(room, tmp, name) {
    const id = crypto.randomBytes(12).toString('hex');
    const outDir = path.join(mediaDir, id);
    fs.mkdirSync(outDir, { recursive: true });
    trackMedia(room, id);
    io.to(room).emit('processing', { name, percent: 0 });
    queue = queue
        .then(() => convert(tmp, outDir, (percent) => io.to(room).emit('processing', { name, percent })))
        .then(({ hasSubs }) => {
            const url = `/media/${id}/index.m3u8`;
            const subs = hasSubs ? `/media/${id}/subs.vtt` : null;
            roomState.set(room, { url, subs });
            io.to(room).emit('player', { type: 'load', url, subs });
            io.to(room).emit('chat', { name: 'System', text: `"${name}" is ready. Enjoy!` });
        })
        .catch((err) => {
            io.to(room).emit('chat', { name: 'System', text: 'Problem: ' + err.message });
            io.to(room).emit('processing', { name, percent: -1 });
        })
        .finally(() => fs.unlink(tmp, () => {}));
    return id;
}

// Legacy single-request upload (fine on localhost; tunnels cap request bodies).
app.post('/upload/:room', (req, res, next) => {
    upload.single('video')(req, res, (err) => {
        if (err) {
            const tooBig = err.code === 'LIMIT_FILE_SIZE';
            return res.status(tooBig ? 413 : 400).json({
                error: tooBig ? 'File too large (max ' + Math.round(MAX_UPLOAD_BYTES / 1024 ** 3) + ' GB).' : 'Upload failed: ' + err.message
            });
        }
        next();
    });
}, (req, res) => {
    const room = normalizeRoom(req.params.room);
    if (!room || !rooms.has(room)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: 'Room not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ id: startProcessing(room, req.file.path, req.file.originalname) });
});

// ---- Progressive playback: watch while the file is still uploading ----
// Slices are appended to the temp file AND piped into ffmpeg, which writes a
// growing HLS playlist. As soon as the first segments exist both peers are
// told to load it from position 0 at the same wall-clock moment, so MKV/large
// files start together instead of waiting for the whole upload.
function feedStdin(ff, buf) {
    return new Promise((resolve) => {
        if (!ff || !ff.stdin || ff.stdin.destroyed) return resolve(false);
        // Resolving on the write callback gives natural backpressure: if ffmpeg
        // is slower than the network, slice POSTs slow down instead of buffering
        // the whole movie in RAM.
        ff.stdin.write(buf, () => resolve(true));
    });
}

function announceLive(s) {
    if (s.announced || !s.outDir) return;
    const playlist = path.join(s.outDir, 'index.m3u8');
    try {
        const txt = fs.readFileSync(playlist, 'utf8');
        const segments = (txt.match(/#EXTINF:/g) || []).length;
        if (segments < 1) return; // hls.js can start here and keep polling for more
        s.announced = true;
        if (s.poller) { clearInterval(s.poller); s.poller = null; }
        const url = `/media/${s.mediaId}/index.m3u8`;
        roomState.set(s.room, { url, subs: null, live: true });
        trackMedia(s.room, s.mediaId);
        // Same start instant for both peers -> simultaneous start.
        io.to(s.room).emit('player', { type: 'load', url, subs: null, live: true, startAt: Date.now() + 3000 });
        io.to(s.room).emit('chat', { name: 'System', text: `"${s.name}" is playing while it uploads. Both of you start together.` });
    } catch {}
}

async function tryStartLive(s, endOffset) {
    let info;
    try { info = await probePartial(s.tmp); } catch { return; } // not enough data yet; retry on a later slice
    const v = (info.streams || []).find((x) => x.codec_type === 'video');
    const a = (info.streams || []).find((x) => x.codec_type === 'audio');
    if (!v) { s.live = false; return; }
    const copyV = v.codec_name === 'h264';
    const copyA = !!a && a.codec_name === 'aac' && a.channels <= 2;
    s.mediaId = crypto.randomBytes(12).toString('hex');
    s.outDir = path.join(mediaDir, s.mediaId);
    try { fs.mkdirSync(s.outDir, { recursive: true }); } catch { s.live = false; return; }
    const ff = startStreamConvert(s.outDir, { copyV, copyA });
    s.ff = ff;
    s.live = true;
    ff.on('error', () => { s.live = false; s.ff = null; });
    ff.on('close', (code) => {
        s.ffExited = true;
        if (code === 0 && s.outDir) {
            // Turn the growing EVENT playlist into a finished VOD.
            const pl = path.join(s.outDir, 'index.m3u8');
            try {
                const txt = fs.readFileSync(pl, 'utf8');
                if (!txt.includes('#EXT-X-ENDLIST')) fs.appendFileSync(pl, '#EXT-X-ENDLIST\n');
            } catch {}
            announceLive(s);
            io.to(s.room).emit('player', { type: 'vod', url: `/media/${s.mediaId}/index.m3u8` });
        } else if (!s.finalized) {
            s.live = false; s.ff = null; // fall back to converting the whole file at the end
        }
    });
    s.poller = setInterval(() => announceLive(s), 700);
    s.poller.unref();
    // Feed everything received so far, in order, before later slices.
    const prefix = fs.readFileSync(s.tmp, { encoding: null, flag: 'r' }).subarray(0, endOffset);
    await feedStdin(ff, prefix);
}

function stopLive(s) {
    if (s.poller) { clearInterval(s.poller); s.poller = null; }
    if (s.ff) { try { s.ff.stdin.end(); } catch {} try { s.ff.kill('SIGKILL'); } catch {} s.ff = null; }
}

// Chunked upload: small slices pass through Cloudflare's ~100 MB body cap.
// Chunks arrive in order and are appended to a temp file; the last chunk
// finalizes the stream. /upload-status lets a client resume after a dropped
// request without duplicating data.
const UPLOAD_CHUNK_MAX = 96 * 1024 ** 2;
const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_CHUNK_MAX } });
const uploadSessions = new Map(); // uid -> { fd, tmp, room, name, totalSize, totalChunks, next, bytes, last }

app.get('/upload-status/:room/:uid', (req, res) => {
    const room = normalizeRoom(req.params.room);
    const uid = String(req.params.uid || '');
    if (!room || !/^[a-f0-9]{24}$/.test(uid)) return res.status(400).json({ error: 'Bad request' });
    const s = uploadSessions.get(uid);
    if (!s || s.room !== room) return res.json({ next: 0 });
    res.json({ next: s.next, total: s.totalChunks });
});

app.post('/upload-chunk/:room', (req, res) => {
    chunkUpload.single('chunk')(req, res, (err) => {
        if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Chunk rejected: ' + err.message });
        const room = normalizeRoom(req.params.room);
        if (!room || !rooms.has(room)) return res.status(403).json({ error: 'Room not found' });
        const b = req.body || {};
        const uid = String(b.uid || '');
        const index = Number(b.index), totalChunks = Number(b.totalChunks), totalSize = Number(b.totalSize);
        const name = String(b.name || 'video').slice(0, 200);
        if (!/^[a-f0-9]{24}$/.test(uid)) return res.status(400).json({ error: 'Bad upload id' });
        if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ error: 'No chunk data' });
        if (!Number.isInteger(index) || !Number.isInteger(totalChunks) || index < 0 || totalChunks < 1 || totalChunks > 100000 || index >= totalChunks)
            return res.status(400).json({ error: 'Bad chunk index' });
        if (!Number.isFinite(totalSize) || totalSize < 1) return res.status(400).json({ error: 'Bad file size' });
        if (totalSize > MAX_UPLOAD_BYTES)
            return res.status(413).json({ error: 'File too large (max ' + Math.round(MAX_UPLOAD_BYTES / 1024 ** 3) + ' GB).' });
        let s = uploadSessions.get(uid);
        if (!s) {
            if (index !== 0) return res.status(409).json({ error: 'Upload must start at chunk 0', next: 0 });
            const tmp = path.join(uploadsDir, uid + '.part');
            let fd;
            try { fd = fs.openSync(tmp, 'w'); } catch (e) { return res.status(500).json({ error: 'Cannot open temp file: ' + e.message }); }
            s = { fd, tmp, room, name, totalSize, totalChunks, next: 0, bytes: 0, last: Date.now(),
                  live: null, ff: null, mediaId: null, outDir: null, announced: false, chain: null, poller: null, finalized: false };
            uploadSessions.set(uid, s);
        }
        s.last = Date.now();
        if (s.room !== room || s.totalSize !== totalSize || s.totalChunks !== totalChunks) {
            try { fs.closeSync(s.fd); } catch {}
            fs.unlink(s.tmp, () => {});
            uploadSessions.delete(uid);
            return res.status(409).json({ error: 'Upload metadata changed; start over', next: 0 });
        }
        if (index !== s.next) return res.status(409).json({ error: 'Unexpected chunk', next: s.next });
        if (s.bytes + req.file.buffer.length > s.totalSize) {
            try { fs.closeSync(s.fd); } catch {}
            fs.unlink(s.tmp, () => {});
            uploadSessions.delete(uid);
            return res.status(413).json({ error: 'More data than declared file size' });
        }
        try { fs.writeSync(s.fd, req.file.buffer); } catch (e) {
            try { fs.closeSync(s.fd); } catch {}
            fs.unlink(s.tmp, () => {});
            uploadSessions.delete(uid);
            return res.status(500).json({ error: 'Disk write failed (storage full?): ' + e.message });
        }
        const buf = req.file.buffer;
        s.bytes += buf.length;
        const endOffset = s.bytes;
        s.next++;
        const isFinal = s.next === s.totalChunks;
        // Serialize progressive-feed work so slices reach ffmpeg in order and
        // the probe's prefix never overlaps a later slice.
        s.chain = (s.chain || Promise.resolve()).then(async () => {
            if (s.live === null) {
                // Keep trying as more of the file arrives (a partial container may
                // not be readable yet). Give up after 8 attempts -> convert at end.
                s.probeAttempts = (s.probeAttempts || 0) + 1;
                if (s.probeAttempts > 8) s.live = false;
                else await tryStartLive(s, endOffset);
            } else if (s.live && s.ff) await feedStdin(s.ff, buf);
        }).catch(() => { s.live = false; });
        s.chain.then(async () => {
            if (!isFinal) return res.json({ ok: true, next: s.next, live: !!s.announced });
            try { fs.closeSync(s.fd); } catch {}
            uploadSessions.delete(uid);
            if (s.bytes !== s.totalSize) {
                stopLive(s);
                fs.unlink(s.tmp, () => {});
                return res.status(400).json({ error: 'Size mismatch after final chunk' });
            }
            s.finalized = true;
            if (s.live && s.ff) {
                // Finish the stream we have already been playing.
                announceLive(s); // poller keeps trying until segments exist
                try { s.ff.stdin.end(); } catch {}
                fs.unlink(s.tmp, () => {});
                trackMedia(room, s.mediaId);
                return res.json({ id: s.mediaId, live: true });
            }
            stopLive(s);
            if (s.outDir) fs.rm(s.outDir, { recursive: true, force: true }, () => {});
            return res.json({ id: startProcessing(room, s.tmp, s.name) });
        }).catch((e) => res.status(500).json({ error: 'Upload failed: ' + e.message }));
    });
});

// Abandon stale chunked uploads after 30 minutes so temp files don't pile up.
setInterval(() => {
    const now = Date.now();
    for (const [uid, s] of uploadSessions) {
        if (now - s.last > 30 * 60 * 1000) {
            stopLive(s);
            try { fs.closeSync(s.fd); } catch {}
            fs.unlink(s.tmp, () => {});
            if (s.outDir && !s.announced) fs.rm(s.outDir, { recursive: true, force: true }, () => {});
            uploadSessions.delete(uid);
        }
    }
}, 60 * 1000).unref();

// Size-capped chat image / GIF upload (feature 11). Returns a served URL.
app.post('/chatimg/:room', (req, res) => {
    chatImgUpload.single('image')(req, res, (err) => {
        if (err) {
            const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return res.status(code).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image too large (max 5 MB).' : 'Upload failed.' });
        }
        handleChatImg(req, res);
    });
});
function handleChatImg(req, res) {
    const room = normalizeRoom(req.params.room);
    if (!room || !rooms.has(room)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: 'Room not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No image' });
    const mime = String(req.file.mimetype || '');
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(mime)) {
        fs.unlink(req.file.path, () => {});
        return res.status(415).json({ error: 'Only PNG / JPG / GIF / WebP images are allowed.' });
    }
    const ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'jpg';
    const id = crypto.randomBytes(10).toString('hex');
    const dest = path.join(chatImgDir, `${id}.${ext}`);
    fs.rename(req.file.path, dest, (err) => {
        if (err) return res.status(500).json({ error: 'Could not save image' });
        res.json({ url: `/media/chat/${id}.${ext}` });
    });
}

app.delete('/delete/:room', (req, res) => {
    const room = normalizeRoom(req.params.room);
    if (!room || !rooms.has(room)) return res.status(404).json({ error: 'Room not found.' });
    const ids = new Set(roomMedia.get(room) || []);
    const state = roomState.get(room);
    const currentId = String((state && state.url) || '').split('/')[2];
    if (/^[a-f0-9]{24}$/.test(currentId)) ids.add(currentId);

    // Cancel any upload still running for this room and drop its temp slices.
    let cancelled = 0;
    for (const [uid, s] of uploadSessions) {
        if (s.room !== room) continue;
        stopLive(s);
        try { fs.closeSync(s.fd); } catch {}
        fs.unlink(s.tmp, () => {});
        if (s.mediaId) ids.add(s.mediaId);
        if (s.outDir) ids.add(path.basename(s.outDir));
        uploadSessions.delete(uid);
        cancelled++;
    }

    if (!ids.size && !state && !cancelled) return res.status(404).json({ error: 'No active video to delete.' });

    // Delete every media folder this room created (current + playlist history).
    let removed = 0;
    for (const id of ids) {
        if (!/^[a-f0-9]{24}$/.test(id)) continue;
        fs.rm(path.join(mediaDir, id), { recursive: true, force: true }, () => {});
        removed++;
    }
    // Sweep orphaned partial uploads (no live session owns them any more).
    try {
        for (const f of fs.readdirSync(uploadsDir)) {
            if (!f.endsWith('.part')) continue;
            if (uploadSessions.has(f.slice(0, -5))) continue;
            fs.unlink(path.join(uploadsDir, f), () => {});
        }
    } catch {}
    roomMedia.delete(room);
    roomState.delete(room);
    io.to(room).emit('player', { type: 'delete' });
    io.to(room).emit('chat', { name: 'System', text: `Cleared from the room and deleted from the server (${removed} item${removed === 1 ? '' : 's'}).` });
    res.json({ ok: true, removed, cancelled });
});

io.on('connection', (s) => {
    s.on('join', (payload, cb) => {
        if (typeof cb !== 'function') return;
        const room = normalizeRoom(payload && payload.room);
        const cid = normalizeCid(payload && payload.cid);
        const create = Boolean(payload && payload.create);
        if (!room || !cid) return cb({ error: 'Missing or invalid room code' });

        let created = false;
        if (!rooms.has(room)) {
            if (!create) return cb({ error: 'Room not found. Ask your partner to create it first.' });
            rooms.set(room, new Map());
            created = true;
        }
        const m = rooms.get(room);
        if (!m.has(cid) && m.size >= 2) return cb({ error: 'Room is full (max 2 people).' });

        const oldId = m.get(cid);
        if (oldId && oldId !== s.id) {
            const old = io.sockets.sockets.get(oldId);
            if (old) { old.leave(room); old.data.room = null; }
        }
        m.set(cid, s.id);
        s.join(room);
        s.data.room = room;
        s.data.cid = cid;
        if (!s.data.name) s.data.name = 'Guest';
        console.log('[room] join room=' + room + ' peers=' + m.size + (created ? ' (created)' : ''));

        let peerName = null;
        for (const [otherCid, otherSockId] of m) {
            if (otherCid !== cid) {
                const otherSock = io.sockets.sockets.get(otherSockId);
                if (otherSock && otherSock.data.name) peerName = otherSock.data.name;
            }
        }

        const state = roomState.get(room) || {};
        cb({ ok: true, room, created, url: state.url || null, subs: state.subs || null, peerName });
        s.emit('bookmarks', { list: roomBookmarks.get(room) || [] });

        if (m.size === 2) {
            console.log('[room] ready (2 peers) room=' + room + ' — starting WebRTC negotiation');
            s.emit('ready', { polite: true });
            s.to(room).emit('ready', { polite: false });
        }
    });

    s.on('set-name', ({ name }) => {
        if (!s.data.room) return;
        s.data.name = String(name || 'Guest').slice(0, 20);
        s.to(s.data.room).emit('peer-name', { name: s.data.name });
    });

    ['signal', 'chat', 'screen-start', 'screen-stop', 'player', 'react', 'queue', 'typing', 'reaction'].forEach((ev) =>
        s.on(ev, (d) => {
            if (!s.data.room) return;
            if (ev === 'signal') {
                const k = d && d.description ? 'sdp:' + d.description.type : (d && d.candidate ? 'ice-candidate' : '?');
                console.log('[signal] room=' + s.data.room + ' ' + k);
            }
            s.to(s.data.room).emit(ev, d);
        })
    );

    // One-tap call restart: tell BOTH peers to rebuild the peer connection.
    s.on('call-restart', () => {
        if (s.data.room) io.to(s.data.room).emit('call-restart');
    });

    // Synced 3-2-1 countdown (feature 6): broadcast to BOTH peers incl. sender.
    s.on('countdown', (d) => {
        if (!s.data.room) return;
        const seconds = Math.min(10, Math.max(1, Number(d && d.seconds) || 3));
        io.to(s.data.room).emit('countdown', { seconds, by: s.data.name || 'Partner' });
    });

    // Shared timestamp bookmarks (feature 8), stored per room on the server.
    s.on('bookmark-add', (d) => {
        const r = s.data.room;
        if (!r) return;
        const time = Number(d && d.time);
        if (!Number.isFinite(time) || time < 0) return;
        const label = String((d && d.label) || 'Moment').slice(0, 60);
        const list = roomBookmarks.get(r) || [];
        if (list.length >= 100) list.shift();
        list.push({ id: crypto.randomBytes(6).toString('hex'), time, label, by: s.data.name || 'Guest' });
        list.sort((a, b) => a.time - b.time);
        roomBookmarks.set(r, list);
        io.to(r).emit('bookmarks', { list });
    });
    s.on('bookmark-remove', (d) => {
        const r = s.data.room;
        if (!r) return;
        const list = (roomBookmarks.get(r) || []).filter((b) => b.id !== (d && d.id));
        roomBookmarks.set(r, list);
        io.to(r).emit('bookmarks', { list });
    });

    s.on('disconnect', () => {
        const r = s.data.room;
        if (!r || !rooms.has(r)) return;
        const m = rooms.get(r);
        if (m.get(s.data.cid) === s.id) {
            m.delete(s.data.cid);
            console.log('[room] leave room=' + r + ' peers=' + m.size);
            s.to(r).emit('peer-left');
        }
    });
});

const cleanupTimer = setInterval(() => {
    const week = 7 * 24 * 3600 * 1000;
    let entries = [];
    try { entries = fs.readdirSync(mediaDir); } catch { return; }
    for (const d of entries) {
        if (d === 'chat') continue;
        const p = path.join(mediaDir, d);
        try { if (Date.now() - fs.statSync(p).mtimeMs > week) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
    try {
        for (const f of fs.readdirSync(chatImgDir)) {
            const p = path.join(chatImgDir, f);
            try { if (Date.now() - fs.statSync(p).mtimeMs > week) fs.rmSync(p, { force: true }); } catch {}
        }
    } catch {}
}, 3600 * 1000);
cleanupTimer.unref();

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the old Together server or set PORT to another port.`);
    } else {
        console.error('Server error:', err.message);
    }
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    console.log(`Together ${VERSION} is running on http://localhost:${PORT}`);
});

function shutdown() {
    clearInterval(cleanupTimer);
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
