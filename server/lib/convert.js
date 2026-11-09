const { spawn } = require('child_process');
const path = require('path');

function probe(file) {
    return new Promise((resolve, reject) => {
        const p = harden(spawn('ffprobe', ['-v', 'error', '-print_format', 'json',
            '-show_format', '-show_streams', file]));
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        // A missing/unspawnable binary emits 'error'; without this the whole
        // server process would crash instead of reporting a failed conversion.
        p.on('error', (e) => reject(new Error(e.code === 'ENOENT'
            ? 'ffprobe is not installed. In Termux run: pkg install ffmpeg'
            : 'Could not read this file: ' + e.message)));
        p.on('close', (c) => {
            if (c !== 0) return reject(new Error('Could not read this file'));
            try { resolve(JSON.parse(out)); } catch { reject(new Error('Could not read this file')); }
        });
    });
}

async function convert(inputFile, outDir, onProgress) {
    const info = await probe(inputFile);
    const v = info.streams.find((s) => s.codec_type === 'video');
    const a = info.streams.find((s) => s.codec_type === 'audio');
    if (!v) throw new Error('No video found in this file');

    const duration = parseFloat(info.format.duration) || 0;
    const copyV = v.codec_name === 'h264' && v.pix_fmt === 'yuv420p';
    const copyA = a && a.codec_name === 'aac' && a.channels <= 2;

    console.log(`Video: ${copyV ? 'COPY (fast)' : 'RE-ENCODE (slow)'} | Audio: ${copyA ? 'copy' : 'convert'}`);

    const args = ['-y', '-i', inputFile, '-map', '0:v:0', '-map', '0:a:0?',
        ...(copyV ? ['-c:v', 'copy']
            : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
        ...(copyA ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']),
        '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(outDir, 'seg_%04d.ts'),
        '-progress', 'pipe:1', '-nostats',
        path.join(outDir, 'index.m3u8')];

    await new Promise((resolve, reject) => {
        const ff = harden(spawn('ffmpeg', args), { onStdout: (d) => {
            const all = [...d.toString().matchAll(/out_time_ms=(\d+)/g)];
            if (all.length && duration) {
                const t = Number(all[all.length - 1][1]) / 1e6;
                onProgress(Math.min(99, Math.round((t / duration) * 100)));
            }
        } });
        ff.on('error', (e) => reject(new Error(e.code === 'ENOENT'
            ? 'ffmpeg is not installed. In Termux run: pkg install ffmpeg'
            : 'Conversion failed: ' + e.message)));
        ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Conversion failed (code ' + c + ')'))));
    });

    const hasSubs = await new Promise((resolve) => {
        const s = harden(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-i', inputFile, '-map', '0:s:0', path.join(outDir, 'subs.vtt')]));
        s.on('error', () => resolve(false)); // subtitles are optional
        s.on('close', (c) => resolve(c === 0));
    });

    return { duration, hasSubs };
}

// Probe a file that is still being written (progressive upload). Bounded so a
// partial container can never hang the upload; rejects if there isn't enough
// data yet (e.g. an MP4 whose 'moov' atom is at the end of the file).
// Fallback when ffprobe isn't installed: ffmpeg prints the same stream info to
// stderr. Keeps progressive playback working on minimal ffmpeg installs.
function probeWithFfmpeg(file, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        const p = harden(spawn('ffmpeg', ['-hide_banner', '-i', file]));
        let err = '';
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(t); try { p.kill('SIGKILL'); } catch {} fn(arg); } };
        const t = setTimeout(() => done(reject, new Error('probe timeout')), timeoutMs);
        p.stderr.on('data', (d) => (err += d));
        p.on('error', (e) => done(reject, e));
        p.on('close', () => {
            if (settled) return;
            const streams = [];
            const v = err.match(/Stream #\d+:\d+[^\n]*: Video: ([a-zA-Z0-9_]+)/);
            const a = err.match(/Stream #\d+:\d+[^\n]*: Audio: ([a-zA-Z0-9_]+)/);
            if (v) streams.push({ codec_type: 'video', codec_name: v[1] });
            if (a) {
                const ch = err.match(/Audio:[^\n]*?(\d+) channels/);
                streams.push({ codec_type: 'audio', codec_name: a[1], channels: ch ? Number(ch[1]) : 2 });
            }
            if (!streams.length) return done(reject, new Error('probe failed'));
            done(resolve, { streams, format: {} });
        });
    });
}

function probePartial(file, timeoutMs = 12000) {
    return probeWithFfprobe(file, timeoutMs).catch((e) =>
        (e && e.code === 'ENOENT') ? probeWithFfmpeg(file, timeoutMs) : Promise.reject(e));
}

function probeWithFfprobe(file, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        const p = harden(spawn('ffprobe', ['-v', 'error', '-print_format', 'json',
            '-analyzeduration', '5M', '-probesize', '5M',
            '-show_format', '-show_streams', file]));
        let out = '';
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(t); try { p.kill('SIGKILL'); } catch {} fn(arg); } };
        const t = setTimeout(() => done(reject, new Error('probe timeout')), timeoutMs);
        p.stdout.on('data', (d) => (out += d));
        p.on('error', (e) => done(reject, e));
        p.on('close', (c) => {
            if (settled) return;
            if (c !== 0) return done(reject, new Error('probe failed'));
            try { done(resolve, JSON.parse(out)); } catch (e) { done(reject, e); }
        });
    });
}

// Feed media on stdin and emit a growing HLS playlist so viewers can watch
// while the upload is still running. All segments are kept in the playlist
// (hls_list_size 0 + EVENT) so both peers can start at 0 and stay in sync,
// and the playlist later becomes a normal VOD once #EXT-X-ENDLIST is appended.
// Make a spawned ffmpeg safe to run unattended:
//  * Drain stdout/stderr. If nobody reads them the 64 KB OS pipe buffer fills,
//    ffmpeg BLOCKS writing diagnostics, stops consuming stdin, and the upload
//    feeding it stalls forever part-way through.
//  * Absorb stdin errors. Killing ffmpeg (e.g. the user clears the video)
//    makes a pending write emit EPIPE; with no 'error' listener Node treats
//    that as an unhandled error and the whole server process exits.
function harden(child, { onStdout } = {}) {
    try {
        if (child.stdout) {
            child.stdout.on('data', (d) => { if (onStdout) onStdout(d); });
            child.stdout.on('error', () => {});
            child.stdout.resume();
        }
        if (child.stderr) {
            child.stderr.on('data', () => {}); // discard, but keep the pipe flowing
            child.stderr.on('error', () => {});
            child.stderr.resume();
        }
        if (child.stdin) {
            child.stdin.on('error', () => {}); // EPIPE on kill is expected, not fatal
        }
    } catch {}
    return child;
}

function startStreamConvert(outDir, { copyV, copyA }) {
    const args = ['-y', '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0?',
        ...(copyV ? ['-c:v', 'copy']
            : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
               '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=-2:720']),
        ...(copyA ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']),
        '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
        '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
        path.join(outDir, 'index.m3u8')];
    // -nostats/-loglevel error keep the diagnostic volume tiny; harden() still
    // drains the pipes so even a pathological file can never wedge the upload.
    return harden(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', ...args]));
}

module.exports = { convert, probePartial, startStreamConvert };
