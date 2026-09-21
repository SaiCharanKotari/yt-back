import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { YouTubeMetadataService } from './youtube/index.js';
import { TwitterMetadataService } from './twitter/index.js';
import { InstagramMetadataService } from './instagram/index.js';
import { TwitchMetadataService } from './twitch/index.js';

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

const execAsync = promisify(exec);
const YTDLP_BIN = resolveYtDlpBinary();

export class YtDlpService {
  /**
   * Universal Metadata Dispatcher:
   * Delegates to dedicated modular platform services:
   * - YouTube   -> src/services/youtube/yt-metadata.service.ts
   * - Twitter/X -> src/services/twitter/twitter-metadata.service.ts
   * - Instagram -> src/services/instagram/instagram-metadata.service.ts
   * - Twitch    -> src/services/twitch/twitch-metadata.service.ts
   */
  static async getVideoMetadata(url: string) {
    try {
      // 1. Twitter / X Handler
      if (url.includes('twitter.com') || url.includes('x.com')) {
        return await TwitterMetadataService.getMetadata(url, YTDLP_BIN);
      }

      // 2. YouTube Handler
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        return await YouTubeMetadataService.getMetadata(url, YTDLP_BIN, 1);
      }

      // 3. Instagram Handler
      if (url.includes('instagram.com')) {
        return await InstagramMetadataService.getMetadata(url, YTDLP_BIN, 1);
      }

      // 4. Twitch Handler
      if (url.includes('twitch.tv')) {
        return await TwitchMetadataService.getMetadata(url, YTDLP_BIN, 1);
      }

      // 5. Generic Extractor Fallback
      const flags = '--js-runtimes node --no-warnings --no-check-certificate --dump-json';
      const { stdout } = await execAsync(`"${YTDLP_BIN}" ${flags} "${url}"`, {
        maxBuffer: 1024 * 1024 * 50,
      });
      return JSON.parse(stdout);
    } catch (error: any) {
      console.error('[YtDlpService] Error fetching metadata:', error?.message || error);
      let cleanMsg = error?.message || 'Failed to fetch video metadata';
      if (cleanMsg.includes('The channel is not currently live')) {
        cleanMsg = 'This Twitch channel is not currently live.';
      }
      throw new Error(cleanMsg);
    }
  }

  /**
   * Check if yt-dlp is installed and accessible
   */
  static async checkInstallation() {
    try {
      const { stdout } = await execAsync(`"${YTDLP_BIN}" --version`);
      return stdout.trim();
    } catch (error) {
      console.error('yt-dlp.exe not found in backend directory.');
      throw error;
    }
  }
}
