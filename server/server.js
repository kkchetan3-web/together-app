const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { convert } = require('./lib/convert');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

fs.mkdirSync('uploads', { recursive: true });
fs.mkdirSync('media', { recursive: true });
app.use(express.static('public'));
app.use('/media', express.static('media'));

app.get('/link', (req, res) => {
    try { res.type('text').send(fs.readFileSync('link.txt', 'utf8').trim()); }
    catch { res.type('text').send(''); }
});

app.get('/ice', (req, res) => {
    try {
        const data = fs.readFileSync('turn.txt', 'utf8').trim();
        if (data) { JSON.parse(data); return res.type('json').send(data); }
    } catch {}
    res.json([{ urls: 'stun:stun.l.google.com:19302' }]);
});

const upload = multer({ dest: 'uploads/', limits: { fileSize: 20 * 1024 ** 3 } });
const rooms = {};
const roomState = {};
let queue = Promise.resolve();

app.post('/upload/:room', upload.single('video'), (req, res) => {
    const room = req.params.room;
    if (!rooms[room]) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: 'Room not found' }); }
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const id = crypto.randomBytes(12).toString('hex');
    const outDir = path.join('media', id);
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
            roomState[room] = { url, subs };
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
    const room = req.params.room;
    if (!rooms[room] || !roomState[room]) return res.status(404).json({ error: 'No active video to delete.' });
    const mediaId = roomState[room].url.split('/')[2];
    fs.rm(path.join('media', mediaId), { recursive: true, force: true }, () => {});
    delete roomState[room];
    io.to(room).emit('player', { type: 'delete' });
    io.to(room).emit('chat', { name: 'System', text: 'The video has been removed.' });
    res.json({ ok: true });
});

rooms['TOGETHER'] = new Map();
io.on('connection', (s) => {
    s.on('join', ({ room, create, cid }, cb) => {
        if (!room || !cid) return cb({ error: 'Missing room code' });
        if (!rooms[room]) {
            if (!create) return cb({ error: 'Room not found. Ask your partner to create it first.' });
            rooms[room] = new Map();
        }
        const m = rooms[room];
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

        cb({ url: roomState[room]?.url || null, subs: roomState[room]?.subs || null, peerName });

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
        if (!r || !rooms[r]) return;
        if (rooms[r].get(s.data.cid) === s.id) {
            rooms[r].delete(s.data.cid);
            s.to(r).emit('peer-left');
        }
    });
});

setInterval(() => {
    const week = 7 * 24 * 3600 * 1000;
    for (const d of fs.readdirSync('media')) {
        const p = path.join('media', d);
        try { if (Date.now() - fs.statSync(p).mtimeMs > week) fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
}, 3600 * 1000);

server.listen(process.env.PORT || 3000, () => console.log('Together is running on http://localhost:3000'));
