#!/usr/bin/env node
/* Dependency-free TURN connectivity + credential tester (verbose).
 * Performs a real TURN Allocate (RFC 5766 long-term credential) over UDP/TCP/TLS.
 * Usage:
 *   node turn-check.js                  # reads ./turn.txt
 *   node turn-check.js /path/turn.txt
 *   TURN_USER=u TURN_PASS=p node turn-check.js      # test metered defaults
 *   node turn-check.js --control        # test PUBLIC openrelay (network control)
 * Exit 0 if at least one TURN URL allocated, else 1.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;

const MAGIC = 0x2112a442;
const TIMEOUT = 6000;

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function attr(type, value) {
    const pad = (4 - (value.length % 4)) % 4;
    const b = Buffer.alloc(4 + value.length + pad);
    b.writeUInt16BE(type, 0); b.writeUInt16BE(value.length, 2); value.copy(b, 4);
    return b;
}
function header(type, bodyLen, txn) {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(type, 0); h.writeUInt16BE(bodyLen, 2); h.writeUInt32BE(MAGIC, 4); txn.copy(h, 8);
    return h;
}
function parseAttrs(msg) {
    const out = {}; let off = 20;
    while (off + 4 <= msg.length) {
        const t = msg.readUInt16BE(off), l = msg.readUInt16BE(off + 2);
        out[t] = msg.slice(off + 4, off + 4 + l);
        off += 4 + l + ((4 - (l % 4)) % 4);
    }
    return out;
}
function xorAddr(buf) {
    if (!buf || buf.length < 8) return null;
    const fam = buf[1];
    const xport = buf.readUInt16BE(2) ^ (MAGIC >>> 16);
    if (fam === 0x01) return [0, 1, 2, 3].map((i) => buf[4 + i] ^ ((MAGIC >>> (24 - i * 8)) & 0xff)).join('.') + ':' + xport;
    return '(ipv6 relay)';
}
function buildAllocate(txn) {
    const rt = Buffer.alloc(4); rt[0] = 17;
    const body = attr(0x0019, rt);
    return Buffer.concat([header(0x0003, body.length, txn), body]);
}
function buildAuthAllocate(txn, user, realm, nonce, pass) {
    const rt = Buffer.alloc(4); rt[0] = 17;
    const body = Buffer.concat([
        attr(0x0006, Buffer.from(user, 'utf8')),
        attr(0x0014, realm),
        attr(0x0015, nonce),
        attr(0x0019, rt)
    ]);
    const miLen = body.length + 4 + 20;
    const msg = Buffer.concat([header(0x0003, miLen, txn), body, attr(0x0008, Buffer.alloc(20))]);
    const key = crypto.createHash('md5').update(user + ':' + realm.toString('utf8') + ':' + pass).digest();
    const hmac = crypto.createHmac('sha1', key).update(msg.slice(0, msg.length - 20)).digest();
    hmac.copy(msg, msg.length - 20);
    msg.writeUInt16BE(miLen + 8, 2);
    const withFp = Buffer.concat([msg, attr(0x8028, Buffer.alloc(4))]);
    withFp.writeUInt32BE((crc32(withFp.slice(0, withFp.length - 4)) ^ 0x5354554e) >>> 0, withFp.length - 4);
    return withFp;
}
function errCode(a) {
    if (!a[0x0009] || a[0x0009].length < 4) return { code: 0, reason: '' };
    return { code: a[0x0009][2] * 100 + a[0x0009][3], reason: a[0x0009].slice(4).toString('utf8') };
}

function sendUdp(host, port, msg) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const timer = setTimeout(() => { try { sock.close(); } catch {} resolve(null); }, TIMEOUT);
        sock.on('message', (m) => { clearTimeout(timer); try { sock.close(); } catch {} resolve(m); });
        sock.on('error', () => { clearTimeout(timer); try { sock.close(); } catch {} resolve(null); });
        sock.send(msg, port, host, (e) => { if (e) { clearTimeout(timer); try { sock.close(); } catch {} resolve(null); } });
    });
}
function sendTcp(host, port, msg, useTls) {
    return new Promise((resolve) => {
        let buf = Buffer.alloc(0);
        const done = (m) => { clearTimeout(timer); try { sock.destroy(); } catch {} resolve(m); };
        const sock = useTls ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }) : net.connect({ host, port });
        const timer = setTimeout(() => done(null), TIMEOUT);
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length >= 20) { const len = buf.readUInt16BE(2); if (buf.length >= 20 + len) done(buf.slice(0, 20 + len)); }
        });
        sock.on('error', () => done(null));
        sock.on('connect', () => { if (!useTls) sock.write(msg); });
        sock.on('secureConnect', () => sock.write(msg));
    });
}

async function allocateOnce(url, user, pass) {
    const u = new URL(url.replace(/^turns?:/, 'http:'));
    const host = u.hostname;
    const isTls = url.startsWith('turns:');
    const transport = (u.searchParams.get('transport') || 'udp').toLowerCase();
    const port = parseInt(u.port || (isTls ? '5349' : '3478'), 10);
    const useTcp = isTls || transport === 'tcp';
    const mode = isTls ? 'TLS/TCP' : (useTcp ? 'TCP' : 'UDP');
    const send = (m) => (useTcp ? sendTcp(host, port, m, isTls) : sendUdp(host, port, m));

    let ip = null;
    try { ip = (await dns.lookup(host, { family: 4 })).address; } catch (e) { return { ok: false, mode, ip: null, reason: 'DNS lookup failed: ' + e.code }; }

    const txn = crypto.randomBytes(12);
    let resp = await send(buildAllocate(txn));
    if (!resp) return { ok: false, mode, ip, reason: 'no response to initial Allocate (' + mode + ' blocked, firewall, or wrong port)' };
    let type = resp.readUInt16BE(0);
    if (type === 0x0113) {
        const a = parseAttrs(resp);
        const realm = a[0x0014], nonce = a[0x0015];
        if (!realm || !nonce) { const e = errCode(a); return { ok: false, mode, ip, reason: 'challenge without realm/nonce (code ' + e.code + ' ' + e.reason + ')' }; }
        const txn2 = crypto.randomBytes(12);
        resp = await send(buildAuthAllocate(txn2, user, realm, nonce, pass));
        if (!resp) return { ok: false, mode, ip, reason: 'server reachable (got 401 challenge) but no response to authenticated Allocate' };
        type = resp.readUInt16BE(0);
    }
    if (type === 0x0103) {
        const a = parseAttrs(resp);
        return { ok: true, mode, ip, relay: xorAddr(a[0x0016]) || '(relayed)', mapped: xorAddr(a[0x0020]) };
    }
    const a = parseAttrs(resp); const e = errCode(a);
    if (type === 0x0113) return { ok: false, mode, ip, reason: 'AUTH REJECTED code ' + e.code + (e.reason ? ' "' + e.reason + '"' : '') + ' — username/credential wrong or expired' };
    return { ok: false, mode, ip, reason: 'unexpected STUN type 0x' + type.toString(16) + ' code ' + e.code };
}

function parseConfig() {
    if (process.argv.includes('--control')) {
        return [{ urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }];
    }
    if (process.env.TURN_USER && process.env.TURN_PASS) {
        return [{ urls: ['turn:global.relay.metered.ca:80', 'turn:global.relay.metered.ca:443', 'turn:global.relay.metered.ca:443?transport=tcp', 'turns:global.relay.metered.ca:443?transport=tcp'], username: process.env.TURN_USER, credential: process.env.TURN_PASS }];
    }
    const file = process.argv[2] || path.join(__dirname, 'turn.txt');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

(async () => {
    let cfg;
    try { cfg = parseConfig(); } catch (e) { console.error('Cannot read TURN config: ' + e.message); process.exit(1); }
    let anyOk = false;
    for (const e of cfg) {
        if (!e || !e.urls || !e.username) continue;
        const urls = Array.isArray(e.urls) ? e.urls : [e.urls];
        const user = String(e.username).trim(), pass = String(e.credential || '').trim();
        for (const url of urls) {
            if (!/^turns?:/.test(url)) continue;
            const r = await allocateOnce(url, user, pass);
            const tag = r.ok ? 'OK  ' : 'FAIL';
            console.log(tag + ' ' + url + '  [' + r.mode + (r.ip ? ' ip=' + r.ip : ' ip=DNS-FAIL') + ']  ' + (r.ok ? 'relay=' + r.relay + (r.mapped ? ' mapped=' + r.mapped : '') : r.reason));
            if (r.ok) anyOk = true;
        }
    }
    console.log(anyOk ? '\nRESULT: TURN reachable and credentials VALID.' : '\nRESULT: no TURN allocation succeeded.');
    process.exit(anyOk ? 0 : 1);
})();
