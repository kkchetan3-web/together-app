const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { convert } = require('./lib/convert');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '2.1.0-room-fix';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const uploadsDir = path.join(ROOT, 'uploads');
const mediaDir = path.join(ROOT, 'media');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'together',
        version: VERSION,
        rooms: rooms.size,
        uptime: Math.round(process.uptime()),
        turnConfigured: fs.existsSync(path.join(ROOT, 'turn.txt'))
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

app.get('/ice', (req, res) => {
    try {
        const data = fs.readFileSync(path.join(ROOT, 'turn.txt'), 'utf8').trim();
        if (data) {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) return res.type('json').send(data);
        }
    } catch {}
    res.json([{ urls: 'stun:stun.l.google.com:19302' }]);
});

const upload = multer({ dest: uploadsDir, limits: { fileSize: 20 * 1024 ** 3 } });
const rooms = new Map();
const roomState = new Map();
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

app.post('/upload/:room', upload.single('video'), (req, res) => {
    const room = normalizeRoom(req.params.room);
    if (!room || !rooms.has(room)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: 'Room not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const id = crypto.randomBytes(12).toString('hex');
    const outDir = path.join(mediaDir, id);
    fs.mkdirSync(outDir, { recursive: true });
    const name = req.file.originalname;
    const tmp = req.file.path;
    res.json({ id });
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
});

app.delete('/delete/:room', (req, res) => {
    const room = normalizeRoom(req.params.room);
    const state = room ? roomState.get(room) : null;
    if (!room || !rooms.has(room) || !state) return res.status(404).json({ error: 'No active video to delete.' });
    const mediaId = String(state.url || '').split('/')[2];
    if (/^[a-f0-9]{24}$/.test(mediaId)) {
        fs.rm(path.join(mediaDir, mediaId), { recursive: true, force: true }, () => {});
    }
    roomState.delete(room);
    io.to(room).emit('player', { type: 'delete' });
    io.to(room).emit('chat', { name: 'System', text: 'The video has been removed.' });
    res.json({ ok: true });
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

        let peerName = null;
        for (const [otherCid, otherSockId] of m) {
            if (otherCid !== cid) {
                const otherSock = io.sockets.sockets.get(otherSockId);
                if (otherSock && otherSock.data.name) peerName = otherSock.data.name;
            }
        }

        const state = roomState.get(room) || {};
        cb({ ok: true, room, created, url: state.url || null, subs: state.subs || null, peerName });

        if (m.size === 2) {
            s.emit('ready', { polite: true });
            s.to(room).emit('ready', { polite: false });
        }
    });

    s.on('set-name', ({ name }) => {
        if (!s.data.room) return;
        s.data.name = String(name || 'Guest').slice(0, 20);
        s.to(s.data.room).emit('peer-name', { name: s.data.name });
    });

    ['signal', 'chat', 'screen-start', 'screen-stop', 'player', 'react', 'queue'].forEach((ev) =>
        s.on(ev, (d) => s.data.room && s.to(s.data.room).emit(ev, d))
    );

    s.on('disconnect', () => {
        const r = s.data.room;
        if (!r || !rooms.has(r)) return;
        const m = rooms.get(r);
        if (m.get(s.data.cid) === s.id) {
            m.delete(s.data.cid);
            s.to(r).emit('peer-left');
        }
    });
});

const cleanupTimer = setInterval(() => {
    const week = 7 * 24 * 3600 * 1000;
    let entries = [];
    try { entries = fs.readdirSync(mediaDir); } catch { return; }
    for (const d of entries) {
        const p = path.join(mediaDir, d);
        try { if (Date.now() - fs.statSync(p).mtimeMs > week) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
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
