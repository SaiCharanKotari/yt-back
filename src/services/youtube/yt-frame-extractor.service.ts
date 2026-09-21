import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { scheduleCleanup } from '../ffmpeg.service.js';

function findCookiesFile(): string | null {
  const candidates = [
    path.join(process.cwd(), 'cookies.txt'),
    path.join(process.cwd(), 'youtube-cookies.txt'),
    path.join(process.cwd(), 'backend', 'cookies.txt'),
    path.join(process.cwd(), '..', 'cookies.txt'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).size > 100) {
      return c;
    }
  }
  return null;
}

const execAsync = promisify(exec);

export interface YouTubeFrameOptions {
  url: string;
  timestamp: number;
  quality?: string;
  format?: 'png' | 'jpg';
  crop?: {
    crop_x?: string | number;
    crop_y?: string | number;
    crop_w?: string | number;
    crop_h?: string | number;
  };
  cacheDir: string;
  ytDlpBin: string;
  ffmpegBin: string;
}

export class YouTubeFrameExtractorService {
  /**
   * Extracts an uncompressed master resolution (4K / 1080p) frame at exact timestamp for YouTube.
   */
  static async extractFrame(options: YouTubeFrameOptions): Promise<{ filePath: string; ext: string; isPng: boolean; fromCache: boolean }> {
    const {
      url,
      timestamp,
      quality = '1080p',
      format = 'png',
      crop,
      cacheDir,
      ytDlpBin,
      ffmpegBin,
    } = options;

    const isPng = format.toLowerCase() === 'png';
    const ext = isPng ? 'png' : 'jpg';

    let heightLimit = 1080;
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

    const cacheKey = `yt_${url}_${timestamp.toFixed(2)}_res_${heightLimit}_${cropFilter}_${ext}`;
    const hash = crypto.createHash('md5').update(cacheKey).digest('hex');
    const framePath = path.join(cacheDir, `frame_${hash}.${ext}`);

    if (fs.existsSync(framePath) && fs.statSync(framePath).size > 1000) {
      return { filePath: framePath, ext, isPng, fromCache: true };
    }

    const vfOption = cropFilter ? `-vf "${cropFilter}"` : '';
    const qOption = isPng ? '' : '-q:v 1';

    // Download small 1.5s segment via native yt-dlp at exact source resolution and extract frame
    const tempSeg = path.join(cacheDir, `seg_${hash}.mp4`);
    const startSec = Math.max(0, timestamp - 0.3);
    const endSec = timestamp + 1.5;
    const cookiesFile = findCookiesFile();
    const cookieFlag = cookiesFile ? `--cookies "${cookiesFile}"` : '';
    const buildFrameCmd = (useCookies: boolean) => [
      `"${ytDlpBin}"`,
      `--ffmpeg-location "${path.dirname(ffmpegBin)}"`,
      '--js-runtimes node',
      '--extractor-args "youtube:player_client=mweb,web"',
      '--no-warnings',
      '--no-check-certificate',
      useCookies && cookiesFile ? `--cookies "${cookiesFile}"` : '',
      '--no-playlist',
      `--download-sections "*${startSec}-${endSec}"`,
      '--force-keyframes-at-cuts',
      `-f "bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]/best"`,
      `--merge-output-format mp4`,
      `-o "${tempSeg}"`,
      `"${url}"`,
    ].filter(Boolean).join(' ');

    try {
      await execAsync(buildFrameCmd(Boolean(cookiesFile)), { timeout: 35000 });
      if (fs.existsSync(tempSeg)) {
        const offsetSeek = Math.max(0, timestamp - startSec);
        await execAsync(`"${ffmpegBin}" -ss ${offsetSeek} -i "${tempSeg}" -frames:v 1 ${qOption} ${vfOption} -y "${framePath}"`);
        scheduleCleanup(tempSeg, 30000);
      }
    } catch (e: any) {
      console.warn('[YouTubeFrameExtractorService] Fast segment extraction warning, retrying without cookies or full fallback:', e.message);
      try {
        await execAsync(buildFrameCmd(false), { timeout: 35000 });
        if (fs.existsSync(tempSeg)) {
          const offsetSeek = Math.max(0, timestamp - startSec);
          await execAsync(`"${ffmpegBin}" -ss ${offsetSeek} -i "${tempSeg}" -frames:v 1 ${qOption} ${vfOption} -y "${framePath}"`);
          scheduleCleanup(tempSeg, 30000);
        }
      } catch (err: any) {
        console.warn('[YouTubeFrameExtractorService] Retry failed:', err.message);
      }
    }

    if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
      scheduleCleanup(framePath, 2 * 60 * 60 * 1000);
      return { filePath: framePath, ext, isPng, fromCache: false };
    }

    throw new Error('Failed to extract high-resolution YouTube frame.');
  }
}
