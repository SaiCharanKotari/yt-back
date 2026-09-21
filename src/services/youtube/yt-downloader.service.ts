import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getFFmpegAspectFilter } from '../video-crop.service.js';

/**
 * Looks for a YouTube cookies.txt file in common locations relative to the backend binary.
 * The cookies.txt must be in Netscape/Mozilla format (exported via browser extension).
 * Place it at: backend/cookies.txt
 */
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

function formatSecondsToTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const ms = Math.floor((seconds % 1) * 1000);
  if (ms > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

const execAsync = promisify(exec);

export interface YouTubeDownloadOptions {
  url: string;
  format?: string;
  quality?: string;
  audioQuality?: string | number;
  trimStart?: number;
  trimEnd?: number;
  aspectRatio?: string;
  fitMode?: 'crop' | 'pad';
  cropPosition?: string;
  cropBox?: any;
  tempRawFile: string;
  finalFile: string;
  ytDlpBin: string;
  ffmpegBin: string;
  onProgress?: (phase: string, percent?: number, speed?: string) => void;
}

export class YouTubeDownloaderService {
  /**
   * Parse quality string (e.g. '2160p', '4k', '1440p', '1080p', '720p') into height limit
   */
  static parseHeightLimit(quality?: string): number | null {
    if (!quality || quality.toLowerCase() === 'best' || quality.toLowerCase() === 'max') {
      return null;
    }
    const cleanQ = quality.toLowerCase().replace('p', '');
    if (cleanQ === '4k' || cleanQ === '2160') return 2160;
    if (cleanQ === '1440' || cleanQ === '2k') return 1440;
    if (cleanQ === '1080') return 1080;
    if (cleanQ === '720') return 720;
    if (cleanQ === '480') return 480;
    if (cleanQ === '360') return 360;
    if (cleanQ === '240') return 240;
    const num = Number(cleanQ);
    return !isNaN(num) && num > 0 ? num : null;
  }

  /**
   * Downloads a YouTube video or audio clip at exact requested resolution (4K, 2K, 1080p, etc.)
   * directly clipping the requested time slice without ever downloading the full video.
   */
  static async downloadClip(options: YouTubeDownloadOptions): Promise<string> {
    const {
      url,
      format = 'mp4',
      quality = '1080p',
      audioQuality = '0',
      trimStart = 0,
      trimEnd,
      aspectRatio,
      fitMode = 'pad',
      cropPosition = 'center',
      cropBox,
      tempRawFile,
      finalFile,
      ytDlpBin,
      ffmpegBin,
      onProgress,
    } = options;

    const isAudio = format === 'mp3' || format === 'wav' || format === 'm4a' || format === 'aac';
    const isTrimmed = typeof trimEnd === 'number' && trimEnd > trimStart;
    const filterString = !isAudio ? getFFmpegAspectFilter(aspectRatio as any, fitMode, cropPosition as any, cropBox) : '';
    const needsCrop = !isAudio && Boolean(filterString);
    const heightLimit = this.parseHeightLimit(quality);

    const cookiesFile = findCookiesFile();
    const rawTarget = needsCrop ? tempRawFile : finalFile;

    // Clean up any stale files from previous attempts
    try {
      if (fs.existsSync(rawTarget)) fs.unlinkSync(rawTarget);
      if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile);
      if (fs.existsSync(tempRawFile)) fs.unlinkSync(tempRawFile);
    } catch (_) {}

    const startTimeStr = formatSecondsToTime(trimStart);
    const endTimeStr = isTrimmed && trimEnd ? formatSecondsToTime(trimEnd) : '';

    const buildArgs = (useCookies: boolean): string[] => {
      const args: string[] = [
        `"${ytDlpBin}"`,
        `--ffmpeg-location "${path.dirname(ffmpegBin)}"`,
        '--js-runtimes node',
      ];

      if (isTrimmed) {
        args.push(`--download-sections "*${startTimeStr}-${endTimeStr}"`);
      }

      if (isAudio) {
        args.push('-x', '--audio-format', format, '--audio-quality', String(audioQuality));
      } else {
        const ytFormat = heightLimit
          ? `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]`
          : 'bestvideo+bestaudio/best';
        args.push('-f', `"${ytFormat}"`, '--merge-output-format', 'mp4');
      }

      if (isTrimmed) {
        args.push('--force-keyframes-at-cuts');
      }

      args.push('--no-playlist');

      if (useCookies && cookiesFile) {
        args.push(`--cookies "${cookiesFile}"`);
      }

      args.push('-o', `"${rawTarget}"`, `"${url}"`);
      return args;
    };

    if (onProgress) onProgress('⬇️ Downloading high-resolution clip stream...', 30);

    const initialArgs = buildArgs(Boolean(cookiesFile));
    console.log(`[YouTube Downloader] 🚀 Fetching clip stream via yt-dlp:\n${initialArgs.join(' ')}`);

    try {
      await execAsync(initialArgs.join(' '), { maxBuffer: 500 * 1024 * 1024, timeout: 30 * 60 * 1000 });
    } catch (err: any) {
      if (cookiesFile && (err.message?.includes('403') || err.message?.includes('Forbidden'))) {
        console.warn('[YouTube Downloader] ⚠️ Download with cookies returned 403. Retrying without cookies...');
        const retryArgs = buildArgs(false);
        console.log(`[YouTube Downloader] 🔄 Retry command:\n${retryArgs.join(' ')}`);
        await execAsync(retryArgs.join(' '), { maxBuffer: 500 * 1024 * 1024, timeout: 30 * 60 * 1000 });
      } else {
        throw err;
      }
    }

    if (!fs.existsSync(rawTarget) || fs.statSync(rawTarget).size === 0) {
      throw new Error('Video clip stream download failed or produced an empty file.');
    }

    const rawSizeMb = (fs.statSync(rawTarget).size / (1024 * 1024)).toFixed(2);
    console.log(`[YouTube Downloader] ✅ Full-quality stream downloaded (${rawSizeMb} MB)`);

    // ── Local FFmpeg Processing (Aspect Ratio Cropping if requested) ──
    if (needsCrop) {
      if (onProgress) onProgress('✂️ Cropping clip aspect ratio...', 80);

      const ffmpegArgs: string[] = [
        `"${ffmpegBin}"`,
        '-y',
        `-i "${rawTarget}"`,
        `-vf "${filterString}"`,
        '-c:v libx264',
        '-preset fast',
        '-crf 18',
        '-c:a aac',
        `"${finalFile}"`,
      ];

      console.log(`[YouTube Downloader] ✂️ Cropping clip with FFmpeg:\n${ffmpegArgs.join(' ')}`);
      await execAsync(ffmpegArgs.join(' '), { maxBuffer: 100 * 1024 * 1024, timeout: 30 * 60 * 1000 });

      // Clean up raw download if it was stored in tempRawFile
      if (fs.existsSync(tempRawFile)) {
        try { fs.unlinkSync(tempRawFile); } catch (_) {}
      }
    }

    if (!fs.existsSync(finalFile) || fs.statSync(finalFile).size === 0) {
      throw new Error('Final exported file was not generated.');
    }

    const finalSizeMb = (fs.statSync(finalFile).size / (1024 * 1024)).toFixed(2);
    console.log(`[YouTube Downloader] 🎉 Export ready: ${finalFile} (${finalSizeMb} MB)`);

    if (onProgress) onProgress('✅ Complete!', 100);
    return finalFile;
  }
}
