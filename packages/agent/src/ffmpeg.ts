import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// FFmpeg post-processing on files the extension already saved. Everything runs locally.

function run(bin: string, args: string[], timeoutMs = 15 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20_000)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(new Error(`${bin}: ${e.message}. Install FFmpeg or set FFMPEG_PATH.`));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface Probe {
  durationSec: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  codec?: string;
  bytes: number;
}

export async function probe(ffprobe: string, file: string): Promise<Probe> {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.trim().split('\n').pop()}`);
  const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number; codec_name?: string; duration?: string }[] };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(j.format?.duration ?? v?.duration ?? 0),
    width: v?.width,
    height: v?.height,
    codec: v?.codec_name,
    hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio'),
    bytes: statSync(file).size,
  };
}

/**
 * Joins clips in order. Clips are scaled/padded to the first clip's size and re-encoded, so mixed
 * sources (720p + 1080p, with or without audio) still join cleanly. Silent audio is added where missing.
 */
export async function merge(ffmpeg: string, ffprobe: string, files: string[], output: string, opts: { crossfadeSec?: number; loudnorm?: boolean } = {}) {
  if (files.length < 1) throw new Error('No clips to merge.');
  const probes = await Promise.all(files.map((f) => probe(ffprobe, f)));
  const W = (probes[0].width ?? 1280) & ~1;
  const H = (probes[0].height ?? 720) & ~1;
  mkdirSync(dirname(output), { recursive: true });
  const args: string[] = ['-y'];
  files.forEach((f, i) => {
    args.push('-i', f);
    if (!probes[i].hasAudio) args.push('-f', 'lavfi', '-t', String(probes[i].durationSec || 1), '-i', 'anullsrc=r=48000:cl=stereo');
  });
  let input = 0;
  const parts: string[] = [];
  const labels: string[] = [];
  probes.forEach((p, i) => {
    const vi = input++;
    const ai = p.hasAudio ? vi : input++;
    parts.push(`[${vi}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`);
    parts.push(`[${ai}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${files.length}:v=1:a=1[v][a0]`);
  parts.push(opts.loudnorm ? '[a0]loudnorm=I=-14:TP=-1.5:LRA=11[a]' : '[a0]anull[a]');
  args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output);
  const r = await run(ffmpeg, args);
  if (r.code !== 0) throw new Error(`ffmpeg merge failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return probe(ffprobe, output);
}

/** Saves the final frame of a video as PNG (for continuing a scene from where the last one ended). */
export async function lastFrame(ffmpeg: string, file: string, output: string) {
  mkdirSync(dirname(output), { recursive: true });
  let r = await run(ffmpeg, ['-y', '-sseof', '-0.1', '-i', file, '-frames:v', '1', '-update', '1', output]);
  if (r.code !== 0 || !existsSync(output)) {
    // Very short or oddly muxed clips: reverse (Flow clips are seconds long) and take the first frame.
    r = await run(ffmpeg, ['-y', '-i', file, '-vf', 'reverse', '-frames:v', '1', output]);
  }
  if (r.code !== 0 || !existsSync(output)) throw new Error(`could not extract last frame: ${r.stderr.trim().split('\n').pop()}`);
  return output;
}

/** Images to a video, each shown for `secPerImage`, scaled to fit WxH. */
export async function slideshow(ffmpeg: string, images: string[], output: string, secPerImage = 3, size = '1920x1080') {
  const [W, H] = size.split('x').map(Number);
  const list = join(tmpdir(), `ff-slides-${Date.now()}.txt`);
  writeFileSync(list, images.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration ${secPerImage}`).join('\n') + `\nfile '${images[images.length - 1].replace(/'/g, "'\\''")}'\n`);
  mkdirSync(dirname(output), { recursive: true });
  const r = await run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`, '-c:v', 'libx264', '-crf', '18', output]);
  if (r.code !== 0) throw new Error(`slideshow failed: ${r.stderr.trim().split('\n').pop()}`);
  return output;
}

export async function ffmpegVersion(ffmpeg: string): Promise<string | null> {
  try {
    const r = await run(ffmpeg, ['-version'], 10_000);
    return r.code === 0 ? r.stdout.split('\n')[0] : null;
  } catch {
    return null;
  }
}
