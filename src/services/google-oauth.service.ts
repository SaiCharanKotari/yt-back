import { google } from 'googleapis';
import { Types } from 'mongoose';
import dotenv from 'dotenv';
import { GoogleOAuthConnectionModel, IGoogleOAuthConnection } from '../models/GoogleOAuthConnection.model.js';
import { UserModel, IUser } from '../models/User.model.js';
import { SessionService } from './session.service.js';
import { encryptText, decryptText } from '../utils/encryption.util.js';
import crypto from 'crypto';

dotenv.config();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';

export class GoogleOAuthService {
  /**
   * Builds an OAuth2 client instance.
   */
  public static getOAuth2Client() {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.warn('[GoogleOAuthService] Warning: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing!');
    }
    return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  }

  /**
   * Generates Google OAuth consent URL.
   * Can be called by unauthenticated users (for 1-click Google sign-in/registration) or authenticated users (to link Google Drive).
   */
  public static generateConnectUrl(userId: string = 'new'): { url: string; state: string } {
    const oauth2Client = this.getOAuth2Client();

    // Create a tamper-proof state containing userId (or 'new') and a timestamp HMAC
    const randomNonce = crypto.randomBytes(16).toString('hex');
    const secret = process.env.SESSION_SECRET || 'clipflow_state_secret';
    const statePayload = `${userId || 'new'}:${Date.now()}:${randomNonce}`;
    const hmac = crypto.createHmac('sha256', secret).update(statePayload).digest('hex');
    const state = Buffer.from(JSON.stringify({ payload: statePayload, hmac })).toString('base64url');

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // Ensure refresh_token is returned
      scope: [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/drive.file', // Minimal scope for app-created files only
      ],
      state,
    });

    return { url, state };
  }

  /**
   * Verifies state parameter from Google OAuth callback.
   */
  public static verifyState(stateParam: string): string {
    if (!stateParam || stateParam === 'master') {
      return 'master';
    }
    try {
      const decoded = Buffer.from(stateParam, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (!parsed.payload || !parsed.hmac) {
        return 'master';
      }
      const { payload, hmac } = parsed;
      const secret = process.env.SESSION_SECRET || 'clipflow_state_secret';
      const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      if (hmac !== expectedHmac) {
        throw new Error('Invalid OAuth state signature');
      }

      const [userId, timestampStr] = payload.split(':');
      const timestamp = parseInt(timestampStr, 10);

      // Verify expiration (15 minutes)
      if (Date.now() - timestamp > 15 * 60 * 1000) {
        throw new Error('OAuth state has expired. Please try connecting again.');
      }

      return userId || 'new';
    } catch (err: any) {
      if (err.message?.includes('OAuth state')) throw err;
      return 'master';
    }
  }

  /**
   * Handles Google OAuth callback: exchanges code, creates/finds user if new, encrypts tokens, and saves connection.
   */
  public static async handleCallback(
    code: string,
    stateUserId: string
  ): Promise<{ user: IUser; connection: IGoogleOAuthConnection; isNewUser: boolean }> {
    const oauth2Client = this.getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Retrieve Google user profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfoRes = await oauth2.userinfo.get();
    const googleProfile = userInfoRes.data;

    if (!googleProfile.email) {
      throw new Error('Could not retrieve email from Google OAuth');
    }

    const email = googleProfile.email.toLowerCase().trim();
    const name = googleProfile.name || email.split('@')[0];

    // Find or create user
    let user: IUser | null = null;
    let isNewUser = false;

    if (stateUserId && stateUserId !== 'new' && Types.ObjectId.isValid(stateUserId)) {
      user = await UserModel.findById(stateUserId);
    }

    if (!user) {
      user = await UserModel.findOne({ email });
    }

    if (!user) {
      isNewUser = true;
      const dummyPasswordHash = `$argon2id$v=19$m=65536,p=4,t=3$oauth_${crypto.randomBytes(16).toString('hex')}`;
      const newUserId = new Types.ObjectId();
      user = await UserModel.create({
        _id: newUserId,
        userId: newUserId.toString(),
        email,
        name,
        passwordHash: dummyPasswordHash,
        emailVerified: true, // Google emails are already verified by Google
        plan: 'pro', // Default to Pro for Google Drive cloud access
      });
    } else {
      // Mark email as verified if they authenticated via Google
      if (!user.emailVerified) {
        user.emailVerified = true;
        await user.save();
      }
    }

    if (!user) {
      throw new Error('Failed to create or retrieve user profile from Google OAuth');
    }

    if (!tokens.access_token) {
      throw new Error('Google did not return an access token');
    }

    const encryptedAccessToken = encryptText(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token ? encryptText(tokens.refresh_token) : undefined;
    const tokenExpiry = tokens.expiry_date ? new Date(tokens.expiry_date) : undefined;

    const connection = await GoogleOAuthConnectionModel.findOneAndUpdate(
      { userId: user._id },
      {
        userId: user._id,
        googleEmail: email,
        encryptedAccessToken,
        ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
        tokenExpiry,
        scope: tokens.scope || 'https://www.googleapis.com/auth/drive.file',
        isConnected: true,
      },
      { upsert: true, returnDocument: 'after' }
    );

    return { user, connection, isNewUser };
  }

  /**
   * Returns an authorized Google OAuth2 client for a user, automatically refreshing expired tokens.
   */
  public static async getAuthenticatedClient(userId: Types.ObjectId | string) {
    const connection = await GoogleOAuthConnectionModel.findOne({
      userId: new Types.ObjectId(userId.toString()),
      isConnected: true,
    });

    if (!connection) {
      throw new Error('Google Drive account is not connected. Please connect Google Drive in your settings.');
    }

    const accessToken = decryptText(connection.encryptedAccessToken);
    const refreshToken = connection.encryptedRefreshToken
      ? decryptText(connection.encryptedRefreshToken)
      : undefined;

    const oauth2Client = this.getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    // Check if token is expired or within 2 minutes of expiry
    const isExpired = connection.tokenExpiry
      ? new Date(connection.tokenExpiry).getTime() <= Date.now() + 2 * 60 * 1000
      : false;

    if (isExpired && refreshToken) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);

        if (credentials.access_token) {
          connection.encryptedAccessToken = encryptText(credentials.access_token);
          if (credentials.refresh_token) {
            connection.encryptedRefreshToken = encryptText(credentials.refresh_token);
          }
          if (credentials.expiry_date) {
            connection.tokenExpiry = new Date(credentials.expiry_date);
          }
          await connection.save();
        }
      } catch (err: any) {
        console.error('[GoogleOAuthService] Token refresh failed:', err.message);
        connection.isConnected = false;
        await connection.save();
        throw new Error('Google Drive authorization has expired or been revoked. Please reconnect Google Drive.');
      }
    }

    return { oauth2Client, connection };
  }

  /**
   * Disconnects Google Drive for a user.
   */
  public static async disconnect(userId: Types.ObjectId | string): Promise<void> {
    const connection = await GoogleOAuthConnectionModel.findOne({
      userId: new Types.ObjectId(userId.toString()),
    });

    if (!connection) return;

    try {
      if (connection.encryptedAccessToken) {
        const token = decryptText(connection.encryptedAccessToken);
        const oauth2Client = this.getOAuth2Client();
        await oauth2Client.revokeToken(token);
      }
    } catch (err: any) {
      console.warn('[GoogleOAuthService] Revoke error:', err.message);
    }

    await GoogleOAuthConnectionModel.deleteOne({ _id: connection._id });
  }
}
