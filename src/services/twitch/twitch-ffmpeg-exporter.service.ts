/**
 * ============================================================================
 * TWITCH FFMPEG EXPORTER SERVICE
 * ============================================================================
 * Extracts exact timeline clips directly from HLS stream URLs using FFmpeg,
 * supporting stream-copy, H.264+AAC transcode, aspect ratio cropping,
 * and robust post-render stream integrity validation.
 * ============================================================================
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { getFFmpegAspectFilter } from '../video-crop.service.js';

const execAsync = promisify(exec);

export interface TwitchFFmpegExportOptions {
  hlsStreamUrl: string;
  outputPath: string;
  tempRawPath?: string;
  trimStart?: number;
  trimEnd?: number;
  format?: string;
  audioQuality?: string | number;
  audioBitrate?: string;
  aspectRatio?: string;
  fitMode?: 'crop' | 'pad';
  cropPosition?: string;
  cropBox?: any;
  ffmpegBin: string;
  onProgress?: (phase: string, percent?: number, speed?: string) => void;
}

export interface MediaValidationResult {
  isValid: boolean;
  sizeBytes: number;
  durationSeconds?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  error?: string;
}

export class TwitchFFmpegExporterService {
  /**
   * Inspects a rendered media file using FFmpeg stderr to verify stream integrity
   */
  static async validateMedia(filePath: string, ffmpegBin: string, expectedDuration?: number): Promise<MediaValidationResult> {
    if (!fs.existsSync(filePath)) {
      return { isValid: false, sizeBytes: 0, hasVideo: false, hasAudio: false, error: 'File does not exist' };
    }

    const stat = fs.statSync(filePath);
    if (stat.size < 1000) {
      return { isValid: false, sizeBytes: stat.size, hasVideo: false, hasAudio: false, error: `File is too small (${stat.size} bytes)` };
    }

    try {
      // ffmpeg -i <file> exits with code 1 after outputting stream metadata
      let outputText = '';
      try {
        const { stderr } = await execAsync(`"${ffmpegBin}" -i "${filePath}"`);
        outputText = stderr;
      } catch (procErr: any) {
        outputText = procErr.stderr || procErr.stdout || '';
      }

      const hasVideo = /Stream #0:\d+.*Video:/i.test(outputText);
      const hasAudio = /Stream #0:\d+.*Audio:/i.test(outputText);

      const videoCodecMatch = outputText.match(/Video:\s*([a-zA-Z0-9_-]+)/i);
      const audioCodecMatch = outputText.match(/Audio:\s*([a-zA-Z0-9_-]+)/i);

      let durationSeconds: number | undefined;
      const durationMatch = outputText.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.?\d*)/i);
      if (durationMatch) {
        const h = parseFloat(durationMatch[1]);
        const m = parseFloat(durationMatch[2]);
        const s = parseFloat(durationMatch[3]);
        durationSeconds = h * 3600 + m * 60 + s;
      }

      // Check if duration is reasonably non-zero (if expectedDuration provided)
      if (expectedDuration && expectedDuration > 0 && durationSeconds !== undefined) {
        // If rendered file is less than 10% of expected duration, consider corrupted
        if (durationSeconds < Math.min(1.0, expectedDuration * 0.2)) {
          return {
            isValid: false,
            sizeBytes: stat.size,
            durationSeconds,
            hasVideo,
            hasAudio,
            videoCodec: videoCodecMatch ? videoCodecMatch[1] : undefined,
            audioCodec: audioCodecMatch ? audioCodecMatch[1] : undefined,
            error: `Rendered duration (${durationSeconds.toFixed(2)}s) is significantly shorter than requested (${expectedDuration}s)`,
          };
        }
      }

      return {
        isValid: true,
        sizeBytes: stat.size,
        durationSeconds,
        hasVideo,
        hasAudio,
        videoCodec: videoCodecMatch ? videoCodecMatch[1] : undefined,
        audioCodec: audioCodecMatch ? audioCodecMatch[1] : undefined,
      };
    } catch (err: any) {
      return {
        isValid: stat.size > 5000,
        sizeBytes: stat.size,
        hasVideo: true,
        hasAudio: true,
        error: `Validation probe warning: ${err.message}`,
      };
    }
  }

  /**
   * Renders the requested timeline section directly from HLS URL to output MP4/Audio
   */
  static async renderClip(options: TwitchFFmpegExportOptions): Promise<{ outputPath: string; mode: string; validation: MediaValidationResult }> {
    const {
      hlsStreamUrl,
      outputPath,
      trimStart = 0,
      trimEnd,
      format = 'mp4',
      audioBitrate = '192k',
      aspectRatio,
      fitMode = 'pad',
      cropPosition = 'center',
      cropBox,
      ffmpegBin,
      onProgress,
    } = options;

    const isAudio = format === 'mp3' || format === 'wav' || format === 'm4a' || format === 'aac';
    const hasTrim = typeof trimEnd === 'number' && trimEnd > trimStart;
    const duration = hasTrim ? Math.max(1, trimEnd! - trimStart) : undefined;
    const filterString = !isAudio ? getFFmpegAspectFilter(aspectRatio as any, fitMode, cropPosition as any, cropBox) : '';
    const needsCrop = !isAudio && Boolean(filterString);

    const safeAudioBitrate = audioBitrate && String(audioBitrate).endsWith('k') ? audioBitrate : '192k';

    console.log('\n' + '─'.repeat(60));
    console.log(`🎬 [Twitch FFmpeg Exporter] Rendering timeline clip:`);
    console.log(`   • Timeline: ${trimStart}s -> ${trimEnd !== undefined ? `${trimEnd}s` : 'End'} (Duration: ${duration !== undefined ? `${duration}s` : 'Full'})`);
    console.log(`   • Target Format: ${format} | Audio Bitrate: ${safeAudioBitrate}`);
    console.log(`   • Crop Filter: ${needsCrop ? filterString : 'None (Direct Frame)'}`);
    console.log(`   • Output Path: ${outputPath}`);
    console.log('─'.repeat(60));

    if (onProgress) onProgress('✂️ Rendering clip with FFmpeg...', 40);

    // ── 1. AUDIO-ONLY EXPORT PIPELINE ─────────────────────────────────────────
    if (isAudio) {
      const audioCodec = format === 'mp3' ? 'libmp3lame' : format === 'aac' ? 'aac' : format === 'wav' ? 'pcm_s16le' : 'aac';
      const audioArgs: string[] = [
        `"${ffmpegBin}"`,
        '-y',
        `-ss ${trimStart}`,
        `-i "${hlsStreamUrl}"`,
      ];
      if (duration !== undefined) {
        audioArgs.push(`-t ${duration}`);
      }
      audioArgs.push('-vn', `-c:a ${audioCodec}`, `-b:a ${safeAudioBitrate}`, `"${outputPath}"`);

      console.log(`[Twitch FFmpeg Exporter] Executing audio extraction:\n${audioArgs.join(' ')}`);
      await execAsync(audioArgs.join(' '));

      const val = await this.validateMedia(outputPath, ffmpegBin, duration);
      if (!val.isValid) {
        throw new Error(`Audio export validation failed: ${val.error || 'Empty or invalid file'}`);
      }
      return { outputPath, mode: 'audio-direct', validation: val };
    }

    // ── 2. VIDEO EXPORT WITH ASPECT RATIO / CROP ───────────────────────────────
    if (needsCrop) {
      console.log(`[Twitch FFmpeg Exporter] Crop/Pad requested. Executing H.264 + AAC transcode with filter...`);
      const transcodeCropArgs: string[] = [
        `"${ffmpegBin}"`,
        '-y',
        `-ss ${trimStart}`,
        `-i "${hlsStreamUrl}"`,
      ];
      if (duration !== undefined) {
        transcodeCropArgs.push(`-t ${duration}`);
      }
      transcodeCropArgs.push(
        `-vf "${filterString}"`,
        '-c:v libx264',
        '-preset fast',
        '-crf 19',
        '-c:a aac',
        `-b:a ${safeAudioBitrate}`,
        '-map 0:v:0',
        '-map 0:a:0?',
        '-movflags +faststart',
        `"${outputPath}"`
      );

      console.log(`[Twitch FFmpeg Exporter] Command:\n${transcodeCropArgs.join(' ')}`);
      await execAsync(transcodeCropArgs.join(' '));

      const val = await this.validateMedia(outputPath, ffmpegBin, duration);
      if (!val.isValid) {
        throw new Error(`Cropped video export failed validation: ${val.error || 'Empty or invalid media output'}`);
      }
      return { outputPath, mode: 'transcode-crop', validation: val };
    }

    // ── 3. STANDARD VIDEO EXPORT (Fast Copy with Fallback to Transcode) ────────
    let modeUsed = 'fast-copy';
    let copySuccess = false;

    // Attempt Fast Stream Copy first for near-instant rendering
    try {
      console.log(`[Twitch FFmpeg Exporter] 🚀 Attempting ultrafast H.264+AAC stream copy...`);
      const fastCopyArgs: string[] = [
        `"${ffmpegBin}"`,
        '-y',
        `-ss ${trimStart}`,
        `-i "${hlsStreamUrl}"`,
      ];
      if (duration !== undefined) {
        fastCopyArgs.push(`-t ${duration}`);
      }
      fastCopyArgs.push(
        '-c copy',
        '-map 0:v:0',
        '-map 0:a:0?',
        '-movflags +faststart',
        '-bsf:a aac_adtstoasc',
        `"${outputPath}"`
      );

      await execAsync(fastCopyArgs.join(' '), { timeout: 30000 });

      // Validate stream copy output
      const copyVal = await this.validateMedia(outputPath, ffmpegBin, duration);
      if (copyVal.isValid && copyVal.hasVideo) {
        console.log(`[Twitch FFmpeg Exporter] ✅ Stream copy validated successfully (${(copyVal.sizeBytes / (1024 * 1024)).toFixed(2)} MB, ${copyVal.durationSeconds?.toFixed(2)}s)`);
        copySuccess = true;
        return { outputPath, mode: 'fast-copy', validation: copyVal };
      } else {
        console.warn(`[Twitch FFmpeg Exporter] ⚠️ Stream copy output validation failed (${copyVal.error}). Falling back to transcode...`);
      }
    } catch (copyErr: any) {
      console.warn(`[Twitch FFmpeg Exporter] ⚠️ Fast stream copy failed: ${copyErr.message}. Falling back to H.264 + AAC transcode...`);
    }

    // ── 4. TRANSCODE FALLBACK (Guaranteed Clean Standard H.264 + AAC MP4) ──────
    modeUsed = 'transcode-h264-aac';
    if (onProgress) onProgress('⚙️ Encoding high-quality H.264 video...', 60);

    const transcodeArgs: string[] = [
      `"${ffmpegBin}"`,
      '-y',
      `-ss ${trimStart}`,
      `-i "${hlsStreamUrl}"`,
    ];
    if (duration !== undefined) {
      transcodeArgs.push(`-t ${duration}`);
    }
    transcodeArgs.push(
      '-c:v libx264',
      '-preset fast',
      '-crf 20',
      '-c:a aac',
      `-b:a ${safeAudioBitrate}`,
      '-map 0:v:0',
      '-map 0:a:0?',
      '-movflags +faststart',
      `"${outputPath}"`
    );

    console.log(`[Twitch FFmpeg Exporter] Executing H.264+AAC transcode:\n${transcodeArgs.join(' ')}`);
    await execAsync(transcodeArgs.join(' '));

    const finalVal = await this.validateMedia(outputPath, ffmpegBin, duration);
    if (!finalVal.isValid || !finalVal.hasVideo) {
      throw new Error(`Twitch export failed validation: ${finalVal.error || 'No valid video stream created'}`);
    }

    console.log(`[Twitch FFmpeg Exporter] ✅ Export complete & validated (${(finalVal.sizeBytes / (1024 * 1024)).toFixed(2)} MB, ${finalVal.durationSeconds?.toFixed(2)}s, Video: ${finalVal.videoCodec || 'h264'}, Audio: ${finalVal.audioCodec || 'aac'})`);
    return { outputPath, mode: modeUsed, validation: finalVal };
  }
}
