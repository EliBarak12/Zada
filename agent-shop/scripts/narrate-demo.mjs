// Voices demo/timeline.json over demo/zada-demo.webm with Piper TTS and
// writes demo/zada-demo-narrated.mp4 (H.264 + AAC — plays anywhere).
//
//   pip install piper-tts      # + a voice from github.com/rhasspy/piper (VOICES.md)
//   PIPER_VOICE=/path/to/voice.onnx node scripts/narrate-demo.mjs
// Requires ffmpeg + ffprobe on PATH. Run scripts/record-demo.mjs first.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('demo');
const VOICE = process.env.PIPER_VOICE;
if (!VOICE) { console.error('PIPER_VOICE=/path/to/voice.onnx is required'); process.exit(1); }
const timeline = JSON.parse(fs.readFileSync(path.join(DIR, 'timeline.json'), 'utf8'));
const src = ['zada-demo.webm', 'zada-demo.mp4'].map((f) => path.join(DIR, f)).find((f) => fs.existsSync(f));
if (!src) { console.error('no demo/zada-demo.webm — run scripts/record-demo.mjs first'); process.exit(1); }

const probe = (f) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', f]).toString());

// Make caption text speakable.
const spoken = (t) => t
  .replace(/♥/g, '')
  .replace(/WebMCP/g, 'Web M C P')
  .replace(/\bMCP\b/g, 'M C P')
  .replace(/₪\s?(\d+)/g, '$1 shekels')
  .replace(/\s[—–]\s/g, ', ')
  .replace(/[—–]/g, ', ')
  .replace(/·/g, ',')
  .replace(/[“”]/g, '"')
  .replace(/’/g, "'")
  .replace(/→/g, ' to ')
  .replace(/\s+/g, ' ')
  .trim();

const videoDur = probe(src);
const clips = timeline.map((c, i) => {
  const wav = path.join(DIR, `nar-${i}.wav`);
  const r = spawnSync('piper', ['-m', VOICE, '-f', wav], { input: spoken(c.text) });
  if (r.status !== 0) throw new Error(`piper failed on caption ${i}: ${r.stderr}`);
  return { ...c, wav, dur: probe(wav) };
});

// Build the narration as one concatenated track: silence gaps + voiced
// lines, each line fitted into its slot (until the next caption appears):
// sped up a little if it would run over, never slowed down.
const FMT = 'aformat=sample_fmts=s16:sample_rates=22050:channel_layouts=mono';
const filters = [];
const order = [];
let cursor = 0; // seconds
let gaps = 0;
const gap = (dur) => { filters.push(`aevalsrc=0:d=${dur.toFixed(3)}:s=22050:c=mono,${FMT}[g${gaps}]`); order.push(`[g${gaps++}]`); };
clips.forEach((c, i) => {
  const start = c.at / 1000;
  const slotEnd = (clips[i + 1]?.at ?? videoDur * 1000) / 1000;
  const slot = Math.max(1, slotEnd - start - 0.25);
  const tempo = Math.min(1.35, Math.max(1, c.dur / slot));
  if (start - cursor > 0.01) gap(start - cursor);
  filters.push(`[${i + 1}:a]atempo=${tempo.toFixed(3)},${FMT}[c${i}]`);
  order.push(`[c${i}]`);
  cursor = Math.max(start, cursor) + c.dur / tempo;
});
if (videoDur - cursor > 0.01) gap(videoDur - cursor);
filters.push(`${order.join('')}concat=n=${order.length}:v=0:a=1[mix]`);

const out = path.join(DIR, 'zada-demo-narrated.mp4');
execFileSync('ffmpeg', [
  '-y', '-i', src, ...clips.flatMap((c) => ['-i', c.wav]),
  '-filter_complex', filters.join(';'),
  '-map', '0:v', '-map', '[mix]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:-2',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
], { stdio: ['ignore', 'ignore', 'inherit'] });
for (const c of clips) fs.rmSync(c.wav, { force: true });
console.log('narrated:', out, `${(fs.statSync(out).size / 1e6).toFixed(1)}MB · ${clips.length} lines · video ${videoDur.toFixed(1)}s`);
