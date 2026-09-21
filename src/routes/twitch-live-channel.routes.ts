import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import {
  TwitchLiveFrameService,
  TwitchLiveFrameValidationError,
} from '../services/twitch/twitch-live-frame.service.js';
import { TwitchStreamResolverService } from '../services/twitch/twitch-stream-resolver.service.js';
import { cleanUnicodeFileName, getSafeContentDisposition } from '../utils/i18n-filename.util.js';

const router = express.Router();

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

const YTDLP_BIN = resolveYtDlpBinary();

// OPTIONS preflight for live channel endpoints
router.options(['/stream-info', '/live-frame', '/live-chunk'], (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

/**
 * GET /api/twitch-live/stream-info
 *
 * Resolves direct HLS playback information for a Twitch channel, DVR VOD, or clip.
 * Utilizes single-flight in-flight promise deduplication and caching.
 *
 * Query params:
 *   url     — Twitch URL (e.g. https://www.twitch.tv/channel_name)
 *   quality — optional quality format limit (e.g. 1080p, 720p)
 */
router.get('/stream-info', async (req: Request, res: Response) => {
  const targetUrl = (req.query.url as string || '').trim();
  const quality = (req.query.quality as string || '').trim();
  const forceRefresh = req.query.forceRefresh === 'true' || req.query.forceRefresh === '1';

  if (!targetUrl) {
    return res.status(400).json({ error: 'url parameter is required' });
  }

  try {
    const result = await TwitchStreamResolverService.resolveStreamUrl(
      targetUrl,
      YTDLP_BIN,
      quality || undefined,
      forceRefresh
    );

    const host = req.protocol + '://' + req.get('host');
    let hlsUrl = result.streamUrl;
    if (result.streamUrl && result.streamUrl.includes('.m3u8')) {
      hlsUrl = `${host}/api/video/hls-proxy?url=${encodeURIComponent(result.streamUrl)}`;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    // No HTTP cache when forceRefresh; otherwise 15 min
    res.setHeader('Cache-Control', forceRefresh ? 'no-cache, no-store' : 'public, max-age=900');
    return res.json({
      streamUrl: hlsUrl,
      rawStreamUrl: result.streamUrl,
      sourceType: result.sourceType,
      vodId: result.vodId,
      channel: result.channel,
    });
  } catch (err: any) {
    console.error('[Twitch Stream Info Error]', err.message);
    if (!res.headersSent) {
      const rawMsg = err.message || '';
      if (/The channel is not currently live/i.test(rawMsg)) {
        return res.status(404).json({ error: 'The Twitch channel is not currently live.' });
      }
      const cleanMsg = rawMsg
        .replace(/[A-Za-z]:\\[^\n"]+/g, 'yt-dlp')
        .replace(/^Command failed:[^\n]+\n/g, '')
        .trim();
      return res.status(500).json({ error: cleanMsg || 'Failed to resolve Twitch stream' });
    }
  }
});

/**
 * GET /api/twitch-live/live-chunk
 * DEPRECATED: Chunk-based preview pipeline is replaced by direct HLS playback.
 */
router.get('/live-chunk', async (_req: Request, res: Response) => {
  return res.status(410).json({
    error: 'Chunk-based preview is deprecated. Please use direct HLS playback via /api/twitch-live/stream-info',
  });
});

/**
 * GET /api/twitch-live/live-frame
 *
 * Extracts a frame from the exact 5-second live chunk corresponding to the requested timeline position.
 *
 * Query params:
 *   url         — Twitch channel URL
 *   chunkOffset — start offset of the 5s chunk (e.g. 7435)
 *   localTime   — time offset inside that chunk in seconds (e.g. 3.25)
 *   globalTime  — global timestamp in seconds (optional alternative/validation)
 *   time        — alias for globalTime
 *   quality     — stream quality (default: 720p)
 *   format      — png (default) or jpg
 *   crop_x, crop_y, crop_w, crop_h — optional normalized crop bounds
 *   download    — 'true' or '1' to set attachment Content-Disposition
 *   title       — filename title for download
 */
router.get('/live-frame', async (req: Request, res: Response) => {
  const {
    url,
    chunkOffset,
    localTime,
    globalTime,
    time,
    quality = '720p',
    format = 'png',
    crop_x,
    crop_y,
    crop_w,
    crop_h,
    download,
    title,
  } = req.query;

  const targetUrl = (url as string || '').trim();
  const isDownload = download === 'true' || download === '1';

  try {
    const result = await TwitchLiveFrameService.extractLiveFrame({
      url: targetUrl,
      chunkOffset: chunkOffset as string,
      localTime: localTime as string,
      globalTime: globalTime as string,
      time: time as string,
      quality: quality as string,
      format: (format as string) || 'png',
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
      const timeStr = `${Math.floor(result.globalTime / 60)}m${Math.floor(result.globalTime % 60)}s`;
      res.setHeader(
        'Content-Disposition',
        getSafeContentDisposition(`${safeTitle}_frame_${timeStr}.${result.ext}`)
      );
    }

    return fs.createReadStream(result.filePath).pipe(res);
  } catch (err: any) {
    console.error('[Twitch Live Frame Error]', err.message);
    const statusCode =
      err instanceof TwitchLiveFrameValidationError || err.statusCode === 400 ? 400 : 500;
    if (!res.headersSent) {
      res.status(statusCode).json({ error: err.message || 'Failed to extract Twitch live frame' });
    }
  }
});

export default router;
