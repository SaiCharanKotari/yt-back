import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

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

ffmpeg.setFfmpegPath(resolveFfmpegBinary());

const TEMP_DIR = path.join(process.cwd(), 'temp');

// Ensure temp dir exists
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/** Schedule a file for deletion after `delayMs` ms */
export function scheduleCleanup(filePath: string, delayMs = 30 * 60 * 1000) {
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Cleanup] Deleted: ${filePath}`);
      }
    } catch (e) {
      console.warn(`[Cleanup] Failed to delete ${filePath}:`, e);
    }
  }, delayMs);
}

export interface ProcessOptions {
  inputPath: string;   // local file already downloaded by yt-dlp
  outputPath: string;
  trimStart: number;   // seconds
  trimEnd: number;     // seconds
  format: 'mp4' | 'mp3' | 'wav';
  audioBitrate?: string; // e.g. '320k' — only for mp3/wav
  onProgress?: (percent: number) => void;
}

export class FFmpegService {
  /**
   * Trim + convert a locally downloaded file, resolve with output path.
   */
  static processVideo(opts: ProcessOptions): Promise<string> {
    const { inputPath, outputPath, trimStart, trimEnd, format, audioBitrate, onProgress } = opts;
    const duration = trimEnd - trimStart;

    return new Promise((resolve, reject) => {
      let cmd = ffmpeg(inputPath)
        .setStartTime(trimStart)
        .setDuration(duration);

      if (format === 'mp4') {
        // Re-encode so seeking is precise and trims are clean
        cmd = cmd.videoCodec('libx264').audioCodec('aac').outputOptions(['-preset fast', '-crf 23']);
      } else if (format === 'mp3') {
        cmd = cmd.noVideo().audioCodec('libmp3lame').audioBitrate(audioBitrate || '192k').format('mp3');
      } else if (format === 'wav') {
        cmd = cmd.noVideo().audioCodec('pcm_s16le').format('wav');
      }

      cmd
        .output(outputPath)
        .on('progress', (p) => {
          const pct = p.percent ? Math.min(Math.round(p.percent), 99) : 0;
          onProgress?.(pct);
        })
        .on('end', () => {
          onProgress?.(100);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('[FFmpeg] Error:', err.message);
          reject(err);
        })
        .run();
    });
  }
}
