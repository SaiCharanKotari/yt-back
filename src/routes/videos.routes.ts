import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  requireAuth,
  requireVerifiedEmail,
  requirePlan,
  AuthenticatedRequest,
} from '../middlewares/auth.middleware.js';
import { VideoService } from '../services/video.service.js';
import { GoogleDriveService } from '../services/google-drive.service.js';
import { getSafeContentDisposition } from '../utils/i18n-filename.util.js';

const router = Router();
const TEMP_DIR = path.join(process.cwd(), 'temp', 'uploads');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Multer storage configuration for video uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2 GB max upload size per file
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video or audio files are supported'));
    }
  },
});

// ─── POST /api/videos/upload ────────────────────────────────────────────────
// Uploads a video file to Google Drive and tracks metadata in MongoDB
router.post(
  '/upload',
  requireAuth,
  requireVerifiedEmail,
  requirePlan('pro'),
  upload.single('video'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const localFilePath = req.file.path;

    try {
      const fileName = req.body.fileName || req.file.originalname;
      const mimeType = req.file.mimetype || 'video/mp4';
      const duration = parseFloat(req.body.duration || '0') || 0;
      const thumbnail = req.body.thumbnail || '';

      const video = await VideoService.uploadVideo({
        userId: req.user!._id,
        filePath: localFilePath,
        fileName,
        mimeType,
        duration,
        thumbnail,
      });

      // Cleanup local temp file
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
      }

      res.status(201).json({
        success: true,
        message: 'Video uploaded successfully to Google Drive',
        video: {
          id: video._id.toString(),
          fileName: video.fileName,
          size: video.size,
          duration: video.duration,
          mimeType: video.mimeType,
          thumbnail: video.thumbnail,
          driveFileId: video.driveFileId,
          createdAt: video.createdAt,
        },
      });
    } catch (err: any) {
      // Cleanup local temp file on error
      if (fs.existsSync(localFilePath)) {
        try {
          fs.unlinkSync(localFilePath);
        } catch (_) {}
      }

      console.error('[Video Upload Error]', err);
      res.status(500).json({ error: err.message || 'Failed to upload video to Google Drive' });
    }
  }
);

// ─── GET /api/videos ────────────────────────────────────────────────────────
// Lists the authenticated user's isolated cloud videos
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 20;

  try {
    const result = await VideoService.listUserVideos(req.user!._id, page, limit);

    res.json({
      success: true,
      videos: result.videos.map((v) => ({
        id: v._id.toString(),
        fileName: v.fileName,
        size: v.size,
        duration: v.duration,
        mimeType: v.mimeType,
        thumbnail: v.thumbnail,
        driveFileId: v.driveFileId,
        createdAt: v.createdAt,
      })),
      pagination: {
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
        limit,
      },
      storage: {
        used: req.user!.storageUsed,
        limit: req.user!.storageLimit,
        remaining: Math.max(0, req.user!.storageLimit - req.user!.storageUsed),
      },
    });
  } catch (err: any) {
    console.error('[List Videos Error]', err);
    res.status(500).json({ error: 'Failed to retrieve cloud storage files' });
  }
});

// ─── GET /api/videos/:id ────────────────────────────────────────────────────
// Retrieves single video metadata (ownership verified)
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const videoId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const video = await VideoService.getVideoById(req.user!._id, videoId);

    res.json({
      success: true,
      video: {
        id: video._id.toString(),
        fileName: video.fileName,
        size: video.size,
        duration: video.duration,
        mimeType: video.mimeType,
        thumbnail: video.thumbnail,
        driveFileId: video.driveFileId,
        createdAt: video.createdAt,
      },
    });
  } catch (err: any) {
    res.status(404).json({ error: err.message || 'Video not found' });
  }
});

// ─── GET /api/videos/:id/download ───────────────────────────────────────────
// Downloads/streams the video from Google Drive (ownership verified)
router.get('/:id/download', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const videoId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const video = await VideoService.getVideoById(req.user!._id, videoId);
    console.log(`[Video Download] 📥 User requested download for video: "${video.fileName}" (ID: ${videoId})`);
    const { stream, fileName, mimeType, size } = await GoogleDriveService.getDownloadStream(
      req.user!._id,
      video.driveFileId
    );

    console.log(`[Video Download] 🌊 Streaming "${fileName || video.fileName}" (${size ? (size / (1024 * 1024)).toFixed(2) + ' MB' : 'chunked'}) directly from Master Google Drive to client.`);
    res.setHeader('Content-Type', mimeType || 'video/mp4');
    res.setHeader('Content-Disposition', getSafeContentDisposition(fileName || video.fileName));
    if (size) {
      res.setHeader('Content-Length', size);
    }

    stream.pipe(res);
  } catch (err: any) {
    console.error('❌ [Video Download Error]:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Failed to download file from Google Drive' });
    }
  }
});

// ─── DELETE /api/videos/:id ─────────────────────────────────────────────────
// Deletes video from Google Drive and MongoDB (ownership verified)
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const videoId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    await VideoService.deleteVideo(req.user!._id, videoId);

    res.json({
      success: true,
      message: 'Video deleted successfully from Google Drive.',
    });
  } catch (err: any) {
    console.error('[Video Delete Error]', err.message);
    res.status(400).json({ error: err.message || 'Failed to delete video' });
  }
});

export default router;
