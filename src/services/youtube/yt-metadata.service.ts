import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

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

export class YouTubeMetadataService {
  /**
   * Fetches full YouTube video metadata, title, duration, uploader, thumbnails, and DASH formats.
   */
  static async getMetadata(url: string, ytDlpBin: string, retries = 1): Promise<any> {
    const cookiesFile = findCookiesFile();
    const cookieArg = cookiesFile ? `--cookies "${cookiesFile}" ` : '';
    const flags = `--js-runtimes node ${cookieArg}--no-warnings --no-check-certificate --dump-json`;

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

