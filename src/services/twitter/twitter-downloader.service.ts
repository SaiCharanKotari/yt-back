/**
 * ============================================================================
 * TWITTER / X DOWNLOADER SERVICE
 * ============================================================================
 * Handles downloading Twitter / X video clips, matching exact resolutions,
 * and applying FFmpeg trim/crop without quality degradation.
 * ============================================================================
 */

import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getFFmpegAspectFilter } from '../video-crop.service.js';
import { TwitterMetadataService } from './twitter-metadata.service.js';

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

export interface TwitterDownloadOptions {
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

export class TwitterDownloaderService {
  /**
   * Downloads Twitter / X video and trims/crops as requested
   */
  static async downloadClip(options: TwitterDownloadOptions): Promise<string> {
    const {
      url,
      format = 'mp4',
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

    const rawTarget = needsCrop ? tempRawFile : finalFile;

    let downloadSourceUrl = url;
    try {
      const meta = await TwitterMetadataService.getMetadata(url, ytDlpBin);
      if (meta?.direct_stream_url) {
        downloadSourceUrl = meta.direct_stream_url;
      }
    } catch (_) {}

    const ytDlpArgs: string[] = [
      `"${ytDlpBin}"`,
      `--ffmpeg-location "${path.dirname(ffmpegBin)}"`,
      '--js-runtimes node',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--retries 10',
      '--fragment-retries 10',
    ];

    if (isTrimmed) {
      const startStr = formatSecondsToTime(trimStart);
      const endStr = formatSecondsToTime(trimEnd!);
      ytDlpArgs.push(`--download-sections "*${startStr}-${endStr}"`, '--force-keyframes-at-cuts');
    }

    if (isAudio) {
      ytDlpArgs.push('-x', '--audio-format', format, '--audio-quality', String(audioQuality));
    } else {
      ytDlpArgs.push('-f', '"bestvideo+bestaudio/best"', '--merge-output-format', 'mp4');
    }

    ytDlpArgs.push('-o', `"${rawTarget}"`, `"${downloadSourceUrl}"`);

    console.log(`[Twitter Downloader] 🚀 Fetching Twitter stream:\n${ytDlpArgs.join(' ')}`);
    if (onProgress) onProgress('⬇️ Downloading Twitter / X video...', 25);

    await execAsync(ytDlpArgs.join(' '));

    if (!fs.existsSync(rawTarget) || fs.statSync(rawTarget).size === 0) {
      throw new Error('Twitter video download failed or produced an empty file.');
    }

    // ── Local FFmpeg Processing (Only if Cropping needed) ─────────────────────
    if (needsCrop) {
      if (onProgress) onProgress('✂️ Formatting clip...', 75);

      const ffmpegArgs: string[] = [
        `"${ffmpegBin}"`,
        `-i "${rawTarget}"`,
        `-vf "${filterString}"`,
        '-c:v libx264',
        '-preset fast',
        '-crf 18',
        '-c:a aac',
        '-y',
        `"${finalFile}"`,
      ];

      console.log(`[Twitter Downloader] ✂️ Processing clip with FFmpeg:\n${ffmpegArgs.join(' ')}`);
      await execAsync(ffmpegArgs.join(' '));

      if (fs.existsSync(tempRawFile)) {
        try { fs.unlinkSync(tempRawFile); } catch (_) {}
      }
    }

    if (onProgress) onProgress('✅ Complete!', 100);
    return finalFile;
  }
}
