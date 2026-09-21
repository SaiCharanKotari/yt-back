/**
 * ============================================================================
 * INSTAGRAM METADATA SERVICE
 * ============================================================================
 * Handles metadata querying, format extraction, and thumbnail resolution
 * for Instagram Reels, Posts, and Videos using specialized browser headers.
 * ============================================================================
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class InstagramMetadataService {
  /**
   * Browser User-Agent header required by Instagram to prevent login redirects
   */
  static readonly USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  /**
   * Fetches Instagram video metadata via yt-dlp with appropriate headers
   */
  static async getMetadata(url: string, ytDlpBin: string, retries = 1): Promise<any> {
    const flags = `--add-header "User-Agent: ${this.USER_AGENT}" --no-warnings --no-check-certificate --dump-json`;

    let lastErr: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { stdout } = await execAsync(
          `"${ytDlpBin}" ${flags} "${url}"`,
          { maxBuffer: 1024 * 1024 * 50 }
        );
        return JSON.parse(stdout);
      } catch (err: any) {
        lastErr = err;
        const msg = err?.message || String(err);
        if (attempt < retries && (msg.toLowerCase().includes('timed out') || msg.toLowerCase().includes('temporary'))) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  }
}
