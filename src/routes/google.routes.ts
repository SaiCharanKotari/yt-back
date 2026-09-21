import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { GoogleOAuthService } from '../services/google-oauth.service.js';
import { SessionService } from '../services/session.service.js';
import {
  requireAuth,
  optionalAuth,
  AuthenticatedRequest,
} from '../middlewares/auth.middleware.js';
import { GoogleOAuthConnectionModel } from '../models/GoogleOAuthConnection.model.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ─── GET /api/google/connect & /api/auth/google ─────────────────────────────
// Initiates Google OAuth consent (works for 1-click registration/login OR linking Google Drive)
router.get(['/connect', '/'], optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user ? req.user._id.toString() : 'new';
    const { url } = GoogleOAuthService.generateConnectUrl(userId);

    if (req.query.format === 'json') {
      return res.json({ url });
    }
    return res.redirect(url);
  } catch (err: any) {
    console.error('[Google Connect Error]', err.message);
    return res.status(500).json({ error: 'Failed to generate Google Drive authorization URL' });
  }
});

// ─── GET /api/google/callback & /api/auth/google/callback ───────────────────
// Handles Google OAuth consent callback, signs in / registers user, sets session cookie, and connects Drive
router.get(['/callback', '/auth/callback'], async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;
  const error = req.query.error as string;

  if (error) {
    console.error('[Google Callback Error from Google]', error);
    return res.redirect(`${FRONTEND_URL}/login?auth_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/login?auth_error=missing_oauth_parameters`);
  }

  // 1. Handle Master Drive Authorization Flow (when state is missing or state === 'master')
  if (!state || state === 'master') {
    try {
      const masterClientId = process.env.GOOGLE_MASTER_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
      const masterClientSecret = process.env.GOOGLE_MASTER_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';

      const oauth2Client = new google.auth.OAuth2(masterClientId, masterClientSecret, redirectUri);
      const { tokens } = await oauth2Client.getToken(code);

      if (tokens.refresh_token) {
        const envPath = path.join(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, 'utf8');
          if (envContent.includes('GOOGLE_MASTER_REFRESH_TOKEN=')) {
            envContent = envContent.replace(
              /GOOGLE_MASTER_REFRESH_TOKEN=.*/,
              `GOOGLE_MASTER_REFRESH_TOKEN=${tokens.refresh_token}`
            );
          } else {
            envContent += `\nGOOGLE_MASTER_REFRESH_TOKEN=${tokens.refresh_token}\n`;
          }
          fs.writeFileSync(envPath, envContent, 'utf8');
        }
        process.env.GOOGLE_MASTER_REFRESH_TOKEN = tokens.refresh_token;

        console.log(`\n🎉 [Master Drive] Successfully linked Master 2TB Google Drive!`);
        console.log(`   • Refresh token saved to .env: ${tokens.refresh_token.slice(0, 15)}...`);

        return res.send(`
          <html>
            <body style="background:#09090b;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
              <div style="background:#121218;padding:32px;border-radius:16px;border:1px solid rgba(168,85,247,0.3);text-align:center;max-width:450px;">
                <h1 style="color:#4ade80;font-size:22px;margin-bottom:8px;">✅ 2TB Master Google Drive Connected!</h1>
                <p style="color:#94a3b8;font-size:14px;line-height:1.5;">Your owner 2TB Google Drive is now authorized as the centralized storage pool for all Pro exports.</p>
                <a href="${FRONTEND_URL}/editor/storage" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#9333ea;color:white;text-decoration:none;border-radius:10px;font-weight:bold;font-size:13px;">Go to ClipFlow Studio</a>
              </div>
            </body>
          </html>
        `);
      }
    } catch (masterErr: any) {
      console.warn('[Master Drive Token Exchange Warning]', masterErr.message);
    }
  }

  try {
    // Verify state signature and extract userId or 'new'
    const stateUserId = state ? GoogleOAuthService.verifyState(state) : 'new';

    // Exchange authorization code for user profile and encrypted tokens
    const { user } = await GoogleOAuthService.handleCallback(code, stateUserId);

    // Create / rotate server-side session and set secure HttpOnly cookie
    const existingSessionId = req.cookies?.sessionId;
    const { rawSessionId } = await SessionService.rotateSession(existingSessionId, user._id, req);
    SessionService.setSessionCookie(res, rawSessionId);

    console.log(`[Google OAuth] User authenticated and Drive connected: ${user.email}`);

    return res.redirect(`${FRONTEND_URL}/editor/storage?auth_status=success&connected=true`);
  } catch (err: any) {
    console.error('[Google Callback Exception]', err.message);
    return res.redirect(`${FRONTEND_URL}/login?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// ─── POST /api/google/disconnect ────────────────────────────────────────────
// Disconnects user's Google Drive integration
router.post('/disconnect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await GoogleOAuthService.disconnect(req.user!._id);
    res.json({
      success: true,
      message: 'Google Drive has been disconnected successfully.',
    });
  } catch (err: any) {
    console.error('[Google Disconnect Error]', err.message);
    res.status(500).json({ error: 'Failed to disconnect Google Drive' });
  }
});

// ─── GET /api/google/status ─────────────────────────────────────────────────
// Retrieves current Google Drive connection status
router.get('/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const connection = await GoogleOAuthConnectionModel.findOne({
      userId: req.user!._id,
      isConnected: true,
    });

    res.json({
      connected: Boolean(connection),
      googleEmail: connection?.googleEmail || null,
      folderConfigured: Boolean(connection?.driveFolderId),
    });
  } catch (err: any) {
    console.error('[Google Status Error]', err.message);
    res.status(500).json({ error: 'Failed to fetch Google Drive status' });
  }
});

export default router;
