import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { scheduleCleanup } from './ffmpeg.service.js';
import { YouTubeFrameExtractorService } from './youtube/index.js';

const execAsync = promisify(exec);

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

function resolveFfmpegBinary(): string {
  const candidates = [
    path.join(process.cwd(), 'backend', 'ffmpeg.exe'),
    path.join(process.cwd(), 'ffmpeg.exe'),
    path.join(process.cwd(), 'qt-app', 'bin', 'ffmpeg.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

const YTDLP_BIN = resolveYtDlpBinary();
const FFMPEG_BIN = resolveFfmpegBinary();
const TEMP_DIR = path.join(process.cwd(), 'temp');
const CACHE_DIR = path.join(TEMP_DIR, 'frames');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export interface CropOptions {
  crop_x?: number | string;
  crop_y?: number | string;
  crop_w?: number | string;
  crop_h?: number | string;
}

export interface FrameExtractOptions {
  targetUrl: string;
  timestamp: number;
  isFullRes?: boolean;
  format?: 'png' | 'jpg';
  quality?: string;
  crop?: CropOptions;
  streamUrl?: string;
}

export interface FrameExtractResult {
  filePath: string;
  ext: string;
  isPng: boolean;
  fromCache: boolean;
}

export class FrameExtractorService {
  /**
   * Extracts the maximum source resolution frame at exact timestamp.
   */
  static async extractMaxQualityFrame(opts: FrameExtractOptions): Promise<FrameExtractResult> {
    const { targetUrl, timestamp, isFullRes = true, format = 'png', quality = '2160p', crop, streamUrl } = opts;
    const isPng = format.toLowerCase() === 'png';
    const ext = isPng ? 'png' : 'jpg';

    // Dedicated YouTube Handler
    if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
      return YouTubeFrameExtractorService.extractFrame({
        url: targetUrl,
        timestamp,
        quality,
        format: isPng ? 'png' : 'jpg',
        crop,
        cacheDir: CACHE_DIR,
        ytDlpBin: YTDLP_BIN,
        ffmpegBin: FFMPEG_BIN,
      });
    }

    // Parse requested quality height limit (e.g. 2160p, 1440p, 1080p, 720p)
    let heightLimit = 2160;
    if (quality && quality.toLowerCase() !== 'best' && quality.toLowerCase() !== 'max') {
      const cleanQ = quality.toLowerCase().replace('p', '');
      if (cleanQ === '4k' || cleanQ === '2160') heightLimit = 2160;
      else if (cleanQ === '1440' || cleanQ === '2k') heightLimit = 1440;
      else if (cleanQ === '1080') heightLimit = 1080;
      else if (cleanQ === '720') heightLimit = 720;
      else if (cleanQ === '480') heightLimit = 480;
      else if (cleanQ === '360') heightLimit = 360;
      else if (cleanQ === '240') heightLimit = 240;
      else if (!isNaN(Number(cleanQ))) heightLimit = Number(cleanQ);
    }

    // 1. Build Crop Filter if defined
    let cropFilter = '';
    if (crop) {
      const { crop_x, crop_y, crop_w, crop_h } = crop;
      const cX = typeof crop_x === 'number' ? crop_x : parseFloat(crop_x || '0');
      const cY = typeof crop_y === 'number' ? crop_y : parseFloat(crop_y || '0');
      const cW = typeof crop_w === 'number' ? crop_w : parseFloat(crop_w || '0');
      const cH = typeof crop_h === 'number' ? crop_h : parseFloat(crop_h || '0');

      if (!isNaN(cW) && !isNaN(cH) && cW > 0 && cH > 0 && (cW < 0.999 || cH < 0.999 || cX > 0.001 || cY > 0.001)) {
        const safeX = isNaN(cX) ? 0 : Math.max(0, Math.min(1 - cW, cX));
        const safeY = isNaN(cY) ? 0 : Math.max(0, Math.min(1 - cH, cY));
        cropFilter = `crop=iw*${cW.toFixed(4)}:ih*${cH.toFixed(4)}:iw*${safeX.toFixed(4)}:ih*${safeY.toFixed(4)}`;
      }
    }

    // 2. Check local disk cache
    const cacheKey = `${targetUrl}_${timestamp.toFixed(2)}_${isFullRes ? `res_${heightLimit}` : 'preview'}_${cropFilter}_${ext}`;
    const hash = crypto.createHash('md5').update(cacheKey).digest('hex');
    const framePath = path.join(CACHE_DIR, `frame_${hash}.${ext}`);

    if (fs.existsSync(framePath) && fs.statSync(framePath).size > 1000) {
      return { filePath: framePath, ext, isPng, fromCache: true };
    }

    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    const vfParts: string[] = [];
    if (cropFilter) vfParts.push(cropFilter);
    if (!isFullRes) vfParts.push('scale=1280:-1');

    const vfOption = vfParts.length > 0 ? `-vf "${vfParts.join(',')}"` : '';
    const qOption = isPng ? '' : '-q:v 1';

    // 3. Resolve Master Stream URL
    let directUrl = streamUrl;
    if (!directUrl || isFullRes) {
      try {
        const formatSelector = isFullRes ? `bestvideo[height<=${heightLimit}]/bestvideo/best` : 'best[height<=720]/best';
        const getStreamCmd = `"${YTDLP_BIN}" --js-runtimes node --ffmpeg-location "${FFMPEG_BIN}" --get-url --no-warnings --no-check-certificate -f "${formatSelector}" "${targetUrl}"`;

        const { stdout } = await execAsync(getStreamCmd, { timeout: 15000 });
        const resolved = stdout.trim().split('\n').filter(Boolean)[0]?.trim();
        if (resolved) {
          directUrl = resolved;
        }
      } catch (e: any) {
        console.warn('[FrameExtractorService] Master stream resolution warning:', e.message);
        if (!directUrl) directUrl = streamUrl;
      }
    }

    // 4. Extract frame via FFmpeg directly from master stream URL (for non-YouTube direct streams like Twitch/Twitter/Direct)
    if (directUrl && !targetUrl.includes('youtube.com') && !targetUrl.includes('youtu.be')) {
      const coarseSeek = Math.max(0, timestamp - 4);
      const fineSeek = timestamp - coarseSeek;
      const opts: string[] = [
        '-reconnect 1',
        '-reconnect_streamed 1',
        '-reconnect_delay_max 5',
        `-headers "User-Agent: ${userAgent}\r\n"`,
        `-ss ${coarseSeek}`,
        `-i "${directUrl}"`,
        `-ss ${fineSeek}`,
        '-frames:v 1',
      ];
      if (qOption) opts.push(qOption);
      if (vfOption) opts.push(vfOption);
      opts.push('-y', `"${framePath}"`);

      const extractCmd = `"${FFMPEG_BIN}" ${opts.join(' ')}`;

      try {
        await execAsync(extractCmd, { timeout: 15000 });
      } catch (ffErr: any) {
        console.warn('[FrameExtractorService] Direct stream extraction fallback to yt-dlp:', ffErr.message);
      }
    }

    // 5. Fallback & YouTube Extraction: Download a small 1-second segment at FULL 4K/1080p source resolution via yt-dlp and extract frame
    if (!fs.existsSync(framePath) || fs.statSync(framePath).size === 0) {
      const tempSeg = path.join(CACHE_DIR, `seg_${hash}.mp4`);
      const startSec = Math.max(0, timestamp - 0.2);
      const endSec = timestamp + 1.2;
      const formatSelector = isFullRes ? `bestvideo[height<=${heightLimit}]/bestvideo/best` : 'best[height<=720]/best';
      const ytDlpCmd = `"${YTDLP_BIN}" --js-runtimes node --ffmpeg-location "${FFMPEG_BIN}" --no-playlist --download-sections "*${startSec}-${endSec}" --force-keyframes-at-cuts -f "${formatSelector}" -o "${tempSeg}" "${targetUrl}"`;

      try {
        await execAsync(ytDlpCmd, { timeout: 35000 });
        if (fs.existsSync(tempSeg)) {
          const offsetSeek = Math.max(0, timestamp - startSec);
          await execAsync(`"${FFMPEG_BIN}" -ss ${offsetSeek} -i "${tempSeg}" -frames:v 1 ${qOption} ${vfOption} -y "${framePath}"`);
          scheduleCleanup(tempSeg, 30000);
        }
      } catch (segErr: any) {
        console.error('[FrameExtractorService] Fallback segment extraction error:', segErr.message);
      }
    }

    if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
      scheduleCleanup(framePath, 2 * 60 * 60 * 1000); // 2 hours
      return { filePath: framePath, ext, isPng, fromCache: false };
    }

    throw new Error('High-quality frame extraction failed to produce an image.');
  }
}
