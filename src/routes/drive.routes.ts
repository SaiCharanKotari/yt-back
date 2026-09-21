import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middlewares/auth.middleware.js';
import { GoogleDriveService } from '../services/google-drive.service.js';
import { VideoService } from '../services/video.service.js';
import { SocketService } from '../services/socket.service.js';
import { cleanUnicodeFileName } from '../utils/i18n-filename.util.js';
import { formatSecondsToTime } from '../services/command-generator.service.js';
import { getFFmpegAspectFilter } from '../services/video-crop.service.js';
import { fetchAndTrimCaptions } from '../services/captions.service.js';
import { YouTubeDownloaderService } from '../services/youtube/index.js';
import { InstagramDownloaderService } from '../services/instagram/index.js';
import { TwitterDownloaderService } from '../services/twitter/index.js';
import { TwitchDownloaderService } from '../services/twitch/index.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

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

function resolvePublicDownloadsDir(): string {
  const candidates = [
    path.join(process.cwd(), 'public', 'downloads'),
    path.join(process.cwd(), 'backend', 'public', 'downloads'),
  ];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) fs.mkdirSync(c, { recursive: true });
      return c;
    } catch {}
  }
  const fallback = path.join(process.cwd(), 'public', 'downloads');
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
const TEMP_DIR = resolveTempDir();
const PUBLIC_DOWNLOADS_DIR = resolvePublicDownloadsDir();

const router = Router();

// ─── POST /api/drive/export ─────────────────────────────────────────────────
// Exports a video/audio clip or captions directly to the user's Google Drive
router.post('/export', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const {
    url,
    format = 'mp4',
    quality = '720p',
    trimStart = 0,
    trimEnd,
    audioBitrate = '192k',
    audioQuality,
    aspectRatio,
    fitMode = 'pad',
    cropPosition = 'center',
    cropBox,
    customFileName,
    clientJobId,
    subtitleLang = 'en',
    relativeTimecodes = true,
  } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Video URL is required' });
  }

  const userId = req.user!._id;
  const safeTitle = cleanUnicodeFileName(customFileName, 'clipflow_clip');

  const emitProgress = (phase: string, percent?: number, speed?: string) => {
    if (clientJobId) {
      SocketService.emitProgress(clientJobId, { phase, percent, speed });
    }
  };

  try {
    console.log('\n' + '═'.repeat(60));
    console.log(`🎬 [ClipFlow Export] NEW REQUEST RECEIVED`);
    console.log(`   • URL: ${url}`);
    console.log(`   • User ID: ${userId} (${req.user?.email || 'Authenticated User'})`);
    console.log(`   • Format: ${format} | Quality: ${quality} | Audio: ${audioBitrate}`);
    console.log(`   • Trim: ${trimStart}s -> ${trimEnd ?? 'End'}s`);
    console.log(`   • Custom File Name: ${safeTitle}`);
    console.log('═'.repeat(60));

    emitProgress('⚡ Initializing export...', 5);

    // ── Handle Captions Export to Drive ──
    if (format === 'srt' || format === 'vtt' || format === 'txt' || format === 'captions') {
      const targetFmt = format === 'vtt' ? 'vtt' : format === 'txt' ? 'txt' : 'srt';
      console.log(`[ClipFlow Export] 📝 Fetching and trimming captions (${targetFmt})...`);
      emitProgress('📝 Fetching and trimming captions...', 25);

      const captionResult = await fetchAndTrimCaptions({
        url,
        format: targetFmt,
        lang: subtitleLang,
        trimStart: Number(trimStart) || 0,
        trimEnd: trimEnd !== undefined && Number(trimEnd) > Number(trimStart) ? Number(trimEnd) : undefined,
        relativeTimecodes: relativeTimecodes !== false,
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
      const mimeType = targetFmt === 'vtt' ? 'text/vtt' : 'text/plain';

      console.log(`[ClipFlow Export] ☁️ Saving captions "${finalFileName}" to cloud storage...`);
      emitProgress('☁️ Saving clip in cloud...', 70);
      const video = await VideoService.uploadVideo({
        userId,
        filePath: captionResult.filePath,
        fileName: finalFileName,
        mimeType,
      });

      // Ensure public downloads directory exists for instant direct browser download
      const publicDownloadsDir = PUBLIC_DOWNLOADS_DIR;
      const publicCaptionPath = path.join(publicDownloadsDir, `${Date.now()}_${finalFileName}`);
      if (fs.existsSync(captionResult.filePath)) {
        try {
          fs.copyFileSync(captionResult.filePath, publicCaptionPath);
          setTimeout(() => {
            try {
              if (fs.existsSync(publicCaptionPath)) fs.unlinkSync(publicCaptionPath);
            } catch (_) {}
          }, 30 * 60 * 1000);
        } catch (_) {}
      }

      // Clean up temp file
      if (fs.existsSync(captionResult.filePath)) {
        fs.unlinkSync(captionResult.filePath);
      }

      console.log(`[ClipFlow Export] ✅ Captions saved to Master Google Drive! ID: ${video.driveFileId}`);
      console.log(`[ClipFlow Export] 📤 Sending download and library response to frontend.`);

      return res.json({
        success: true,
        file: video,
        fileName: finalFileName,
        downloadUrl: `/public/downloads/${encodeURIComponent(path.basename(publicCaptionPath))}`,
        driveDownloadUrl: `/api/videos/${video._id}/download`,
        message: `File "${finalFileName}" successfully downloaded & saved to cloud!`,
      });
    }

    // ── Handle Media (Video / Audio) Export to Drive ──
    const isAudio = format === 'mp3' || format === 'wav' || format === 'm4a' || format === 'aac';
    const ext = isAudio ? format : 'mp4';
    const mimeType = isAudio
      ? format === 'mp3'
        ? 'audio/mpeg'
        : format === 'wav'
        ? 'audio/wav'
        : 'audio/mp4'
      : 'video/mp4';

    const jobId = crypto.randomBytes(8).toString('hex');
    const tempRawFile = path.join(TEMP_DIR, `${jobId}_raw.${ext}`);
    const finalFile = path.join(TEMP_DIR, `${jobId}.${ext}`);
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    const isInstagram = url.includes('instagram.com');
    const isTwitter = url.includes('twitter.com') || url.includes('x.com');
    const isTwitch = url.includes('twitch.tv');
    const isTrimmed = typeof trimEnd === 'number' && trimEnd > trimStart;

    // ── Modular Platform Downloader Dispatcher ───────────────────────────
    if (isYouTube) {
      // Handled by: src/services/youtube/yt-downloader.service.ts
      await YouTubeDownloaderService.downloadClip({
        url,
        format,
        quality,
        audioQuality: audioQuality || audioBitrate || '0',
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
        audioQuality: audioQuality || audioBitrate || '0',
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
        audioQuality: audioQuality || audioBitrate || '0',
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
        audioQuality: audioQuality || audioBitrate || '0',
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
        const q = audioQuality || audioBitrate || '0';
        ytDlpArgs.push('-x', '--audio-format', format, '--audio-quality', String(q));
      } else {
        const heightLimit = YouTubeDownloaderService.parseHeightLimit(quality);
        const ytFormat = heightLimit
          ? `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]/bestvideo+bestaudio/best`
          : 'bestvideo+bestaudio/best';
        ytDlpArgs.push('-f', `"${ytFormat}"`, '--merge-output-format', 'mp4');
      }

      const filterString = !isAudio ? getFFmpegAspectFilter(aspectRatio, fitMode, cropPosition, cropBox) : '';
      const needsCrop = !isAudio && Boolean(filterString);
      const downloadTarget = (isTrimmed || needsCrop) ? tempRawFile : finalFile;

      ytDlpArgs.push('-o', `"${downloadTarget}"`, `"${url}"`);

      console.log(`[ClipFlow Export] ⬇️ Step 1/3: Rendering master stream with yt-dlp...`);
      emitProgress('⬇️ Processing clip on server...', 20);
      await execAsync(ytDlpArgs.join(' '));
      emitProgress('⚙️ Stream downloaded', 60);

      if (isTrimmed || needsCrop) {
        console.log(`[ClipFlow Export] ✂️ Processing trim & aspect filter with FFmpeg...`);
        emitProgress('✂️ Formatting clip...', 70);

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

        await execAsync(ffmpegArgs.join(' '));
        if (fs.existsSync(tempRawFile)) {
          try { fs.unlinkSync(tempRawFile); } catch (_) {}
        }
      }
    }

    const finalFileName = `${safeTitle}.${ext}`;
    const renderedSize = fs.existsSync(finalFile) ? fs.statSync(finalFile).size : 0;
    console.log(`[ClipFlow Export] 📦 Rendered size: ${(renderedSize / (1024 * 1024)).toFixed(2)} MB`);

    console.log(`[ClipFlow Export] ☁️ Step 2/3: Saving "${finalFileName}" to cloud storage...`);
    emitProgress('☁️ Saving clip in cloud...', 85);

    const uploadedVideo = await VideoService.uploadVideo({
      userId,
      filePath: finalFile,
      fileName: finalFileName,
      mimeType,
      duration: isTrimmed ? (trimEnd - trimStart) : 0,
    });

    console.log(`[ClipFlow Export] 💾 Step 3/3: Video indexed in MongoDB!`);
    console.log(`   • MongoDB Video ID: ${uploadedVideo._id}`);
    console.log(`   • Drive File ID: ${uploadedVideo.driveFileId}`);
    console.log(`   • Direct Download URL: /api/videos/${uploadedVideo._id}/download`);

    // Ensure public downloads directory exists for instant direct browser download
    const publicDownloadsDir = PUBLIC_DOWNLOADS_DIR;
    const publicDownloadPath = path.join(publicDownloadsDir, `${jobId}_${finalFileName}`);
    if (fs.existsSync(finalFile)) {
      try {
        fs.copyFileSync(finalFile, publicDownloadPath);
        // Schedule auto cleanup after 30 minutes
        setTimeout(() => {
          try {
            if (fs.existsSync(publicDownloadPath)) fs.unlinkSync(publicDownloadPath);
          } catch (_) {}
        }, 30 * 60 * 1000);
      } catch (e: any) {
        console.warn('[ClipFlow Export] Warning copying to public downloads:', e.message);
      }
    }

    // Clean up server temp file
    if (fs.existsSync(finalFile)) {
      try {
        fs.unlinkSync(finalFile);
      } catch (_) {}
    }

    emitProgress('✅ Export complete!', 100);
    console.log(`[ClipFlow Export] 🚀 Successfully sent response to frontend for user download!`);
    console.log('═'.repeat(60) + '\n');

    return res.json({
      success: true,
      file: uploadedVideo,
      fileName: finalFileName,
      downloadUrl: `/public/downloads/${jobId}_${encodeURIComponent(finalFileName)}`,
      driveDownloadUrl: `/api/videos/${uploadedVideo._id}/download`,
      message: `File "${finalFileName}" successfully downloaded & saved to cloud!`,
    });
  } catch (error: any) {
    console.error('\n❌ [ClipFlow Export Error]:', error.message || error);
    emitProgress(`❌ Export failed: ${error.message}`, 0);
    return res.status(500).json({ error: error.message || 'Failed to export clip' });
  }
});

// ─── GET /api/drive/files ───────────────────────────────────────────────────
// Lists clips from VideoService for user
router.get('/files', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const list = await VideoService.listUserVideos(req.user!._id);
    res.json({ success: true, files: list.videos });
  } catch (error: any) {
    console.error('[Drive Files Error]', error);
    res.status(500).json({ error: error.message || 'Failed to list cloud files' });
  }
});

// ─── DELETE /api/drive/files/:fileId ─────────────────────────────────────────
// Deletes a clip from Cloud Storage
router.delete('/files/:fileId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fileId = Array.isArray(req.params.fileId) ? req.params.fileId[0] : req.params.fileId;
    await VideoService.deleteVideo(req.user!._id, fileId);
    res.json({ success: true, message: 'File deleted from Cloud Storage' });
  } catch (error: any) {
    console.error('[Drive Delete Error]', error);
    res.status(500).json({ error: error.message || 'Failed to delete file from Cloud Storage' });
  }
});

// ─── GET /api/drive/quota ───────────────────────────────────────────────────
// Fetches storage quota info
router.get('/quota', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const quota = await GoogleDriveService.getStorageQuota(req.user!._id);
    res.json({ success: true, quota });
  } catch (error: any) {
    console.error('[Drive Quota Error]', error);
    res.status(500).json({ error: error.message || 'Failed to fetch storage quota' });
  }
});

export default router;
