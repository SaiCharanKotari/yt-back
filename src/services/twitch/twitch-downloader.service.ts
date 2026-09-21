/**
 * ============================================================================
 * TWITCH DOWNLOADER SERVICE
 * ============================================================================
 * Coordinates resolving Twitch channel / DVR / clip streams to direct HLS URLs
 * and rendering timeline-accurate, validated H.264 + AAC MP4 clips via FFmpeg.
 * ============================================================================
 */

import { TwitchStreamResolverService } from './twitch-stream-resolver.service.js';
import { TwitchFFmpegExporterService } from './twitch-ffmpeg-exporter.service.js';

export interface TwitchDownloadOptions {
  url: string;
  format?: string;
  quality?: string;
  audioQuality?: string | number;
  audioBitrate?: string;
  trimStart?: number;
  trimEnd?: number;
  aspectRatio?: string;
  fitMode?: 'crop' | 'pad';
  cropPosition?: string;
  cropBox?: any;
  tempRawFile?: string;
  finalFile: string;
  ytDlpBin: string;
  ffmpegBin: string;
  onProgress?: (phase: string, percent?: number, speed?: string) => void;
}

export class TwitchDownloaderService {
  /**
   * Downloads Twitch clip/VOD/live-stream using direct HLS stream extraction
   * and FFmpeg timeline seeking identical to the preview pipeline.
   */
  static async downloadClip(options: TwitchDownloadOptions): Promise<string> {
    const {
      url,
      format = 'mp4',
      quality = '720p',
      audioQuality = '0',
      audioBitrate = '192k',
      trimStart = 0,
      trimEnd,
      aspectRatio,
      fitMode = 'pad',
      cropPosition = 'center',
      cropBox,
      finalFile,
      ytDlpBin,
      ffmpegBin,
      onProgress,
    } = options;

    if (onProgress) onProgress('📡 Resolving Twitch stream URL...', 15);

    // 1. Resolve direct HLS stream URL via DVR VOD / GQL / yt-dlp
    const streamInfo = await TwitchStreamResolverService.resolveStreamUrl(
      url,
      ytDlpBin,
      quality
    );

    console.log(`[Twitch Downloader] 🎯 Stream resolved:`);
    console.log(`   • Source Type: ${streamInfo.sourceType}`);
    if (streamInfo.vodId) console.log(`   • DVR VOD ID: ${streamInfo.vodId}`);
    if (streamInfo.channel) console.log(`   • Channel: ${streamInfo.channel}`);
    console.log(`   • HLS URL: ${streamInfo.streamUrl.substring(0, 80)}...`);

    if (onProgress) onProgress('🎬 Extracting timeline clip with FFmpeg...', 35);

    // 2. Render exact timeline clip with FFmpeg on the HLS stream
    const exportResult = await TwitchFFmpegExporterService.renderClip({
      hlsStreamUrl: streamInfo.streamUrl,
      outputPath: finalFile,
      trimStart: Number(trimStart) || 0,
      trimEnd: trimEnd !== undefined ? Number(trimEnd) : undefined,
      format,
      audioQuality,
      audioBitrate: String(audioBitrate || '192k'),
      aspectRatio,
      fitMode,
      cropPosition,
      cropBox,
      ffmpegBin,
      onProgress,
    });

    if (onProgress) onProgress('🔍 Verifying clip integrity...', 85);

    console.log(`[Twitch Downloader] 📦 Final rendered clip: ${exportResult.outputPath}`);
    console.log(`   • Render Mode: ${exportResult.mode}`);
    console.log(`   • Size: ${(exportResult.validation.sizeBytes / (1024 * 1024)).toFixed(2)} MB`);
    if (exportResult.validation.durationSeconds !== undefined) {
      console.log(`   • Duration: ${exportResult.validation.durationSeconds.toFixed(2)}s`);
    }

    if (onProgress) onProgress('✅ Complete!', 100);
    return exportResult.outputPath;
  }
}
