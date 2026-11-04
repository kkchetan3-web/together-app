#!/usr/bin/env node
/* Dependency-free TURN connectivity + credential tester.
 * Performs a real TURN Allocate (RFC 5766 / long-term credential) against each
 * turn:/turns: URL and reports whether a relayed address was allocated.
 * Usage:
 *   node turn-check.js                 # reads ./turn.txt
 *   node turn-check.js /path/turn.txt
 *   TURN_USER=u TURN_PASS=p node turn-check.js   # test metered defaults
 * Exit code 0 if at least one TURN URL allocated successfully, else 1.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');

const MAGIC = 0x2112a442;
const TIMEOUT = 6000;

// ---- CRC32 (for FINGERPRINT) ----
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// ---- STUN attribute helpers ----
function attr(type, value) {
    const pad = (4 - (value.length % 4)) % 4;
    const b = Buffer.alloc(4 + value.length + pad);
    b.writeUInt16BE(type, 0);
    b.writeUInt16BE(value.length, 2);
    value.copy(b, 4);
    return b;
}
function header(type, bodyLen, txn) {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(bodyLen, 2);
    h.writeUInt32BE(MAGIC, 4);
    txn.copy(h, 8);
    return h;
}
function parseAttrs(msg) {
    const out = {};
    let off = 20;
    while (off + 4 <= msg.length) {
        const t = msg.readUInt16BE(off);
        const l = msg.readUInt16BE(off + 2);
        out[t] = msg.slice(off + 4, off + 4 + l);
        off += 4 + l + ((4 - (l % 4)) % 4);
    }
    return out;
}
function xorAddr(buf) {
    if (!buf || buf.length < 8) return null;
    const fam = buf[1];
    const xport = buf.readUInt16BE(2) ^ (MAGIC >>> 16);
    if (fam === 0x01) {
        const ip = [0, 1, 2, 3].map((i) => buf[4 + i] ^ ((MAGIC >>> (24 - i * 8)) & 0xff)).join('.');
        return ip + ':' + xport;
    }
    if (fam === 0x02 && buf.length >= 20) {
        const parts = [];
        for (let i = 0; i < 16; i++) {
            const k = i < 4 ? (MAGIC >>> (24 - i * 8)) & 0xff : buf[4 + i] ^ buf[8 + i - 4];
            parts.push(buf[4 + i] ^ (i < 4 ? (MAGIC >>> (24 - i * 8)) & 0xff : 0));
        }
        // simplified: XOR with magic+txn
        const x = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) x[i] = buf[4 + i] ^ (i < 4 ? (MAGIC >>> (24 - i * 8)) & 0xff : 0);
        const groups = [];
        for (let i = 0; i < 16; i += 2) groups.push(x.readUInt16BE(i).toString(16));
        return '[' + groups.join(':') + ']:' + xport;
    }
    return null;
}

function buildAllocate(txn, requestedTransport) {
    const rt = Buffer.alloc(4);
    rt[0] = requestedTransport; // 17 = UDP
    const body = attr(0x0019, rt); // REQUESTED-TRANSPORT
    return Buffer.concat([header(0x0003, body.length, txn), body]);
}
function buildAuthAllocate(txn, user, realm, nonce, pass) {
    const rt = Buffer.alloc(4); rt[0] = 17;
    let body = Buffer.concat([
        attr(0x0006, Buffer.from(user, 'utf8')),   // USERNAME
        attr(0x0014, realm),                        // REALM
        attr(0x0015, nonce),                        // NONCE
        attr(0x0019, rt)                            // REQUESTED-TRANSPORT
    ]);
    // MESSAGE-INTEGRITY
    const miLen = body.length + 4 + 20;
    let msg = Buffer.concat([header(0x0003, miLen, txn), body, attr(0x0008, Buffer.alloc(20))]);
    const key = crypto.createHash('md5').update(user + ':' + realm.toString('utf8') + ':' + pass).digest();
    const hmac = crypto.createHmac('sha1', key).update(msg.slice(0, msg.length - 20)).digest();
    hmac.copy(msg, msg.length - 20);
    // FINGERPRINT
    const fpLen = miLen + 4 + 4;
    msg.writeUInt16BE(fpLen, 2);
    const withFp = Buffer.concat([msg, attr(0x8028, Buffer.alloc(4))]);
    const crc = (crc32(withFp.slice(0, withFp.length - 4)) ^ 0x5354554e) >>> 0;
    withFp.writeUInt32BE(crc, withFp.length - 4);
    return withFp;
}

// ---- transports ----
function sendUdp(host, port, msg) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const timer = setTimeout(() => { sock.close(); resolve(null); }, TIMEOUT);
        sock.on('message', (m) => { clearTimeout(timer); sock.close(); resolve(m); });
        sock.on('error', () => { clearTimeout(timer); sock.close(); resolve(null); });
        sock.send(msg, port, host, (e) => { if (e) { clearTimeout(timer); sock.close(); resolve(null); } });
    });
}
function sendTcp(host, port, msg, useTls) {
    return new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        const done = (m) => { clearTimeout(timer); try { sock.destroy(); } catch {} resolve(m); };
        const sock = useTls
            ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
            : net.connect({ host, port });
        const timer = setTimeout(() => done(null), TIMEOUT);
        const onData = (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length >= 20) {
                const len = buf.readUInt16BE(2);
                if (buf.length >= 20 + len) done(buf.slice(0, 20 + len));
            }
        };
        sock.on('data', onData);
        sock.on('error', () => done(null));
        sock.on('connect', () => sock.write(msg));
        if (useTls) sock.on('secureConnect', () => sock.write(msg));
    });
}

async function allocateOnce(url, user, pass) {
    const u = new URL(url.replace(/^turns?:/, 'http:'));
    const host = u.hostname;
    const isTls = url.startsWith('turns:');
    const transport = (u.searchParams.get('transport') || 'udp').toLowerCase();
    const port = parseInt(u.port || (isTls ? '5349' : '3478'), 10);
    const useTcp = isTls || transport === 'tcp';
    const send = (m) => (useTcp ? sendTcp(host, port, m, isTls) : sendUdp(host, port, m));

    const txn = crypto.randomBytes(12);
    let resp = await send(buildAllocate(txn, 17));
    if (!resp) return { ok: false, reason: 'no response (unreachable / blocked / wrong port)' };
    let type = resp.readUInt16BE(0);
    if (type === 0x0113) { // 401 challenge
        const a = parseAttrs(resp);
        const realm = a[0x0014], nonce = a[0x0015];
        if (!realm || !nonce) return { ok: false, reason: '401 without realm/nonce' };
        const txn2 = crypto.randomBytes(12);
        resp = await send(buildAuthAllocate(txn2, user, realm, nonce, pass));
        if (!resp) return { ok: false, reason: 'no response to authenticated allocate' };
        type = resp.readUInt16BE(0);
    }
    if (type === 0x0103) { // Allocate success
        const a = parseAttrs(resp);
        return { ok: true, relay: xorAddr(a[0x0016]) || '(relayed)', mapped: xorAddr(a[0x0020]) };
    }
    if (type === 0x0113) {
        const a = parseAttrs(resp);
        const reason = a[0x0009] && a[0x0009].length > 4 ? a[0x0009].slice(4).toString('utf8') : '';
        const code = a[0x0009] ? a[0x0009][2] * 100 + a[0x0009][3] : 401;
        return { ok: false, reason: 'auth rejected (' + code + (reason ? ' ' + reason : '') + ') — check username/credential' };
    }
    return { ok: false, reason: 'unexpected STUN type 0x' + type.toString(16) };
}

function parseConfig() {
    if (process.env.TURN_USER && process.env.TURN_PASS) {
        return [{
            urls: ['turn:global.relay.metered.ca:80', 'turn:global.relay.metered.ca:443', 'turn:global.relay.metered.ca:443?transport=tcp', 'turns:global.relay.metered.ca:443?transport=tcp'],
            username: process.env.TURN_USER, credential: process.env.TURN_PASS
        }];
    }
    const file = process.argv[2] || path.join(__dirname, 'turn.txt');
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
}

(async () => {
    let cfg;
    try { cfg = parseConfig(); } catch (e) { console.error('Cannot read TURN config: ' + e.message); process.exit(1); }
    let anyOk = false;
    for (const e of cfg) {
        if (!e || !e.urls || !e.username) continue; // skip STUN-only
        const urls = Array.isArray(e.urls) ? e.urls : [e.urls];
        const user = String(e.username).trim(), pass = String(e.credential || '').trim();
        for (const url of urls) {
            if (!/^turns?:/.test(url)) continue;
            process.stdout.write('TEST ' + url + ' ... ');
            const r = await allocateOnce(url, user, pass);
            if (r.ok) { anyOk = true; console.log('OK  relay=' + r.relay + (r.mapped ? ' mapped=' + r.mapped : '')); }
            else console.log('FAIL  ' + r.reason);
        }
    }
    console.log(anyOk ? '\nRESULT: TURN is reachable and credentials are VALID.' : '\nRESULT: no TURN allocation succeeded.');
    process.exit(anyOk ? 0 : 1);
})();
