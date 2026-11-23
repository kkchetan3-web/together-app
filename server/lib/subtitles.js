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
const { probePartial, TEXT_SUB_CODECS } = require('./convert');

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
            // Multilingual first (an "*.en" model cannot understand Hindi /
            // Korean / Japanese AT ALL), then better model first.
            const rank = (f) => ['large', 'medium', 'small', 'base', 'tiny'].findIndex((p) => f.includes(p));
            const en = (f) => (/\.en[.-]/.test(f) ? 1 : 0);
            files.sort((a, b) => (en(a) - en(b)) || ((rank(a) < 0 ? 9 : rank(a)) - (rank(b) < 0 ? 9 : rank(b))));
            model = path.join(d, files[0]);
            break;
        }
    }
    return model ? { bin, model, englishOnly: /\.en[.-]/.test(path.basename(model)) } : null;
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

// Fast check: does the file carry an ENGLISH text subtitle track? Only that
// is worth reusing -- the user wants English subtitles for every language,
// and the first track of a multi-language movie is usually not English.
// No English track (or no subtitles at all) -> return false and let whisper
// translate the audio to English instead.
async function extractEmbedded(input, outVtt) {
    let eng = -1;
    try {
        const info = await probePartial(input);
        const subs = (info.streams || []).filter((st) => st.codec_type === 'subtitle');
        subs.forEach((st, i) => {
            const lang = String((st.tags && st.tags.language) || '').toLowerCase();
            if (eng < 0 && TEXT_SUB_CODECS.has(st.codec_name) && (lang === 'eng' || lang === 'en')) eng = i;
        });
    } catch { return false; }
    if (eng < 0) return false;
    return runChild('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y',
        '-i', input, '-map', '0:s:' + eng, outVtt])
        .then(() => {
            try { return fs.statSync(outVtt).size > 10; } catch { return false; }
        })
        .catch(() => { fs.unlink(outVtt, () => {}); return false; });
}

// Extract the English text track from a PARTIAL (still-uploading) file.
// ffmpeg stops at the truncation point with a non-zero exit but keeps every
// cue it already wrote — accept the output whenever it holds real cues.
// Returns the VTT text, or false when there is no English text track yet.
async function extractEmbeddedPartial(input, outVtt) {
    let eng = -1;
    try {
        const info = await probePartial(input);
        const subs = (info.streams || []).filter((st) => st.codec_type === 'subtitle');
        subs.forEach((st, i) => {
            const lang = String((st.tags && st.tags.language) || '').toLowerCase();
            if (eng < 0 && TEXT_SUB_CODECS.has(st.codec_name) && (lang === 'eng' || lang === 'en')) eng = i;
        });
    } catch { return false; }
    if (eng < 0) return false;
    await runChild('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y',
        '-err_detect', 'ignore_err', '-i', input, '-map', '0:s:' + eng, '-f', 'webvtt', outVtt]).catch(() => {});
    try {
        const txt = fs.readFileSync(outVtt, 'utf8');
        return txt.includes('-->') ? txt : false;
    } catch { return false; }
}

// Placeholder cues whisper emits when it cannot make out the words
// ("(foreign language)", "[Music]", bare note symbols). They are noise, not
// subtitles -- drop them from the live stream AND the final file.
function isJunkCue(text) {
    const t = (text || '').trim();
    if (!t) return true;
    if (/^[\u266a\u266b\s.*_~-]+$/.test(t)) return true;
    if (/^[\[(][^\])]{0,80}[\])]$/.test(t) &&
        /foreign|language|music|speak|sing|applaus|laugh|inaudible|unintelligible|silence|audio in/i.test(t)) return true;
    return false;
}
function stripJunkCues(vtt) {
    const blocks = vtt.replace(/\r/g, '').split(/\n\n+/);
    const kept = [blocks[0]];
    for (let i = 1; i < blocks.length; i++) {
        const lines = blocks[i].split('\n');
        const ti = lines.findIndex((l) => l.includes('-->'));
        if (ti < 0) { kept.push(blocks[i]); continue; }
        if (!isJunkCue(lines.slice(ti + 1).join(' '))) kept.push(blocks[i]);
    }
    return kept.join('\n\n').trim() + '\n';
}

const TS = /\[(\d+):(\d{2}):(\d{2})[.,]\d{3}\s+-->/;
const SEG = /\[(\d+:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d+:\d{2}:\d{2}[.,]\d{3})\]\s?(.*)/;
// Shift a WebVTT timestamp by `off` seconds (used when transcribing a
// window of a longer movie: whisper's clock starts at 0 for each window).
function shiftTs(ts, off) {
    if (!off) return ts;
    const m = ts.match(/(\d+):(\d{2}):(\d{2})\.(\d{3})/);
    if (!m) return ts;
    let t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 + off;
    const h = Math.floor(t / 3600); t -= h * 3600;
    const mm = Math.floor(t / 60); t -= mm * 60;
    const sec = Math.floor(t);
    const ms = Math.round((t - sec) * 1000);
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
}

// whisper prints h:mm:ss,mmm or hh:mm:ss.mmm depending on build -> WebVTT form
function normTs(t) {
    const m = t.match(/(\d+):(\d{2}):(\d{2})[.,](\d{3})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${m[4]}` : t.replace(',', '.');
}

// Generate subtitles for `input` (any video ffmpeg can read, including an HLS
// playlist) into `outVtt`. Long-running and fully cancellable via `job`.
async function generateSubs(input, outVtt, { duration = 0, onProgress, onSegment, job, window: win } = {}) {
    const w = findWhisper();
    if (!w) { const e = new Error('whisper.cpp is not installed'); e.notInstalled = true; throw e; }
    const wav = outVtt + '.audio.wav';
    const ofBase = outVtt.replace(/\.vtt$/, '');
    const off = win ? Number(win.start) || 0 : 0;
    try {
        // 1) movie -> mono 16 kHz wav (what whisper expects). ~110 MB per hour.
        //    In window mode only [start, start+length) is extracted, which is
        //    what lets subtitles run chunk-by-chunk WHILE a movie uploads.
        await runChild('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostats', '-y',
            ...(win ? ['-ss', String(off)] : []), '-i', input, ...(win ? ['-t', String(win.length)] : []),
            '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { job });
        if (job && job.cancelled) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
        // 2) speech -> ENGLISH text. -tr is whisper's translate task: Japanese,
        //    Hindi, anything -> English; English stays English. Disable only
        //    with TOGETHER_SUBS_TRANSLATE=0 (original-language transcription).
        //    -pp prints "progress = N%"; each finished line is also printed as
        //    "[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text", which we stream to the
        //    caller so subtitles can appear on screen WHILE generation runs.
        const threads = Math.max(2, Math.min(8, os.cpus().length));
        const translate = process.env.TOGETHER_SUBS_TRANSLATE !== '0';
        // Decoding: pure greedy (-bo 1 -bs 1) is fastest but makes the
        // translate task hallucinate "[foreign language]" placeholders, so
        // translation keeps a small beam (-bs 2, still ~2x faster than the
        // default 5). TOGETHER_SUBS_FAST=0 restores full-accuracy decoding.
        const fast = process.env.TOGETHER_SUBS_FAST !== '0';
        const decode = !fast ? [] : (translate ? ['-bo', '2', '-bs', '2'] : ['-bo', '1', '-bs', '1']);
        await runChild(w.bin, ['-m', w.model, '-f', wav, '-ovtt', '-of', ofBase,
            '-l', process.env.TOGETHER_SUBS_LANG || 'auto', ...(translate ? ['-tr'] : []),
            ...decode,
            '-t', String(threads), '-pp'], {
            job,
            onLine: (line) => {
                const seg = line.match(SEG);
                if (seg && onSegment) {
                    const text = seg[3].trim();
                    if (text && !isJunkCue(text)) onSegment({ start: shiftTs(normTs(seg[1]), off), end: shiftTs(normTs(seg[2]), off), text });
                }
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
        let clean = null;
        try { clean = stripJunkCues(fs.readFileSync(outVtt, 'utf8')); fs.writeFileSync(outVtt, clean); } catch {}
        if (clean !== null && !clean.includes('-->')) {
            throw new Error('only "[foreign language]" placeholders were produced -- this whisper model cannot understand the audio; install a multilingual model (e.g. ggml-small.bin)');
        }
        return true;
    } catch (e) {
        fs.unlink(outVtt, () => {}); // never leave a half-written track behind
        throw e;
    } finally {
        fs.unlink(wav, () => {});
    }
}

module.exports = { findWhisper, subtitlesAvailable, extractEmbedded, extractEmbeddedPartial, generateSubs, isJunkCue, stripJunkCues };
