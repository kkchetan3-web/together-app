// Automatic subtitles.
//
// Policy (what the user asked for): when a movie is uploaded, first check if
// it CAME with subtitles -- if yes, use those. Only when the file has none do
// we generate them ourselves, locally, with whisper.cpp (free offline
// speech-to-text that runs fine in Termux). No cloud services, no API keys;
// the server does the work so subtitles appear for both viewers.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function firstExisting(cands) {
    for (const c of cands) {
        try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
    }
    return null;
}

// Locate the whisper.cpp binary + a ggml model. Overridable via env
// (TOGETHER_WHISPER_BIN / TOGETHER_WHISPER_MODEL); otherwise the standard
// Termux build location ~/whisper.cpp is scanned.
function findWhisper() {
    const envBin = process.env.TOGETHER_WHISPER_BIN;
    const bin = (envBin && fs.existsSync(envBin)) ? envBin : firstExisting([
        path.join(os.homedir(), 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
        path.join(os.homedir(), 'whisper.cpp', 'build', 'bin', 'main'),
        path.join(os.homedir(), 'whisper.cpp', 'main'),
    ]);
    if (!bin) return null;
    let model = process.env.TOGETHER_WHISPER_MODEL;
    if (!model || !fs.existsSync(model)) {
        model = null;
        const dirs = [path.join(os.homedir(), 'whisper.cpp', 'models')];
        for (const d of dirs) {
            let files = [];
            try { files = fs.readdirSync(d).filter((f) => /^ggml-.*\.bin$/.test(f)); } catch { continue; }
            if (!files.length) continue;
            // Better model first when several are installed.
            const rank = (f) => ['large', 'medium', 'small', 'base', 'tiny'].findIndex((p) => f.includes(p));
            files.sort((a, b) => { const ra = rank(a), rb = rank(b); return (ra < 0 ? 9 : ra) - (rb < 0 ? 9 : rb); });
            model = path.join(d, files[0]);
            break;
        }
    }
    return model ? { bin, model } : null;
}
const subtitlesAvailable = () => !!findWhisper();

// Spawn with drained pipes (an undrained pipe deadlocked us before -- see
// harden() in convert.js) and a cancel token: job.kill() SIGKILLs the child,
// job.cancelled turns the resulting non-zero exit into a quiet 'cancelled'.
function runChild(cmd, args, { job, onLine } = {}) {
    return new Promise((resolve, reject) => {
        const c = spawn(cmd, args);
        let buf = '';
        const feed = (d) => {
            if (!onLine) return;
            buf += d.toString();
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { try { onLine(buf.slice(0, i)); } catch {} buf = buf.slice(i + 1); }
            if (buf.length > 8192) buf = buf.slice(-4096);
        };
        c.stdout.on('data', feed);
        c.stderr.on('data', feed);
        if (c.stdin) c.stdin.on('error', () => {});
        if (job) job.kill = () => { try { c.kill('SIGKILL'); } catch {} };
        c.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(path.basename(cmd) + ' is not installed') : e));
        c.on('close', (code) => {
            if (job) job.kill = null;
            if (job && job.cancelled) { const e = new Error('cancelled'); e.cancelled = true; return reject(e); }
            return code === 0 ? resolve() : reject(new Error(path.basename(cmd) + ' failed (code ' + code + ')'));
        });
    });
}

// Fast check: does the file carry its own subtitle track? Extracting is a
// cheap remux, so always try this before spending hours on generation.
function extractEmbedded(input, outVtt) {
    return runChild('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y',
        '-i', input, '-map', '0:s:0', outVtt])
        .then(() => {
            try { return fs.statSync(outVtt).size > 10; } catch { return false; }
        })
        .catch(() => { fs.unlink(outVtt, () => {}); return false; });
}

const TS = /\[(\d+):(\d{2}):(\d{2})[.,]\d{3}\s+-->/;

// Generate subtitles for `input` (any video ffmpeg can read, including an HLS
// playlist) into `outVtt`. Long-running and fully cancellable via `job`.
async function generateSubs(input, outVtt, { duration = 0, onProgress, job } = {}) {
    const w = findWhisper();
    if (!w) { const e = new Error('whisper.cpp is not installed'); e.notInstalled = true; throw e; }
    const wav = outVtt + '.audio.wav';
    const ofBase = outVtt.replace(/\.vtt$/, '');
    try {
        // 1) movie -> mono 16 kHz wav (what whisper expects). ~110 MB per hour.
        await runChild('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y',
            '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { job });
        if (job && job.cancelled) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
        // 2) speech -> text. -pp prints "progress = N%"; older builds only
        //    print per-segment timestamps, so parse both.
        const threads = Math.max(2, Math.min(8, os.cpus().length));
        await runChild(w.bin, ['-m', w.model, '-f', wav, '-ovtt', '-of', ofBase,
            '-l', process.env.TOGETHER_SUBS_LANG || 'auto', '-t', String(threads), '-pp'], {
            job,
            onLine: (line) => {
                if (!onProgress) return;
                const pm = line.match(/progress\s*=\s*(\d+)%/);
                if (pm) return onProgress(Math.min(99, Number(pm[1])));
                const tm = line.match(TS);
                if (tm && duration) {
                    const sec = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]);
                    onProgress(Math.min(99, Math.round((sec / duration) * 100)));
                }
            },
        });
        let ok = false;
        try { ok = fs.statSync(outVtt).size > 10; } catch {}
        if (!ok) throw new Error('whisper produced no subtitles');
        return true;
    } catch (e) {
        fs.unlink(outVtt, () => {}); // never leave a half-written track behind
        throw e;
    } finally {
        fs.unlink(wav, () => {});
    }
}

module.exports = { findWhisper, subtitlesAvailable, extractEmbedded, generateSubs };
