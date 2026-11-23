const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ISO-639 -> display name used for the NAME= attribute of audio renditions.
const AUDIO_LANG_NAMES = { hin: 'Hindi', eng: 'English', kor: 'Korean', jpn: 'Japanese',
    tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', kan: 'Kannada', ben: 'Bengali',
    mar: 'Marathi', urd: 'Urdu', pan: 'Punjabi', guj: 'Gujarati', spa: 'Spanish',
    fra: 'French', fre: 'French', deu: 'German', ger: 'German', ita: 'Italian',
    rus: 'Russian', zho: 'Chinese', chi: 'Chinese', por: 'Portuguese', ara: 'Arabic',
    tha: 'Thai', vie: 'Vietnamese', ind: 'Indonesian', tur: 'Turkish' };

// Subtitle codecs that are TEXT and can be converted to WebVTT.
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

function probe(file) {
    // Some minimal ffmpeg installs ship without ffprobe; fall back to parsing
    // `ffmpeg -i` (same trick probePartial already uses for live playback).
    return probeJson(file).catch((e) =>
        /ffprobe is not installed/.test(e.message) ? probeWithFfmpeg(file) : Promise.reject(e));
}
function probeJson(file) {
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

// `job` (optional) makes the conversion cancellable mid-flight: the caller may
// set job.cancelled=true and invoke job.kill() at any moment (that is what
// "delete while a 500 MB file is still converting" does). Without it the
// ffmpeg ran to completion no matter what and re-announced the "deleted" file.
async function convert(inputFile, outDir, onProgress, job) {
    const isCancelled = () => !!(job && job.cancelled);
    const bail = () => { const e = new Error('Conversion cancelled'); e.cancelled = true; return e; };
    if (isCancelled()) throw bail();
    const info = await probe(inputFile);
    if (isCancelled()) throw bail();
    const v = info.streams.find((s) => s.codec_type === 'video');
    const auds = info.streams.filter((s) => s.codec_type === 'audio');
    const a = auds[0];
    if (!v) throw new Error('No video found in this file');

    const duration = parseFloat(info.format.duration) || 0;
    const copyV = v.codec_name === 'h264' && v.pix_fmt === 'yuv420p';
    const copyA = a && a.codec_name === 'aac' && a.channels <= 2;
    const multi = auds.length > 1;

    console.log(`Video: ${copyV ? 'COPY (fast)' : 'RE-ENCODE (slow)'} | Audio: ${multi ? auds.length + ' tracks' : (copyA ? 'copy' : 'convert')}`);

    let args;
    if (!multi) {
        args = ['-y', '-i', inputFile, '-map', '0:v:0', '-map', '0:a:0?',
            ...(copyV ? ['-c:v', 'copy']
                : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
            ...(copyA ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']),
            '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod',
            '-hls_segment_filename', path.join(outDir, 'seg_%04d.ts'),
            '-progress', 'pipe:1', '-nostats',
            path.join(outDir, 'index.m3u8')];
    } else {
        // Movie dubbed in several languages: keep EVERY audio track as an
        // HLS alternate rendition (one audio group), so each viewer picks
        // their language in the player -- Hindi for one, English for the
        // other -- without a re-upload.
        // Variant 0 = video, variants 1..N = one per audio track. The master
        // playlist is written by US after ffmpeg finishes: older ffmpeg
        // builds either reject name:/language:/default: keyvals or write an
        // empty master, and hand-writing it is deterministic everywhere.
        const maps = ['-map', '0:v:0'];
        const codecs = [];
        const vsm = ['v:0'];
        auds.forEach((st, i) => {
            maps.push('-map', '0:a:' + i);
            const copy = st.codec_name === 'aac' && (st.channels || 2) <= 2;
            if (copy) codecs.push('-c:a:' + i, 'copy');
            else codecs.push('-c:a:' + i, 'aac', '-b:a:' + i, '128k', '-ac:a:' + i, '2');
            vsm.push('a:' + i);
        });
        args = ['-y', '-i', inputFile, ...maps,
            ...(copyV ? ['-c:v', 'copy']
                : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
            ...codecs,
            '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod',
            '-var_stream_map', vsm.join(' '),
            '-hls_segment_filename', path.join(outDir, 'seg_%v_%05d.ts'),
            '-progress', 'pipe:1', '-nostats',
            path.join(outDir, 'index_%v.m3u8')];
    }

    await new Promise((resolve, reject) => {
        const ff = harden(spawn('ffmpeg', args), { onStdout: (d) => {
            const all = [...d.toString().matchAll(/out_time_ms=(\d+)/g)];
            if (all.length && duration) {
                const t = Number(all[all.length - 1][1]) / 1e6;
                onProgress(Math.min(99, Math.round((t / duration) * 100)));
            }
        } });
        if (job) job.kill = () => { try { ff.kill('SIGKILL'); } catch {} };
        ff.on('error', (e) => reject(new Error(e.code === 'ENOENT'
            ? 'ffmpeg is not installed. In Termux run: pkg install ffmpeg'
            : 'Conversion failed: ' + e.message)));
        ff.on('close', (c) => {
            if (job) job.kill = null;
            if (isCancelled()) return reject(bail()); // killed on purpose: not an error
            return c === 0 ? resolve() : reject(new Error('Conversion failed (code ' + c + ')'));
        });
    });
    if (isCancelled()) throw bail();

    if (multi) {
        // Hand-written master playlist: audio renditions with readable names
        // and language tags, video variant bound to the group.
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
        auds.forEach((st, i) => {
            const lang = String((st.tags && st.tags.language) || '').toLowerCase().replace(/[^a-z]/g, '');
            const nm = AUDIO_LANG_NAMES[lang] || ('Audio ' + (i + 1));
            lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="' + nm + '"'
                + (/^[a-z]{2,3}$/.test(lang) ? ',LANGUAGE="' + lang + '"' : '')
                + ',DEFAULT=' + (i === 0 ? 'YES' : 'NO') + ',AUTOSELECT=YES,URI="index_' + (i + 1) + '.m3u8"');
        });
        lines.push('#EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO="aud"');
        lines.push('index_0.m3u8');
        fs.writeFileSync(path.join(outDir, 'master.m3u8'), lines.join('\n') + '\n');
    }

    // Reuse embedded subtitles ONLY when the movie carries an ENGLISH text
    // track. The first subtitle track of a multi-language movie is usually
    // NOT English (and bitmap tracks cannot become VTT at all) -- grabbing
    // 0:s:0 blindly gave wrong-language or broken subtitles. Anything other
    // than a labeled English text track falls through to whisper, which
    // translates EVERY language to English.
    const subStreams = info.streams.filter((st) => st.codec_type === 'subtitle');
    let engSub = -1;
    subStreams.forEach((st, i) => {
        const lang = String((st.tags && st.tags.language) || '').toLowerCase();
        if (engSub < 0 && TEXT_SUB_CODECS.has(st.codec_name) && (lang === 'eng' || lang === 'en')) engSub = i;
    });
    const hasSubs = engSub < 0 ? false : await new Promise((resolve) => {
        const s = harden(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-i', inputFile, '-map', '0:s:' + engSub, path.join(outDir, 'subs.vtt')]));
        if (job) job.kill = () => { try { s.kill('SIGKILL'); } catch {} };
        s.on('error', () => resolve(false)); // subtitles are optional
        s.on('close', (c) => { if (job) job.kill = null; resolve(c === 0); });
    });
    if (isCancelled()) throw bail();

    return { duration, hasSubs, playlist: multi ? 'master.m3u8' : 'index.m3u8', audioTracks: auds.length };
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
            const v = err.match(/Stream #\d+:\d+[^\n]*: Video: ([a-zA-Z0-9_]+)([^\n]*)/);
            if (v) {
                const pix = (v[2] || '').match(/\b(yuv[a-z0-9]+|nv\d+|rgb[a-z0-9]*|bgr[a-z0-9]*)\b/);
                streams.push({ codec_type: 'video', codec_name: v[1], pix_fmt: pix ? pix[1] : undefined });
            }
            for (const m of err.matchAll(/Stream #\d+:\d+(?:\((\w+)\))?[^\n]*?: Audio: ([a-zA-Z0-9_]+)([^\n]*)/g)) {
                const line = m[3] || '';
                const chm = line.match(/(\d+)\s*channels/);
                const channels = chm ? Number(chm[1]) : (/mono/.test(line) ? 1 : /stereo/.test(line) ? 2 : 6);
                streams.push({ codec_type: 'audio', codec_name: m[2], channels,
                    tags: m[1] ? { language: m[1] } : undefined });
            }
            for (const m of err.matchAll(/Stream #\d+:\d+(?:\((\w+)\))?[^\n]*?: Subtitle: ([a-zA-Z0-9_]+)/g)) {
                streams.push({ codec_type: 'subtitle', codec_name: m[2],
                    tags: m[1] ? { language: m[1] } : undefined });
            }
            if (!streams.length) return done(reject, new Error('probe failed'));
            const d = err.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
            const duration = d ? String(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) : undefined;
            done(resolve, { streams, format: { duration } });
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

module.exports = { convert, probePartial, startStreamConvert, TEXT_SUB_CODECS };
