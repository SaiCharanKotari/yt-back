import express, { Request, Response } from 'express';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
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

function resolveFFmpegBinary(): string {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(process.cwd(), 'backend', 'ffmpeg.exe'),
    path.join(process.cwd(), 'ffmpeg.exe'),
    path.join(process.cwd(), 'qt-app', 'bin', 'ffmpeg.exe'),
    path.join(localAppData, 'Programs', 'ClipFlow', 'bin', 'ffmpeg.exe'),
    path.join(localAppData, 'ClipFlow', 'bin', 'ffmpeg.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

function resolveTempDir(): string {
  const candidates = [
    path.join(process.cwd(), 'temp'),
    path.join(process.cwd(), 'backend', 'temp'),
  ];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) fs.mkdirSync(c, { recursive: true });
      return c;
    } catch {}
  }
  const fallback = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const YTDLP_BIN = resolveYtDlpBinary();
const FFMPEG_BIN = resolveFFmpegBinary();
const PREVIEWS_DIR = path.join(resolveTempDir(), 'previews');

const execAsync = util.promisify(exec);
const router = express.Router();

// Options preflight
router.options(['/twitch-vod-stream', '/live-segment'], (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

// ─── /twitch-vod-stream (Resolve Twitch VOD / Live URL and get HLS playlist) ───
router.get('/twitch-vod-stream', async (req: Request, res: Response) => {
  const targetUrl = (req.query.url as string) || '';
  if (!targetUrl) return res.status(400).json({ error: 'url parameter is required' });

  try {
    console.log(`\n[Twitch Stream 🎬] Resolving live stream / VOD URL for: ${targetUrl}`);
    console.log(`[Twitch Stream 🎬] Using yt-dlp binary: ${YTDLP_BIN}`);

    // Prioritize 1080p, then 720p, then best available stream
    const ytdlpCmd = `"${YTDLP_BIN}" -g -f "best[height<=1080]/bestvideo[height<=1080]+bestaudio/best" --no-warnings --no-check-certificate "${targetUrl}"`;
    console.log(`[Twitch Stream 🎬] Executing command: ${ytdlpCmd}`);

    const { stdout, stderr } = await execAsync(ytdlpCmd, { timeout: 25000 });
    if (stderr) {
      console.warn(`[Twitch Stream ⚠️] yt-dlp stderr:`, stderr);
    }
    
    const streamUrl = stdout.trim().split('\n')[0].trim();
    if (!streamUrl) {
      throw new Error('Failed to resolve stream URL from yt-dlp output.');
    }
    
    console.log(`[Twitch Stream ✅] Resolved Raw Stream URL: ${streamUrl.substring(0, 80)}...`);

    const host = req.protocol + '://' + req.get('host');
    let proxyUrl = streamUrl;

    // Wrap m3u8 playlists through the hls-proxy, MP4s through proxy-stream
    if (streamUrl.includes('.m3u8')) {
      proxyUrl = `${host}/api/video/hls-proxy?url=${encodeURIComponent(streamUrl)}`;
    } else {
      proxyUrl = `${host}/api/video/proxy-stream?url=${encodeURIComponent(streamUrl)}`;
    }

    console.log(`[Twitch Stream 🚀] Returning HLS Proxy URL: ${proxyUrl}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=1200'); // Cache for 20 mins

    return res.json({
      vodUrl: targetUrl,
      hlsProxyUrl: proxyUrl,
      streamUrl: streamUrl,
    });
  } catch (err: any) {
    console.error('[Twitch Stream Error ❌]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: `Failed to resolve Twitch stream: ${err.message}` });
    }
  }
});

// ─── /live-segment (Extract 10s MP4 chunk of live twitch stream via yt-dlp/ffmpeg) ───
router.get('/live-segment', async (req: Request, res: Response) => {
  const targetUrl = (req.query.url as string) || '';
  if (!targetUrl) return res.status(400).send('url parameter required');

  try {
    // 1. Get the Live HLS URL
    const ytdlpCmd = `"${YTDLP_BIN}" -g -f "best[height<=720]/bestvideo[height<=720]+bestaudio/best" --no-warnings "${targetUrl}"`;
    const { stdout } = await execAsync(ytdlpCmd, { timeout: 15000 });
    const liveStreamUrl = stdout.trim().split('\n')[0];
    
    if (!liveStreamUrl) throw new Error('Failed to extract live stream URL.');

    // 2. Use FFmpeg to download exactly 10 seconds of the live stream to a temporary MP4
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5').update(`${targetUrl}-${Date.now()}`).digest('hex');
    const outputPath = path.join(PREVIEWS_DIR, `live_${hash}.mp4`);
    
    // Ensure previews dir exists
    if (!fs.existsSync(PREVIEWS_DIR)) {
      fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
    }

    console.log(`[Twitch Live Segment] Extracting 10s from live stream to ${outputPath}`);
    
    // -t 10 limits the output to 10 seconds
    const ffmpegCmd = `"${FFMPEG_BIN}" -y -i "${liveStreamUrl}" -t 10 -c:v copy -c:a copy -movflags +faststart "${outputPath}"`;
    await execAsync(ffmpegCmd, { timeout: 20000 });

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg failed to create the live segment file.');
    }

    // 3. Stream the file back to the browser
    const stat = fs.statSync(outputPath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    });

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('close', () => {
      // Clean up the file after streaming
      setTimeout(() => {
        fs.unlink(outputPath, (err) => {
          if (err) console.error(`Failed to delete temp live segment ${outputPath}`, err);
        });
      }, 5000);
    });
    
  } catch (err: any) {
    console.error('[Twitch Live Segment Error]', err);
    if (!res.headersSent) {
      res.status(500).send('Error extracting live segment');
    }
  }
});

export default router;
