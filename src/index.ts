import express, { type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { SocketService } from './services/socket.service.js';
import videoRoutes from './routes/video.routes.js';
import authRoutes from './routes/auth.routes.js';
import googleRoutes from './routes/google.routes.js';
import videosRoutes from './routes/videos.routes.js';
import driveRoutes from './routes/drive.routes.js';
import twitchRoutes from './routes/twitch.routes.js';
import twitchLiveChannelRoutes from './routes/twitch-live-channel.routes.js';
import appRequestRoutes from './routes/app-request.routes.js';
import path from 'path';
import fs from 'fs';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Connect to MongoDB with auto-retry
const MONGODB_URI = process.env.MONGODB_URI;

const connectWithRetry = async () => {
  if (!MONGODB_URI) {
    console.warn('[DB] WARNING: MONGODB_URI is not set in environment variables!');
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log('[DB] Successfully connected to MongoDB Atlas database.');
  } catch (err: any) {
    console.error('[DB] MongoDB connection error:', err?.message || err);
    console.log('[DB] Retrying connection in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};

mongoose.connection.on('disconnected', () => {
  console.warn('[DB] MongoDB connection lost. Attempting reconnect...');
});

mongoose.connection.on('reconnected', () => {
  console.log('[DB] MongoDB reconnected successfully.');
});

connectWithRetry();

const httpServer = createServer(app);
SocketService.initialize(httpServer);

// Security Headers
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// CORS configuration supporting credentials (cookies)
const allowedOrigins = [
  FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive in dev/local
      }
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logger middleware
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

// Primary API Routes
app.use('/api/auth', authRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/auth/google', googleRoutes);
app.use('/api/videos', videosRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/twitch', twitchRoutes);
app.use('/api/twitch-live', twitchLiveChannelRoutes); // Live channel chunk preview (no CDN)
app.use('/api/app-requests', appRequestRoutes);
app.use('/api/waitlist', appRequestRoutes);

// Desktop Companion OTA Auto-Update Check Endpoint
app.get(['/api/app/update-check', '/api/app/version'], (req: Request, res: Response) => {
  const versionFileCandidates = [
    path.join(process.cwd(), 'backend', 'app-version.json'),
    path.join(process.cwd(), 'app-version.json'),
  ];
  const versionFile = versionFileCandidates.find(p => fs.existsSync(p));
  if (versionFile) {
    try {
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      const host = req.get('host') || 'localhost:3001';
      const protocol = req.protocol || 'http';
      const baseUrl = `${protocol}://${host}`;
      if (data.downloadUrl && data.downloadUrl.startsWith('/')) {
        data.downloadUrl = `${baseUrl}${data.downloadUrl}`;
      }
      return res.json(data);
    } catch (e: any) {
      console.error('[UpdateCheck Error]:', e.message);
    }
  }
  res.json({
    version: '1.0.0',
    downloadUrl: '/public/downloads/ClipFlowHelper.exe',
    changelog: 'Latest stable release',
  });
});

app.get(['/health', '/api/health'], (_req, res) => {
  res.json({
    status: 'ok',
    dbState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// Serve direct browser downloads with forced attachment Content-Disposition header
app.get('/public/downloads/:filename', (req: Request, res: Response) => {
  let raw = req.params.filename as string;
  try { raw = decodeURIComponent(raw); } catch {}
  const filename = path.basename(raw);

  const candidates = [
    path.join(process.cwd(), 'backend', 'public', 'downloads', filename),
    path.join(process.cwd(), 'public', 'downloads', filename),
  ];

  const filePath = candidates.find(c => fs.existsSync(c));

  if (!filePath) {
    console.warn(`[Download] File not found in public downloads: "${filename}"`);
    return res.status(404).json({ error: 'File not found or download link expired' });
  }

  // Extract clean display file name without jobId prefix (e.g. "b3aae3b532804bee_Title.mp3" -> "Title.mp3")
  const displayName = filename.includes('_') ? filename.slice(filename.indexOf('_') + 1) : filename;

  res.download(filePath, displayName, (err) => {
    if (err && !res.headersSent) {
      console.error('[Download Error]:', err.message);
      res.status(500).json({ error: 'Failed to download file' });
    }
  });
});

// Serve public static folder (downloads, assets)
const publicDirCandidates = [
  path.join(process.cwd(), 'backend', 'public'),
  path.join(process.cwd(), 'public'),
];
const publicDir = publicDirCandidates.find(p => fs.existsSync(p)) || path.join(process.cwd(), 'public');
app.use('/public', express.static(publicDir));

// Serve production frontend bundle if built
const frontendDist = path.join(process.cwd(), '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('{*path}', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server Error] Port ${port} is already in use by another running instance.`);
    console.error(`[Server Error] Please stop the other running backend process before starting a new one.`);
    process.exit(1);
  } else {
    console.error(`[Server Error]`, err);
    process.exit(1);
  }
});

httpServer.listen(port, () => {
  console.log(`[Server] Production Server is running on port ${port}`);
  console.log(`[Server] Allowed Frontend Origin: ${FRONTEND_URL}`);
});

process.on('SIGINT', () => {
  console.log('\n[Server] Stopping backend server (SIGINT)...');
  try { httpServer.close(); } catch {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  try { httpServer.close(); } catch {}
  process.exit(0);
});

export default app;
