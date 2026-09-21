import { Router, Request, Response } from 'express';
import { YtDlpService } from '../services/yt-dlp.service.js';
import { FFmpegService, scheduleCleanup } from '../services/ffmpeg.service.js';
import { SocketService } from '../services/socket.service.js';
import { generatePowerShellWorkflow, formatSecondsToTime } from '../services/command-generator.service.js';
import { buildCropWorkflow, getFFmpegAspectFilter } from '../services/video-crop.service.js';
import { cleanUnicodeFileName, getSafeContentDisposition } from '../utils/i18n-filename.util.js';
import { fetchAndTrimCaptions } from '../services/captions.service.js';
import { FrameExtractorService } from '../services/frame-extractor.service.js';
import { YouTubeDownloaderService } from '../services/youtube/index.js';
import { InstagramDownloaderService } from '../services/instagram/index.js';
import { TwitterDownloaderService } from '../services/twitter/index.js';
import { TwitchDownloaderService, TwitchLiveFrameService } from '../services/twitch/index.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';

import { Readable } from 'stream';

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

function resolveTempDir(): string {
  // Check cwd/temp FIRST (covers the case where cwd is already inside /backend)
  // then cwd/backend/temp (covers running from project root)
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

const execAsync = promisify(exec);
const YTDLP_BIN = resolveYtDlpBinary();
const FFMPEG_BIN = resolveFFmpegBinary();
const router = Router();
const TEMP_DIR = resolveTempDir();

// ─── /hls-proxy (Rewrites M3U8 playlists & bypasses CORS on live/VOD streams) ─
router.get('/hls-proxy', async (req: Request, res: Response) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) return res.status(400).json({ error: 'url parameter is required' });

  const host = req.protocol + '://' + req.get('host');
  console.log(`\n[HLS Proxy 📡] Request for playlist: ${targetUrl.substring(0, 100)}...`);

  try {
    const fetchHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (targetUrl.includes('twitch.tv') || targetUrl.includes('ttvnw.net') || targetUrl.includes('cloudfront.net')) {
      fetchHeaders['Referer'] = 'https://www.twitch.tv/';
      fetchHeaders['Origin'] = 'https://www.twitch.tv';
      fetchHeaders['Client-ID'] = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    }

    const response = await fetch(targetUrl, { headers: fetchHeaders });
    if (!response.ok) {
      console.error(`[HLS Proxy ❌] Upstream playlist returned ${response.status} for ${targetUrl}`);
      return res.status(response.status).json({ error: `Upstream playlist returned ${response.status}` });
    }

    const m3u8Text = await response.text();
    const lines = m3u8Text.split('\n');
    console.log(`[HLS Proxy 📝] Upstream OK (${lines.length} lines). Rewriting URLs with host: ${host}`);

    const rewrittenLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Handle Key / Init map URIs
      if (trimmed.startsWith('#EXT-X-KEY:') || trimmed.startsWith('#EXT-X-MAP:')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          try {
            const resolved = new URL(uri, targetUrl).toString();
            return `URI="${host}/api/video/proxy-stream?url=${encodeURIComponent(resolved)}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }

      // Convert playlist type to VOD so hls.js treats it as a static seekable timeline from 0
      if (trimmed.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        return '#EXT-X-PLAYLIST-TYPE:VOD';
      }

      // Comment or tag
      if (trimmed.startsWith('#')) return line;

      // Resolve segment / sub-manifest URL
      try {
        const resolved = new URL(trimmed, targetUrl).toString();
        if (resolved.includes('.m3u8')) {
          return `${host}/api/video/hls-proxy?url=${encodeURIComponent(resolved)}`;
        }
        // Direct Twitch CloudFront / Usher media segments bypass proxy for 0-bandwidth & zero-socket-abort
        if (resolved.includes('cloudfront.net') || resolved.includes('ttvnw.net')) {
          return resolved;
        }
        return `${host}/api/video/proxy-stream?url=${encodeURIComponent(resolved)}`;
      } catch {
        return line;
      }
    });

    // For media playlists (contains segments), ensure it has #EXT-X-PLAYLIST-TYPE:VOD and #EXT-X-ENDLIST
    // so hls.js treats it as a complete VOD from time 0 to current duration, never snapping to live edge
    const hasSegments = rewrittenLines.some((l) => !l.startsWith('#') && l.trim().length > 0);
    if (hasSegments) {
      const hasPlaylistType = rewrittenLines.some((l) => l.startsWith('#EXT-X-PLAYLIST-TYPE:'));
      if (!hasPlaylistType) {
        rewrittenLines.splice(1, 0, '#EXT-X-PLAYLIST-TYPE:VOD');
      }
      const hasEndList = rewrittenLines.some((l) => l.trim() === '#EXT-X-ENDLIST');
      if (!hasEndList) {
        rewrittenLines.push('#EXT-X-ENDLIST');
      }
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewrittenLines.join('\n'));
  } catch (err: any) {
    console.error('[HLS Proxy Error ❌]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── OPTIONS preflight for CORS video streaming & frame extraction ─────────
router.options(['/proxy', '/frame', '/thumbnail', '/hls-proxy', '/proxy-stream'], (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});




// ─── /proxy (stream video format to bypass CORS/403 referer issues) ─────────
router.get('/proxy', async (req: Request, res: Response) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) return res.status(400).json({ error: 'URL parameter is required' });

  // YouTube / googlevideo CDN streams cannot be proxied by backend (causes 403 Forbidden)
  if (targetUrl.includes('googlevideo.com') || targetUrl.includes('youtube.com')) {
    return res.status(403).json({ error: 'Backend streaming of YouTube is disabled. UI connects directly to YouTube for preview.' });
  }

  try {
    const fetchHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (targetUrl.includes('instagram.com') || targetUrl.includes('cdninstagram.com')) {
      fetchHeaders['Referer'] = 'https://www.instagram.com/';
    } else if (targetUrl.includes('twimg.com') || targetUrl.includes('twitter.com') || targetUrl.includes('x.com')) {
      fetchHeaders['Referer'] = 'https://twitter.com/';
    } else if (targetUrl.includes('twitch.tv') || targetUrl.includes('ttvnw.net') || targetUrl.includes('cloudfront.net')) {
      fetchHeaders['Referer'] = 'https://www.twitch.tv/';
      fetchHeaders['Origin'] = 'https://www.twitch.tv';
    }

    // Chunk clamping: buffer ~3MB slices (~20-30s of preview video) rather than full video files
    const CHUNK_SIZE = 3 * 1024 * 1024;
    const reqRange = req.headers.range as string | undefined;

    if (reqRange && reqRange.startsWith('bytes=')) {
      const parts = reqRange.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10) || 0;
      let end = parts[1] ? parseInt(parts[1], 10) : undefined;
      if (end === undefined || (end - start) > CHUNK_SIZE) {
        end = start + CHUNK_SIZE - 1;
      }
      fetchHeaders['range'] = `bytes=${start}-${end}`;
    }

    const response = await fetch(targetUrl, { headers: fetchHeaders });

    if (!response.ok && response.status !== 206) {
      return res.status(response.status).json({ error: `Upstream returned ${response.status}` });
    }

    res.status(response.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Authorization');

    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    if (targetUrl.includes('.ts') || targetUrl.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    } else if (!res.getHeader('content-type')) {
      res.setHeader('Content-Type', 'video/mp4');
    }

    if (!response.body) return res.end();

    // @ts-ignore
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.on('error', (streamErr: any) => {
      // Gracefully consume socket close / abort without crashing process
      if (streamErr?.code !== 'UND_ERR_SOCKET' && !streamErr?.message?.includes('closed') && !streamErr?.message?.includes('aborted')) {
        console.warn('[Proxy Stream Notice]', streamErr.message);
      }
      try { nodeStream.destroy(); } catch {}
    });

    req.on('close', () => {
      try { nodeStream.destroy(); } catch {}
    });

    res.on('error', () => {
      try { nodeStream.destroy(); } catch {}
    });

    nodeStream.pipe(res);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── /frame (Extract exact video frame at timestamp `time` seconds) ─────────
router.get('/frame', async (req: Request, res: Response) => {
  const { url, time = '0', youtubeId, download, title, fullRes, format = 'png', crop_x, crop_y, crop_w, crop_h, streamUrl, directUrl } = req.query;
  const targetUrl = (url as string) || (youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : '');
  if (!targetUrl) return res.status(400).json({ error: 'url or youtubeId is required' });

  const isDownload = download === 'true' || download === '1';

  // If this is just a UI preview/timeline scrub (not an explicit frame download), do not trigger ffmpeg/yt-dlp
  if (!isDownload) {
    const ytId = (youtubeId as string) || (targetUrl.includes('youtu') ? targetUrl.split('v=')[1]?.split('&')[0] || targetUrl.split('youtu.be/')[1]?.split('?')[0] : '');
    if (ytId) {
      return res.redirect(`https://img.youtube.com/vi/${ytId}/hqdefault.jpg`);
    }
    return res.status(204).end();
  }

  const timestamp = Math.max(0, parseFloat(time as string) || 0);
  const isFullRes = isDownload || fullRes === 'true' || fullRes === '1';
  const requestedFormat = ((format as string) || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';
  // Dedicated Twitch LIVE Channel Handler (always uses exact 5s chunks and local offsets, avoiding ads)
  if (TwitchLiveFrameService.isLiveChannelUrl(targetUrl)) {
    try {
      const chunkOffset = Math.floor(timestamp / 5) * 5;
      const localTime = +(timestamp - chunkOffset).toFixed(3);
      const result = await TwitchLiveFrameService.extractLiveFrame({
        url: targetUrl,
        chunkOffset,
        localTime,
        globalTime: timestamp,
        quality: (req.query.quality as string) || (req.query.res as string) || '720p',
        format: requestedFormat,
        crop: {
          crop_x: crop_x as string,
          crop_y: crop_y as string,
          crop_w: crop_w as string,
          crop_h: crop_h as string,
        },
      });

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Content-Type', result.isPng ? 'image/png' : 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Chunk-Offset', String(result.chunkOffset));
      res.setHeader('X-Local-Time', String(result.localTime));
      res.setHeader('X-Global-Time', String(result.globalTime));
      res.setHeader('X-Chunk-Duration', String(result.chunkDuration));
      res.setHeader('X-From-Cache', String(result.fromCache));

      if (isDownload) {
        const safeTitle = cleanUnicodeFileName((title as string) || 'twitch_live', 'frame');
        const timeStr = `${Math.floor(timestamp / 60)}m${Math.floor(timestamp % 60)}s`;
        res.setHeader('Content-Disposition', getSafeContentDisposition(`${safeTitle}_frame_${timeStr}.${result.ext}`));
      }

      return fs.createReadStream(result.filePath).pipe(res);
    } catch (liveErr: any) {
      console.error('[Twitch Live Frame Error in /frame]', liveErr.message);
      return res.status(500).json({ error: `Failed to extract live frame: ${liveErr.message}` });
    }
  }

  const activeStreamUrl = (streamUrl as string) || (directUrl as string);

  try {
    const result = await FrameExtractorService.extractMaxQualityFrame({
      targetUrl,
      timestamp,
      isFullRes,
      format: requestedFormat,
      quality: (req.query.quality as string) || (req.query.res as string) || '2160p',
      crop: {
        crop_x: crop_x as string,
        crop_y: crop_y as string,
        crop_w: crop_w as string,
        crop_h: crop_h as string,
      },
      streamUrl: activeStreamUrl,
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Content-Type', result.isPng ? 'image/png' : 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (isDownload) {
      const safeTitle = cleanUnicodeFileName((title as string) || 'video', 'frame');
      const timeStr = `${Math.floor(timestamp / 60)}m${Math.floor(timestamp % 60)}s`;
      res.setHeader('Content-Disposition', getSafeContentDisposition(`${safeTitle}_frame_${timeStr}.${result.ext}`));
    }

    return fs.createReadStream(result.filePath).pipe(res);
  } catch (err: any) {
    console.error('[Frame Error]', err.message);
    return res.status(500).json({ error: `Failed to extract frame: ${err.message}` });
  }
});

/**
 * High-performance streaming proxy for Twitter, Instagram, TikTok, Reddit, HLS/MP4 streams
 * Forwards Range requests (206 Partial Content) with zero CORS restrictions.
 */
router.get('/proxy-stream', async (req: Request, res: Response) => {
  const streamUrl = req.query.url as string;
  if (!streamUrl) return res.status(400).json({ error: 'url is required' });

  const host = req.protocol + '://' + req.get('host');
  const isSegment = streamUrl.includes('.ts') || streamUrl.includes('.m4s') || streamUrl.includes('.mp4');
  console.log(`[Proxy Stream 📥] ${isSegment ? 'Segment' : 'Stream'} fetching: ${streamUrl.substring(0, 90)}...`);

  try {
    const range = req.headers.range;
    const fetchHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (streamUrl.includes('twimg.com')) {
      fetchHeaders['Referer'] = 'https://x.com/';
      fetchHeaders['Origin'] = 'https://x.com';
    } else if (streamUrl.includes('instagram.com') || streamUrl.includes('cdninstagram.com')) {
      fetchHeaders['Referer'] = 'https://www.instagram.com/';
      fetchHeaders['Origin'] = 'https://www.instagram.com';
    } else if (streamUrl.includes('ttvnw.net') || streamUrl.includes('twitch.tv') || streamUrl.includes('cloudfront.net')) {
      fetchHeaders['Referer'] = 'https://www.twitch.tv/';
      fetchHeaders['Origin'] = 'https://www.twitch.tv';
      fetchHeaders['Client-ID'] = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    }

    if (range) {
      fetchHeaders['Range'] = range;
    }

    const remoteRes = await fetch(streamUrl, {
      headers: fetchHeaders,
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.setHeader('Accept-Ranges', 'bytes');

    const contentType = remoteRes.headers.get('content-type') || 'video/mp4';
    const isM3u8 = streamUrl.toLowerCase().includes('.m3u8') || 
                   contentType.toLowerCase().includes('mpegurl') || 
                   contentType.toLowerCase().includes('application/x-mpegurl');

    if (isM3u8) {
      const playlistText = await remoteRes.text();
      const rewrittenLines = playlistText.split('\n').map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Rewrite URI="..." in tags (e.g. #EXT-X-KEY, #EXT-X-MAP, etc.)
        if (trimmed.startsWith('#')) {
          if (trimmed.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
            return '#EXT-X-PLAYLIST-TYPE:VOD';
          }
          return line.replace(/URI="([^"]+)"/g, (match, uri) => {
            try {
              const absUrl = new URL(uri, streamUrl).toString();
              return `URI="${host}/api/video/proxy-stream?url=${encodeURIComponent(absUrl)}"`;
            } catch {
              return match;
            }
          });
        }

        // Segment or sub-playlist URI line
        try {
          const absUrl = new URL(trimmed, streamUrl).toString();
          if (absUrl.includes('.m3u8')) {
            return `${host}/api/video/hls-proxy?url=${encodeURIComponent(absUrl)}`;
          }
          if (absUrl.includes('cloudfront.net') || absUrl.includes('ttvnw.net')) {
            return absUrl;
          }
          return `${host}/api/video/proxy-stream?url=${encodeURIComponent(absUrl)}`;
        } catch {
          return line;
        }
      });

      const hasSegments = rewrittenLines.some((l) => !l.startsWith('#') && l.trim().length > 0);
      if (hasSegments) {
        if (!rewrittenLines.some((l) => l.startsWith('#EXT-X-PLAYLIST-TYPE:'))) {
          rewrittenLines.splice(1, 0, '#EXT-X-PLAYLIST-TYPE:VOD');
        }
        if (!rewrittenLines.some((l) => l.trim() === '#EXT-X-ENDLIST')) {
          rewrittenLines.push('#EXT-X-ENDLIST');
        }
      }

      const rewrittenPlaylist = rewrittenLines.join('\n');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Content-Length', Buffer.byteLength(rewrittenPlaylist));
      return res.status(200).send(rewrittenPlaylist);
    }

    // For HLS segments (.ts, .m4s), always set the correct MIME type
    // Twitch CDN returns binary/octet-stream which hls.js may reject
    const isTs = streamUrl.toLowerCase().includes('.ts') || streamUrl.toLowerCase().endsWith('-muted.ts');
    const isM4s = streamUrl.toLowerCase().includes('.m4s');
    let finalContentType = contentType;
    if (isTs || finalContentType.toLowerCase().includes('octet-stream')) {
      finalContentType = 'video/mp2t';
    } else if (isM4s) {
      finalContentType = 'video/iso.segment';
    }
    res.setHeader('Content-Type', finalContentType);

    const contentLength = remoteRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = remoteRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    res.status(remoteRes.status);

    if (!remoteRes.body) {
      return res.end();
    }

    const { Readable } = await import('stream');
    const nodeStream = Readable.fromWeb(remoteRes.body as any);

    nodeStream.on('error', (streamErr: any) => {
      if (streamErr?.code !== 'UND_ERR_SOCKET' && !streamErr?.message?.includes('closed') && !streamErr?.message?.includes('aborted')) {
        console.warn('[Proxy Stream Notice]', streamErr.message);
      }
      try { nodeStream.destroy(); } catch {}
    });

    req.on('close', () => {
      try { nodeStream.destroy(); } catch {}
    });

    res.on('error', () => {
      try { nodeStream.destroy(); } catch {}
    });

    nodeStream.pipe(res);
  } catch (err: any) {
    console.error('[Proxy Stream Error ❌]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: `Proxy stream failed: ${err.message}` });
    }
  }
});

router.post('/metadata', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Video URL is required' });

  try {
    const metadata: any = await YtDlpService.getVideoMetadata(url);

    // Prioritize formats with BOTH video AND audio so UI preview can play sound
    const audioAndVideoFormats = (metadata.formats || []).filter(
      (f: any) => f.url && f.acodec !== 'none' && f.vcodec !== 'none' && !f.format_id?.endsWith('v')
    );
    const audioFormats = (metadata.formats || []).filter(
      (f: any) => f.url && f.acodec !== 'none' && !f.format_id?.endsWith('v')
    );
    const progressiveMp4 = (metadata.formats || []).filter(
      (f: any) => f.url && f.vcodec !== 'none' && f.acodec !== 'none'
    );

    // Try finding 1080p or 720p format first
    const format1080 = progressiveMp4.find((f: any) => (f.height === 1080 || f.width === 1080 || f.resolution?.includes('1080')));
    const format720 = progressiveMp4.find((f: any) => (f.height === 720 || f.width === 720 || f.resolution?.includes('720')));

    const directStreamUrl =
      format1080?.url ||
      format720?.url ||
      (progressiveMp4.length > 0 ? progressiveMp4[progressiveMp4.length - 1].url : undefined) ||
      (audioAndVideoFormats.length > 0 ? audioAndVideoFormats[audioAndVideoFormats.length - 1].url : undefined) ||
      metadata.direct_stream_url ||
      (audioFormats.length > 0 ? audioFormats[audioFormats.length - 1].url : undefined) ||
      metadata.url ||
      (metadata.formats && metadata.formats.length > 0
        ? (metadata.formats.filter((f: any) => f.url && f.vcodec !== 'none').pop()?.url ||
           metadata.formats[metadata.formats.length - 1]?.url)
        : undefined);

    let parsedDuration = typeof metadata.duration === 'number' && metadata.duration > 0 ? metadata.duration : undefined;
    if (!parsedDuration && metadata.duration_string) {
      const parts = String(metadata.duration_string).split(':').map((p: string) => parseFloat(p));
      if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        parsedDuration = Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
      } else if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        parsedDuration = Math.round(parts[0] * 60 + parts[1]);
      }
    }

    let thumbnail = metadata.thumbnail;
    if ((!thumbnail || thumbnail.includes('404_processing')) && metadata.thumbnails && metadata.thumbnails.length > 0) {
      const validThumbs = metadata.thumbnails.filter((t: any) => t.url && !t.url.includes('404_processing'));
      if (validThumbs.length > 0) thumbnail = validThumbs[validThumbs.length - 1].url;
    }
    if ((!thumbnail || thumbnail.includes('404_processing')) && (url.includes('twitch.tv') || metadata.extractor_key?.includes('Twitch') || metadata.uploader)) {
      const channel = metadata.uploader || metadata.channel || (url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i)?.[1]);
      if (channel && !['directory', 'videos', 'clip'].includes(channel.toLowerCase())) {
        thumbnail = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel.toLowerCase()}-640x360.jpg`;
      }
    }

    const isLive = Boolean(
      metadata.is_live === true ||
      metadata.live_status === 'is_live' ||
      url.toLowerCase().includes('youtube.com/live') ||
      url.toLowerCase().includes('/live/') ||
      url.toLowerCase().includes('youtu.be/live') ||
      ((url.toLowerCase().includes('twitch.tv/') || url.toLowerCase().includes('kick.com/')) &&
        !url.toLowerCase().includes('/clip') &&
        !url.toLowerCase().includes('/video') &&
        !url.toLowerCase().includes('/videos'))
    );

    // Determine the best URL to use for segment extraction (preview-segment endpoint).
    // For Twitch channel URLs the metadata service resolves to a VOD, so use webpage_url.
    const vodUrl =
      metadata.webpage_url ||
      metadata.channel_url ||
      url;

    const response = {
      id: metadata.id,
      title: metadata.title,
      thumbnail: thumbnail,
      duration: parsedDuration,
      duration_string: metadata.duration_string,
      is_live: isLive,
      live_status: metadata.live_status || (isLive ? 'is_live' : 'not_live'),
      release_timestamp: metadata.release_timestamp || metadata.timestamp,
      uploader: metadata.uploader,
      view_count: metadata.view_count,
      upload_date: metadata.upload_date,
      platform: metadata.extractor_key || metadata.extractor || 'generic',
      direct_stream_url: directStreamUrl,
      // The URL yt-dlp resolved to (VOD URL for Twitch channels).
      // Frontend should use this for /api/video/preview-segment requests.
      webpage_url: vodUrl,
      subtitles: Object.keys(metadata.subtitles || {}),
      automatic_captions: Object.keys(metadata.automatic_captions || {}),
      formats: metadata.formats?.map((f: any) => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution,
        height: f.height,
        width: f.width,
        filesize: f.filesize,
        vcodec: f.vcodec,
        acodec: f.acodec,
        format_note: f.format_note,
        tbr: f.tbr,
        url: f.url,
      })) || [],
    };

    res.json(response);
  } catch (error: any) {
    let msg = error.message || 'Failed to fetch video metadata';
    if (msg.includes('No video could be found') || msg.includes('There is no video in this tweet') || msg.includes('No video')) {
      msg = 'No video could be found in this tweet/post. Please make sure the link contains an active video or clip.';
    }
    res.status(500).json({ error: msg });
  }
});

// ─── /download (Direct Terminal Execution) ──────────────────────────────────
router.post('/download', async (req: Request, res: Response) => {
  const { url, format = 'mp4', quality = '720p', trimStart = 0, trimEnd, audioBitrate = '192k', aspectRatio, fitMode = 'pad', cropPosition = 'center', cropBox, customFileName } = req.body;

  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    let ytFormat: string;
    const audioFlags: string[] = [];

    if (format === 'mp4') {
      const height = quality.replace('p', '');
      // No [ext=mp4] on video: YouTube serves 1080p+ as VP9/webm which is fine,
      // ffmpeg will remux/encode to mp4 via --merge-output-format mp4.
      ytFormat = `bestvideo[height=${height}]+bestaudio[ext=m4a]/bestvideo[height=${height}]+bestaudio/bestvideo[height<=${height}]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
      audioFlags.push('--merge-output-format', 'mp4');
    } else {
      ytFormat = 'bestaudio/best';
      audioFlags.push('--extract-audio', '--audio-format', format, '--audio-quality', audioBitrate);
    }

    let vfFilter = '';
    if (format === 'mp4' && aspectRatio && aspectRatio !== 'original' && aspectRatio !== '16:9') {
      const isPad = req.body.fitMode === 'pad';

      if (aspectRatio === '9:16') {
        vfFilter = isPad ? 'pad=ceil(max(iw\\,ih*9/16)/2)*2:ceil(max(ih\\,iw*16/9)/2)*2:(ow-iw)/2:(oh-ih)/2:color=black' : 'crop=ih*9/16:ih';
      } else if (aspectRatio === '1:1') {
        vfFilter = isPad ? 'pad=ceil(max(iw\\,ih)/2)*2:ceil(max(ih\\,iw)/2)*2:(ow-iw)/2:(oh-ih)/2:color=black' : 'crop=ih:ih';
      } else if (aspectRatio === '4:5') {
        vfFilter = isPad ? 'pad=ceil(max(iw\\,ih*4/5)/2)*2:ceil(max(ih\\,iw*5/4)/2)*2:(ow-iw)/2:(oh-ih)/2:color=black' : 'crop=ih*4/5:ih';
      }
    }

    const effectiveTrimEnd = trimEnd || 9999999;
    const outputDir = `%USERPROFILE%\\Downloads`;

    let fileNameTemplate = '%(title)s';
    if (customFileName) {
      // Basic sanitize for safe filename on windows
      fileNameTemplate = customFileName.replace(/[<>:"/\\|?*]/g, '_');
    }
    const extName = format === 'mp4' ? 'mp4' : '%(ext)s';
    const outputPath = `${outputDir}\\${fileNameTemplate}.${extName}`;

    // ── Handle direct media URLs (like FastDL) ─────────────────────────────────
    if (url.includes('media.fastdl.app') || (url.includes('.mp4') && !url.includes('instagram.com') && !url.includes('twitter.com') && !url.includes('x.com'))) {
      console.log(`[Download] Detected direct media URL. Downloading natively via fetch...`);
      const directOutputPath = `${outputDir}\\${fileNameTemplate === '%(title)s' ? 'media_video' : fileNameTemplate}.mp4`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });

      if (!response.ok) {
        throw new Error(`Failed to download direct media: ${response.statusText}`);
      }

      const fileStream = fs.createWriteStream(directOutputPath);
      pipeline(response.body as any, fileStream).then(() => {
        console.log(`[Download] Successfully downloaded direct media to ${directOutputPath}`);
      }).catch(err => {
        console.error(`[Download] Error saving direct media:`, err);
      });

      return res.json({
        success: true,
        message: 'Direct media download started to your Downloads folder!',
        command: `Downloading directly via node fetch`,
      });
    }

    // ── Check if request is for Cloud Server processing (Direct Web Download) ──
    const mode = req.body.mode || (req.headers['x-download-mode'] as string) || 'server';

    if (mode === 'server') {
      const safeTitle = cleanUnicodeFileName(customFileName, 'clipflow_clip');
      // clientJobId is sent from frontend so we can emit real-time progress via Socket.io
      const clientJobId: string | undefined = req.body.clientJobId;

      const emitProgress = (phase: string, percent?: number, speed?: string) => {
        if (clientJobId) {
          SocketService.emitProgress(clientJobId, { phase, percent, speed });
        }
      };

      // ── Handle Captions Export (SRT, VTT, TXT) ──
      if (format === 'srt' || format === 'vtt' || format === 'txt' || format === 'captions') {
        const targetFmt = format === 'vtt' ? 'vtt' : format === 'txt' ? 'txt' : 'srt';
        const lang = req.body.captionLang || 'en';
        const relativeTimecodes = req.body.relativeTimecodes !== false;

        emitProgress('📝 Fetching and trimming captions...', 25);
        const captionResult = await fetchAndTrimCaptions({
          url,
          format: targetFmt,
          lang,
          trimStart: Number(trimStart) || 0,
          trimEnd: trimEnd !== undefined && Number(trimEnd) > Number(trimStart) ? Number(trimEnd) : undefined,
          relativeTimecodes,
        });

        if (captionResult.cueCount === 0) {
          if (fs.existsSync(captionResult.filePath)) {
            try { fs.unlinkSync(captionResult.filePath); } catch {}
          }
          return res.status(400).json({
            error: 'This video does not have any captions or subtitles available in the requested language.',
          });
        }

        const finalFileName = `${safeTitle}.${targetFmt}`;
        return res.json({
          success: true,
          mode: 'server',
          downloadUrl: `/api/video/file/${path.basename(captionResult.filePath)}?name=${encodeURIComponent(finalFileName)}`,
          fileName: finalFileName,
          message: `Captions trimmed successfully (${captionResult.cueCount} cues)!`,
        });
      }

      const isAudio = format === 'mp3' || format === 'wav' || format === 'm4a' || format === 'aac';
      const ext = isAudio ? format : 'mp4';
      const jobId = crypto.randomBytes(8).toString('hex');

      const tempRawFile = path.join(TEMP_DIR, `${jobId}_raw.${ext}`);
      const finalFile = path.join(TEMP_DIR, `${jobId}.${ext}`);

      const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
      const isInstagram = url.includes('instagram.com');
      const isTwitter = url.includes('twitter.com') || url.includes('x.com');
      const isTwitch = url.includes('twitch.tv');

      // ── Modular Platform Downloader Dispatcher ───────────────────────────
      if (isYouTube) {
        // Handled by: src/services/youtube/yt-downloader.service.ts
        await YouTubeDownloaderService.downloadClip({
          url,
          format,
          quality,
          audioQuality: req.body.audioQuality || req.body.audioBitrate || '0',
          trimStart: Number(trimStart) || 0,
          trimEnd: trimEnd !== undefined ? Number(trimEnd) : undefined,
          aspectRatio,
          fitMode,
          cropPosition,
          cropBox,
          tempRawFile,
          finalFile,
          ytDlpBin: YTDLP_BIN,
          ffmpegBin: FFMPEG_BIN,
          onProgress: (phase, percent, speed) => emitProgress(phase, percent, speed),
        });
      } else if (isInstagram) {
        // Handled by: src/services/instagram/instagram-downloader.service.ts
        await InstagramDownloaderService.downloadClip({
          url,
          format,
          quality,
          audioQuality: req.body.audioQuality || req.body.audioBitrate || '0',
          trimStart: Number(trimStart) || 0,
          trimEnd: trimEnd !== undefined ? Number(trimEnd) : undefined,
          aspectRatio,
          fitMode,
          cropPosition,
          cropBox,
          tempRawFile,
          finalFile,
          ytDlpBin: YTDLP_BIN,
          ffmpegBin: FFMPEG_BIN,
          onProgress: (phase, percent, speed) => emitProgress(phase, percent, speed),
        });
      } else if (isTwitter) {
        // Handled by: src/services/twitter/twitter-downloader.service.ts
        await TwitterDownloaderService.downloadClip({
          url,
          format,
          quality,
          audioQuality: req.body.audioQuality || req.body.audioBitrate || '0',
          trimStart: Number(trimStart) || 0,
          trimEnd: trimEnd !== undefined ? Number(trimEnd) : undefined,
          aspectRatio,
          fitMode,
          cropPosition,
          cropBox,
          tempRawFile,
          finalFile,
          ytDlpBin: YTDLP_BIN,
          ffmpegBin: FFMPEG_BIN,
          onProgress: (phase, percent, speed) => emitProgress(phase, percent, speed),
        });
      } else if (isTwitch) {
        // Handled by: src/services/twitch/twitch-downloader.service.ts
        await TwitchDownloaderService.downloadClip({
          url,
          format,
          quality,
          audioQuality: req.body.audioQuality || req.body.audioBitrate || '0',
          trimStart: Number(trimStart) || 0,
          trimEnd: trimEnd !== undefined ? Number(trimEnd) : undefined,
          aspectRatio,
          fitMode,
          cropPosition,
          cropBox,
          tempRawFile,
          finalFile,
          ytDlpBin: YTDLP_BIN,
          ffmpegBin: FFMPEG_BIN,
          onProgress: (phase, percent, speed) => emitProgress(phase, percent, speed),
        });
      } else {
        // Generic Platform Downloader
        const ytDlpArgs: string[] = [
          `"${YTDLP_BIN}"`,
          `--ffmpeg-location "${path.dirname(FFMPEG_BIN)}"`,
          '--js-runtimes node',
          '--no-warnings',
          '--no-check-certificate',
          '--no-playlist',
        ];

        if (isAudio) {
          const audioQuality = req.body.audioQuality || req.body.audioBitrate || '0';
          ytDlpArgs.push('-x', '--audio-format', format, '--audio-quality', String(audioQuality));
        } else {
          const heightLimit = YouTubeDownloaderService.parseHeightLimit(quality);
          const ytFormat = heightLimit
            ? `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]/bestvideo+bestaudio/best`
            : 'bestvideo+bestaudio/best';
          ytDlpArgs.push('-f', `"${ytFormat}"`, '--merge-output-format', 'mp4');
        }

        const isTrimmed = typeof trimEnd === 'number' && trimEnd > trimStart;
        const filterString = !isAudio ? getFFmpegAspectFilter(aspectRatio, fitMode, cropPosition, cropBox) : '';
        const needsCrop = !isAudio && Boolean(filterString);
        const downloadTarget = (isTrimmed || needsCrop) ? tempRawFile : finalFile;

        ytDlpArgs.push('-o', `"${downloadTarget}"`, `"${url}"`);

        console.log(`[Server Download] Running yt-dlp:\n${ytDlpArgs.join(' ')}`);
        emitProgress('⬇️ Downloading video...', 5);
        await execAsync(ytDlpArgs.join(' '));
        emitProgress('⬇️ Download complete', 75);

        if (isTrimmed || needsCrop) {
          const ffmpegArgs: string[] = [`"${FFMPEG_BIN}"`];
          if (isTrimmed) {
            ffmpegArgs.push(`-ss ${trimStart}`, `-to ${trimEnd}`);
          }
          ffmpegArgs.push(`-i "${tempRawFile}"`);

          if (needsCrop) {
            ffmpegArgs.push(`-vf "${filterString}"`, '-c:v libx264', '-preset fast', '-crf 20', '-c:a aac');
          } else {
            ffmpegArgs.push('-c copy', '-avoid_negative_ts make_zero');
          }
          ffmpegArgs.push('-y', `"${finalFile}"`);

          console.log(`[Server Download] Processing with FFmpeg:\n${ffmpegArgs.join(' ')}`);
          emitProgress('✂️ Cropping/trimming video...', 85);
          await execAsync(ffmpegArgs.join(' '));
          if (fs.existsSync(tempRawFile)) {
            try { fs.unlinkSync(tempRawFile); } catch (_) {}
          }
          emitProgress('✂️ Processing complete', 95);
        }
      }

      scheduleCleanup(finalFile, 30 * 60 * 1000);

      emitProgress('✅ Ready for download!', 100);
      const finalFileName = `${safeTitle}.${ext}`;
      return res.json({
        success: true,
        mode: 'server',
        downloadUrl: `/api/video/file/${jobId}.${ext}?name=${encodeURIComponent(finalFileName)}`,
        fileName: finalFileName,
        message: 'Clip processed successfully on server!',
      });
    }

    // ── Generate Pure PowerShell Workflow (Local PC Download) ───────────────
    const workflow = generatePowerShellWorkflow({
      url,
      format,
      quality,
      audioQuality: req.body.audioQuality || req.body.audioBitrate || '0',
      trimStart,
      trimEnd: trimEnd !== undefined ? Number(trimEnd) : undefined,
      aspectRatio,
      fitMode,
      customFileName,
    });

    // ── Apply Separate Crop & Cleanup Workflow ───────────────────────────────
    const cropPipeline = buildCropWorkflow(workflow.powerShellScript, {
      url,
      format,
      quality,
      audioQuality: req.body.audioQuality || req.body.audioBitrate || '0',
      trimStart,
      trimEnd: trimEnd !== undefined ? Number(trimEnd) : undefined,
      aspectRatio,
      fitMode,
      customFileName,
    });

    const scriptToExecute = cropPipeline.powerShellScript;

    console.log(`[Download] Opening PowerShell workflow:\n${scriptToExecute}`);

    const tempScriptPath = path.join(
      process.env.TEMP || 'C:\\Windows\\Temp',
      `clipflow_${Date.now()}.ps1`
    );
    const fullScript = `Set-Location "$env:USERPROFILE\\Documents"\n${scriptToExecute}`;
    fs.writeFileSync(tempScriptPath, '\uFEFF' + fullScript, 'utf8');

    if (req.body.openTerminal) {
      exec(`start powershell -NoExit -ExecutionPolicy Bypass -File "${tempScriptPath}"`);
    } else {
      exec(`powershell -ExecutionPolicy Bypass -File "${tempScriptPath}"`);
    }

    res.json({
      success: true,
      mode: 'local',
      message: 'Workflow started on your PC!',
      command: scriptToExecute,
    });
  } catch (err: any) {
    console.error('[Download] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── /file/:filename (serve generated server download with exact Unicode name) ─
router.get('/file/:filename', (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename as string); // prevent path traversal
  const filePath = path.join(TEMP_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  const ext = path.extname(filename).slice(1);
  const mimeMap: Record<string, string> = {
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    srt: 'application/x-subrip',
    vtt: 'text/vtt',
    txt: 'text/plain',
  };

  const customName = cleanUnicodeFileName((req.query.name as string), `clipflow-clip.${ext}`);
  res.setHeader('Content-Disposition', getSafeContentDisposition(customName));
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', fs.statSync(filePath).size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => res.status(500).end());
});

// ─── /trim (legacy, keep for compat) ─────────────────────────────────────────
router.post('/trim', async (req: Request, res: Response) => {
  res.status(410).json({ error: 'Use /download instead' });
});

// ─── /ai/analyze (Coming Soon) ──────────────────────────────────────────────
router.post('/ai/analyze', async (req: Request, res: Response) => {
  return res.status(404).json({
    error: 'AI Viral Moments & Hook Scanner is coming soon!',
    message: 'This feature is currently in development and will be available in an upcoming update.',
  });
});

// ─── /tools/download-helper & /tools/download-dlp ─────────────────────────────
router.get(['/tools/download-helper', '/tools/download-dlp'], (req: Request, res: Response) => {
  const possiblePaths = [
    path.join(process.cwd(), 'public', 'downloads', 'ClipFlow-Desktop-Companion.zip'),
    path.join(process.cwd(), '..', 'release', 'ClipFlow-Desktop-Companion.zip'),
    path.join(process.cwd(), '..', 'qt-app', 'dist', 'ClipFlow-Desktop-Companion.zip'),
    path.join(process.cwd(), 'download dlp.zip'),
  ];

  const foundPath = possiblePaths.find(p => fs.existsSync(p));
  if (!foundPath) {
    return res.status(404).json({ error: 'ClipFlow Desktop Companion package not found' });
  }

  res.setHeader('Content-Disposition', 'attachment; filename="ClipFlow-Desktop-Companion.zip"');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', fs.statSync(foundPath).size);
  const stream = fs.createReadStream(foundPath);
  stream.pipe(res);
  stream.on('error', () => res.status(500).end());
});

// ─── /thumbnail (download video thumbnail image) ─────────────────────────────
router.get('/thumbnail', async (req: Request, res: Response) => {
  const thumbnailUrl = req.query.url as string;
  const title = (req.query.title as string) || 'thumbnail';
  if (!thumbnailUrl) return res.status(400).json({ error: 'Thumbnail URL is required' });

  try {
    const response = await fetch(thumbnailUrl);
    if (!response.ok) throw new Error('Failed to fetch thumbnail image');

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const safeTitle = cleanUnicodeFileName(title, 'thumbnail');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Content-Disposition', getSafeContentDisposition(`${safeTitle}_thumbnail.jpg`));
    res.send(buffer);
  } catch (err: any) {
    console.error('Thumbnail download error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
