const { spawn } = require('child_process');
const path = require('path');

function probe(file) {
    return new Promise((resolve, reject) => {
        const p = spawn('ffprobe', ['-v', 'error', '-print_format', 'json',
            '-show_format', '-show_streams', file]);
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
        const ff = spawn('ffmpeg', args);
        ff.stdout.on('data', (d) => {
            const all = [...d.toString().matchAll(/out_time_ms=(\d+)/g)];
            if (all.length && duration) {
                const t = Number(all[all.length - 1][1]) / 1e6;
                onProgress(Math.min(99, Math.round((t / duration) * 100)));
            }
        });
        ff.on('error', (e) => reject(new Error(e.code === 'ENOENT'
            ? 'ffmpeg is not installed. In Termux run: pkg install ffmpeg'
            : 'Conversion failed: ' + e.message)));
        ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Conversion failed (code ' + c + ')'))));
    });

    const hasSubs = await new Promise((resolve) => {
        const s = spawn('ffmpeg', ['-y', '-i', inputFile, '-map', '0:s:0', path.join(outDir, 'subs.vtt')]);
        s.on('error', () => resolve(false)); // subtitles are optional
        s.on('close', (c) => resolve(c === 0));
    });

    return { duration, hasSubs };
}

module.exports = { convert };
