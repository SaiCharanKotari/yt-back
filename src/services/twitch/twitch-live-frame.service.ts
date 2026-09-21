/**
 * ============================================================================
 * TWITCH LIVE FRAME SERVICE
 * ============================================================================
 * Extracts exact-frame screenshots directly from cached/generated 5-second
 * live MP4 chunks for Twitch live streams.
 *
 * Guaranteed Flow:
 * 1. Validate Twitch Live Channel URL
 * 2. Calculate/validate: chunkOffset (divisible by 5) & localTime (0 <= t < 5)
 * 3. Retrieve or generate the exact 5s MP4 chunk using TwitchLiveChunkManager
 * 4. Verify chunk duration with FFprobe/FFmpeg
 * 5. Extract frame from MP4 chunk using: -i chunk.mp4 -ss localTime -frames:v 1
 * ============================================================================
 */

import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { scheduleCleanup } from '../ffmpeg.service.js';
import { TwitchStreamResolverService } from './twitch-stream-resolver.service.js';

const execAsync = util.promisify(exec);

function resolveYtDlpBinary(): string {
  const candidates = [
    path.join(process.cwd(), 'backend', 'yt-dlp.exe'),
    path.join(process.cwd(), 'yt-dlp.exe'),
    path.join(process.cwd(), 'backend', 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe'),
    path.join(process.cwd(), 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe'),
    path.join(process.cwd(), 'qt-app', 'bin', 'yt-dlp.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp';
}

function resolveFFmpegBinary(): string {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(process.cwd(), 'backend', 'ffmpeg.exe'),
    path.join(process.cwd(), 'ffmpeg.exe'),
    path.join(process.cwd(), 'qt-app', 'bin', 'ffmpeg.exe'),
    path.join(localAppData, 'Programs', 'ClipFlow', 'bin', 'ffmpeg.exe'),
    path.join(localAppData, 'ClipFlow', 'bin', 'ffmpeg.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

function resolveTempDir(): string {
  const candidates = [
    path.join(process.cwd(), 'temp'),
    path.join(process.cwd(), 'backend', 'temp'),
  ];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) fs.mkdirSync(c, { recursive: true });
      return c;
    } catch {}
  }
  const fallback = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const YTDLP_BIN = resolveYtDlpBinary();
const FFMPEG_BIN = resolveFFmpegBinary();
const LIVE_CHUNKS_DIR = path.join(resolveTempDir(), 'live-chunks');
const LIVE_FRAMES_DIR = path.join(resolveTempDir(), 'live-frames');

if (!fs.existsSync(LIVE_CHUNKS_DIR)) {
  fs.mkdirSync(LIVE_CHUNKS_DIR, { recursive: true });
}
if (!fs.existsSync(LIVE_FRAMES_DIR)) {
  fs.mkdirSync(LIVE_FRAMES_DIR, { recursive: true });
}

// In-flight chunk extractions shared across all chunk and frame requests
const inFlightExtractions = new Map<string, Promise<void>>();

// Prune live frames older than 1 hour
function pruneOldLiveFrames() {
  try {
    if (!fs.existsSync(LIVE_FRAMES_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(LIVE_FRAMES_DIR)) {
      const fp = path.join(LIVE_FRAMES_DIR, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > 60 * 60 * 1000) {
          fs.unlinkSync(fp);
        }
      } catch {}
    }
  } catch {}
}
setInterval(pruneOldLiveFrames, 5 * 60 * 1000);

export interface TwitchLiveCropOptions {
  crop_x?: number | string;
  crop_y?: number | string;
  crop_w?: number | string;
  crop_h?: number | string;
}

export interface TwitchLiveFrameOptions {
  url: string;
  chunkOffset?: number | string;
  localTime?: number | string;
  globalTime?: number | string;
  time?: number | string;
  quality?: string;
  format?: 'png' | 'jpg' | string;
  crop?: TwitchLiveCropOptions;
}

export interface TwitchLiveFrameResult {
  filePath: string;
  ext: 'png' | 'jpg';
  format: 'png' | 'jpg';
  isPng: boolean;
  fromCache: boolean;
  chunkOffset: number;
  localTime: number;
  globalTime: number;
  chunkDuration: number;
}

export class TwitchLiveFrameValidationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'TwitchLiveFrameValidationError';
    this.statusCode = statusCode;
  }
}

export class TwitchLiveFrameService {
  public static readonly LIVE_CHUNKS_DIR = LIVE_CHUNKS_DIR;
  public static readonly LIVE_FRAMES_DIR = LIVE_FRAMES_DIR;

  /**
   * Validates if a target URL is a Twitch live channel URL
   */
  static isLiveChannelUrl(url: string): boolean {
    if (!url || typeof url !== 'string') return false;
    const clean = url.trim().split('?')[0].replace(/\/$/, '');
    return (
      /twitch\.tv\/([a-zA-Z0-9_]+)$/i.test(clean) &&
      !clean.includes('/videos') &&
      !clean.includes('/clip')
    );
  }

  /**
   * Computes the MD5 chunk hash identical to `/api/twitch-live/live-chunk`
   */
  static getChunkHash(targetUrl: string, startTime: number, chunkDuration = 5): string {
    const cleanUrl = targetUrl.trim().split('?')[0].replace(/\/$/, '');
    return crypto.createHash('md5').update(`${cleanUrl}-${startTime}-${chunkDuration}`).digest('hex');
  }

  /**
   * Retrieves an existing cached chunk or fetches/generates the exact 5-second chunk
   */
  static async getOrExtractChunk(
    targetUrl: string,
    startTime: number,
    chunkDuration = 5,
    quality = '720p'
  ): Promise<{ chunkPath: string; isHit: boolean }> {
    const hash = this.getChunkHash(targetUrl, startTime, chunkDuration);
    const outputPath = path.join(LIVE_CHUNKS_DIR, `chunk_${hash}.mp4`);

    // 1. Check disk cache (ensure chunk is recent - within 10 minutes)
    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      const isFresh = Date.now() - stat.mtimeMs < 10 * 60 * 1000;
      if (stat.size > 1000 && isFresh) {
        return { chunkPath: outputPath, isHit: true };
      } else if (!isFresh) {
        try { fs.unlinkSync(outputPath); } catch {}
      }
    }

    // 2. If another request is currently extracting this chunk, join in-flight promise
    if (inFlightExtractions.has(hash)) {
      try {
        await inFlightExtractions.get(hash);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
          return { chunkPath: outputPath, isHit: true };
        }
      } catch {
        // Retry fresh attempt if previous in-flight failed
      }
    }

    const extractionPromise = (async () => {
      // Resolve direct stream URL (prefers active recording DVR VOD to avoid live ads)
      const { streamUrl, sourceType } = await TwitchStreamResolverService.resolveStreamUrl(
        targetUrl,
        YTDLP_BIN,
        quality
      );

      const ffCmd = `"${FFMPEG_BIN}" -y -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 2 -analyzeduration 1000000 -probesize 1000000 -ss ${startTime} -i "${streamUrl}" -t ${chunkDuration} -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy -avoid_negative_ts make_zero -fflags +genpts+discardcorrupt -movflags +faststart -bsf:a aac_adtstoasc "${outputPath}"`;

      const t0 = Date.now();
      try {
        await execAsync(ffCmd, { timeout: 20000 });
      } catch (ffErr: any) {
        console.warn(
          `[Twitch Live Chunk] Fast copy failed (${ffErr.message?.substring(0, 100)}). Trying ultrafast transcode...`
        );
        const transcodeCmd = `"${FFMPEG_BIN}" -y -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 2 -analyzeduration 1000000 -probesize 1000000 -ss ${startTime} -i "${streamUrl}" -t ${chunkDuration} -map 0:v:0 -map 0:a:0? -c:v libx264 -preset ultrafast -crf 26 -c:a aac -b:a 128k -avoid_negative_ts make_zero -fflags +genpts+discardcorrupt -movflags +faststart "${outputPath}"`;
        await execAsync(transcodeCmd, { timeout: 25000 });
      }

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new Error(
          `FFmpeg produced no output for chunk ${startTime}s. Stream may be offline or unavailable at this timestamp.`
        );
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
      const stat = fs.statSync(outputPath);
      console.log(
        `[Twitch Live Chunk] Chunk ready in ${elapsed}s: ${Math.round(stat.size / 1024)}KB`
      );
    })();

    inFlightExtractions.set(hash, extractionPromise);

    try {
      await extractionPromise;
      return { chunkPath: outputPath, isHit: false };
    } catch (err: any) {
      if (fs.existsSync(outputPath)) {
        try { fs.unlinkSync(outputPath); } catch {}
      }
      throw err;
    } finally {
      inFlightExtractions.delete(hash);
    }
  }

  /**
   * Inspects chunk duration using FFmpeg/FFprobe
   */
  static async getChunkDuration(chunkPath: string): Promise<number> {
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`Chunk file not found: ${chunkPath}`);
    }

    try {
      let outputText = '';
      try {
        const { stderr } = await execAsync(`"${FFMPEG_BIN}" -i "${chunkPath}"`);
        outputText = stderr;
      } catch (procErr: any) {
        outputText = procErr.stderr || procErr.stdout || '';
      }

      const match = outputText.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
      if (match) {
        const h = parseFloat(match[1]);
        const m = parseFloat(match[2]);
        const s = parseFloat(match[3]);
        return h * 3600 + m * 60 + s;
      }
    } catch (err: any) {
      console.warn('[Twitch Live Frame] Duration probe error:', err.message);
    }

    // Default 5s fallback if valid chunk file exists
    return 5.0;
  }

  /**
   * Main entry point for extracting exact frame from Twitch LIVE 5-second chunk
   */
  static async extractLiveFrame(opts: TwitchLiveFrameOptions): Promise<TwitchLiveFrameResult> {
    const { url, quality = '720p', format = 'png', crop } = opts;
    const targetUrl = (url || '').trim();

    // 1. Validate Twitch LIVE channel URL
    if (!this.isLiveChannelUrl(targetUrl)) {
      throw new TwitchLiveFrameValidationError(
        'Only live channel URLs are supported. Use /api/twitch for VODs and clips.'
      );
    }

    // 2. Parse and strictly validate timestamps
    let parsedChunkOffset: number;
    let parsedLocalTime: number;
    let parsedGlobalTime: number;

    const rawChunkOffset = opts.chunkOffset !== undefined && opts.chunkOffset !== null && opts.chunkOffset !== ''
      ? parseFloat(String(opts.chunkOffset))
      : undefined;
    const rawLocalTime = opts.localTime !== undefined && opts.localTime !== null && opts.localTime !== ''
      ? parseFloat(String(opts.localTime))
      : undefined;
    const rawGlobalTime = opts.globalTime !== undefined && opts.globalTime !== null && opts.globalTime !== ''
      ? parseFloat(String(opts.globalTime))
      : (opts.time !== undefined && opts.time !== null && opts.time !== '' ? parseFloat(String(opts.time)) : undefined);

    if (rawChunkOffset !== undefined && rawLocalTime !== undefined) {
      parsedChunkOffset = rawChunkOffset;
      parsedLocalTime = rawLocalTime;
      parsedGlobalTime = parsedChunkOffset + parsedLocalTime;

      // If globalTime was also provided, check for alignment
      if (rawGlobalTime !== undefined) {
        if (Math.abs(rawGlobalTime - parsedGlobalTime) > 0.05) {
          throw new TwitchLiveFrameValidationError(
            `Mismatched timestamp parameters: globalTime (${rawGlobalTime}) does not equal chunkOffset (${parsedChunkOffset}) + localTime (${parsedLocalTime})`
          );
        }
      }
    } else if (rawGlobalTime !== undefined) {
      parsedGlobalTime = Math.max(0, rawGlobalTime);
      parsedChunkOffset = Math.floor(parsedGlobalTime / 5) * 5;
      parsedLocalTime = parsedGlobalTime - parsedChunkOffset;
    } else {
      throw new TwitchLiveFrameValidationError(
        'Missing timestamp parameters. Please provide either (chunkOffset and localTime) or (globalTime / time).'
      );
    }

    // Strict validation rules:
    // - chunkOffset >= 0
    // - chunkOffset % 5 === 0
    // - 0 <= localTime < 5
    if (isNaN(parsedChunkOffset) || parsedChunkOffset < 0 || parsedChunkOffset % 5 !== 0) {
      throw new TwitchLiveFrameValidationError(
        `Invalid chunkOffset: ${parsedChunkOffset}. chunkOffset must be a non-negative integer multiple of 5.`
      );
    }

    if (isNaN(parsedLocalTime) || parsedLocalTime < 0 || parsedLocalTime >= 5) {
      throw new TwitchLiveFrameValidationError(
        `Invalid localTime: ${parsedLocalTime}. localTime must be >= 0 and < 5 seconds.`
      );
    }

    const expectedChunk = Math.floor(parsedGlobalTime / 5) * 5;
    const expectedLocal = parsedGlobalTime - expectedChunk;
    if (
      Math.abs(parsedChunkOffset - expectedChunk) > 0.001 ||
      Math.abs(parsedLocalTime - expectedLocal) > 0.01
    ) {
      throw new TwitchLiveFrameValidationError(
        `Mismatched chunk/local time pair: for global ${parsedGlobalTime.toFixed(2)}s, expected chunk ${expectedChunk}s and local ${expectedLocal.toFixed(2)}s, but received chunk ${parsedChunkOffset}s and local ${parsedLocalTime.toFixed(2)}s.`
      );
    }

    // 10. Required Log: Request global=X chunk=Y local=Z
    console.log(
      `[LIVE FRAME] Request global=${parsedGlobalTime.toFixed(2)} chunk=${parsedChunkOffset} local=${parsedLocalTime.toFixed(2)}`
    );

    // 3. Build Crop Filter if defined
    let cropFilter = '';
    if (crop) {
      const { crop_x, crop_y, crop_w, crop_h } = crop;
      const cX = typeof crop_x === 'number' ? crop_x : parseFloat(String(crop_x || '0'));
      const cY = typeof crop_y === 'number' ? crop_y : parseFloat(String(crop_y || '0'));
      const cW = typeof crop_w === 'number' ? crop_w : parseFloat(String(crop_w || '0'));
      const cH = typeof crop_h === 'number' ? crop_h : parseFloat(String(crop_h || '0'));

      if (!isNaN(cW) && !isNaN(cH) && cW > 0 && cH > 0 && (cW < 0.999 || cH < 0.999 || cX > 0.001 || cY > 0.001)) {
        const safeX = isNaN(cX) ? 0 : Math.max(0, Math.min(1 - cW, cX));
        const safeY = isNaN(cY) ? 0 : Math.max(0, Math.min(1 - cH, cY));
        cropFilter = `crop=iw*${cW.toFixed(4)}:ih*${cH.toFixed(4)}:iw*${safeX.toFixed(4)}:ih*${safeY.toFixed(4)}`;
      }
    }

    const isPng = format.toLowerCase() === 'png';
    const ext: 'png' | 'jpg' = isPng ? 'png' : 'jpg';

    // 4. Check live frame cache
    const frameCacheKey = `${targetUrl}_global_${parsedGlobalTime.toFixed(2)}_${ext}_${cropFilter}_${quality}`;
    const frameHash = crypto.createHash('md5').update(frameCacheKey).digest('hex');
    const framePath = path.join(LIVE_FRAMES_DIR, `live_frame_${frameHash}.${ext}`);

    // If frame is already cached, return immediately
    if (fs.existsSync(framePath) && fs.statSync(framePath).size > 1000) {
      console.log(
        `[LIVE FRAME] Frame cache HIT global=${parsedGlobalTime.toFixed(2)}s`
      );
      return {
        filePath: framePath,
        ext,
        format: ext,
        isPng,
        fromCache: true,
        chunkOffset: parsedChunkOffset,
        localTime: parsedLocalTime,
        globalTime: parsedGlobalTime,
        chunkDuration: 5,
      };
    }

    // 5. Resolve stream URL directly (shared single-flight cache)
    console.log(`[LIVE FRAME] Resolving stream for frame @ t=${parsedGlobalTime.toFixed(2)}s...`);
    const { streamUrl } = await TwitchStreamResolverService.resolveStreamUrl(
      targetUrl,
      YTDLP_BIN,
      quality
    );

    // 6. Extract frame directly from HLS stream using FFmpeg without creating intermediate MP4 chunks
    console.log(
      `[LIVE FRAME] Extracting direct frame global=${parsedGlobalTime.toFixed(2)}s from HLS stream`
    );

    const vfParts: string[] = [];
    if (cropFilter) vfParts.push(cropFilter);
    const vfOption = vfParts.length > 0 ? `-vf "${vfParts.join(',')}"` : '';
    const qOption = isPng ? '' : '-q:v 1';

    const extractCmd = `"${FFMPEG_BIN}" -y -ss ${parsedGlobalTime.toFixed(3)} -i "${streamUrl}" -frames:v 1 ${vfOption} ${qOption} "${framePath}"`;

    try {
      await execAsync(extractCmd, { timeout: 20000 });
    } catch (extractErr: any) {
      console.error('[Twitch Live Frame] Extraction error:', extractErr.message);
      throw new Error(`Failed to extract frame at timestamp ${parsedGlobalTime.toFixed(2)}s: ${extractErr.message}`);
    }

    if (!fs.existsSync(framePath) || fs.statSync(framePath).size === 0) {
      throw new Error(
        `FFmpeg produced empty frame at timestamp ${parsedGlobalTime.toFixed(2)}s.`
      );
    }

    console.log(
      `[LIVE FRAME] Frame ready global=${parsedGlobalTime.toFixed(2)}s (file size: ${fs.statSync(framePath).size} bytes)`
    );

    scheduleCleanup(framePath, 2 * 60 * 60 * 1000); // 2 hours

    return {
      filePath: framePath,
      ext,
      format: ext,
      isPng,
      fromCache: false,
      chunkOffset: parsedChunkOffset,
      localTime: parsedLocalTime,
      globalTime: parsedGlobalTime,
      chunkDuration: 5,
    };
  }
}
