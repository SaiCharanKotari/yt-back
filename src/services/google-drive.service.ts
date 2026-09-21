import { google, drive_v3 } from 'googleapis';
import { Types } from 'mongoose';
import fs from 'fs';
import { GoogleOAuthService } from './google-oauth.service.js';
import { GoogleOAuthConnectionModel } from '../models/GoogleOAuthConnection.model.js';
import { Readable } from 'stream';

const ROOT_APP_FOLDER = process.env.GOOGLE_MASTER_ROOT_FOLDER_NAME || 'ClipFlow';

export class GoogleDriveService {
  private static cachedRootFolderId: string | null = null;

  /**
   * Initializes the Master Drive API client for the centralized storage pool.
   * Priority 1: GOOGLE_MASTER_REFRESH_TOKEN from .env
   * Priority 2: Database master connection
   */
  public static async getMasterDriveClient(): Promise<drive_v3.Drive> {
    const masterClientId = process.env.GOOGLE_MASTER_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const masterClientSecret = process.env.GOOGLE_MASTER_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    const masterRefreshToken = process.env.GOOGLE_MASTER_REFRESH_TOKEN;

    // 1. Direct environment variable credentials
    if (masterClientId && masterClientSecret && masterRefreshToken) {
      console.log(`[GoogleDriveService] 🔑 Connected via GOOGLE_MASTER_REFRESH_TOKEN (.env)`);
      const oauth2Client = new google.auth.OAuth2(
        masterClientId,
        masterClientSecret,
        process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'
      );
      oauth2Client.setCredentials({ refresh_token: masterRefreshToken });
      return google.drive({ version: 'v3', auth: oauth2Client });
    }

    // 2. Database connection fallback (e.g. initial owner OAuth login)
    const dbConnection = await GoogleOAuthConnectionModel.findOne({ isConnected: true }).sort({ createdAt: 1 });
    if (dbConnection) {
      console.log(`[GoogleDriveService] ⚠️ GOOGLE_MASTER_REFRESH_TOKEN not set in .env; using active DB connection as Master Drive.`);
      const { oauth2Client } = await GoogleOAuthService.getAuthenticatedClient(dbConnection.userId);
      return google.drive({ version: 'v3', auth: oauth2Client });
    }

    throw new Error(
      'Master Google Drive is not configured. Please fill GOOGLE_MASTER_REFRESH_TOKEN in backend/.env'
    );
  }

  /**
   * Ensures the Master "ClipFlow" root folder exists in the owner's Google Drive.
   */
  public static async ensureRootFolder(drive: drive_v3.Drive): Promise<string> {
    if (this.cachedRootFolderId) {
      try {
        const check = await drive.files.get({
          fileId: this.cachedRootFolderId,
          fields: 'id, trashed',
        });
        if (!check.data.trashed) return this.cachedRootFolderId;
      } catch {
        this.cachedRootFolderId = null;
      }
    }

    const searchRes = await drive.files.list({
      q: `name = '${ROOT_APP_FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (searchRes.data.files && searchRes.data.files.length > 0) {
      this.cachedRootFolderId = searchRes.data.files[0].id!;
      return this.cachedRootFolderId;
    }

    const createRes = await drive.files.create({
      requestBody: {
        name: ROOT_APP_FOLDER,
        mimeType: 'application/vnd.google-apps.folder',
        description: 'ClipFlow Master Cloud Storage Pool',
      },
      fields: 'id',
    });

    this.cachedRootFolderId = createRes.data.id!;
    return this.cachedRootFolderId;
  }

  /**
   * Ensures an isolated subfolder exists for a specific user: ClipFlow/User_<userId>/
   */
  public static async ensureUserFolder(
    userId: Types.ObjectId | string
  ): Promise<{ drive: drive_v3.Drive; folderId: string }> {
    const drive = await this.getMasterDriveClient();
    const rootFolderId = await this.ensureRootFolder(drive);
    const userFolderName = `User_${userId.toString()}`;

    const userFolderSearch = await drive.files.list({
      q: `name = '${userFolderName}' and '${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (userFolderSearch.data.files && userFolderSearch.data.files.length > 0) {
      return { drive, folderId: userFolderSearch.data.files[0].id! };
    }

    const createRes = await drive.files.create({
      requestBody: {
        name: userFolderName,
        parents: [rootFolderId],
        mimeType: 'application/vnd.google-apps.folder',
        description: `Isolated storage space for user ${userId.toString()}`,
      },
      fields: 'id',
    });

    return { drive, folderId: createRes.data.id! };
  }

  /**
   * Uploads a processed video file into the user's isolated folder in the master Google Drive.
   */
  public static async uploadFile(
    userId: Types.ObjectId | string,
    filePath: string,
    fileName: string,
    mimeType: string = 'video/mp4'
  ): Promise<{
    id: string;
    name: string;
    size: number;
    mimeType: string;
    webViewLink?: string;
  }> {
    const { drive, folderId } = await this.ensureUserFolder(userId);

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const media = {
      mimeType,
      body: fs.createReadStream(filePath),
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name, size, mimeType, webViewLink',
    });

    const file = response.data;
    if (!file.id) {
      throw new Error('Failed to upload video to Master Google Drive');
    }

    return {
      id: file.id,
      name: file.name || fileName,
      size: file.size ? parseInt(file.size, 10) : fs.statSync(filePath).size,
      mimeType: file.mimeType || mimeType,
      webViewLink: file.webViewLink || undefined,
    };
  }

  /**
   * Opens a readable stream from the master Google Drive to stream the video to the client.
   */
  public static async getDownloadStream(
    driveFileIdOrUserId: Types.ObjectId | string,
    optionalDriveFileId?: string
  ): Promise<{ stream: Readable; fileName: string; mimeType: string; size: number }> {
    const fileId = optionalDriveFileId || driveFileIdOrUserId.toString();
    const drive = await this.getMasterDriveClient();

    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, size',
    });

    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    return {
      stream: res.data,
      fileName: meta.data.name || 'video.mp4',
      mimeType: meta.data.mimeType || 'video/mp4',
      size: meta.data.size ? parseInt(meta.data.size, 10) : 0,
    };
  }

  /**
   * Deletes a file from the master Google Drive.
   */
  public static async deleteFile(
    driveFileIdOrUserId: Types.ObjectId | string,
    optionalDriveFileId?: string
  ): Promise<void> {
    const fileId = optionalDriveFileId || driveFileIdOrUserId.toString();
    const drive = await this.getMasterDriveClient();
    try {
      await drive.files.delete({ fileId });
    } catch (err: any) {
      console.warn(`[GoogleDriveService] Delete file warning (${fileId}):`, err.message);
    }
  }

  /**
   * Retrieves Master Google Drive storage quota.
   */
  public static async getMasterStorageQuota(): Promise<{
    limit: number;
    usage: number;
    usageInDrive: number;
  }> {
    const drive = await this.getMasterDriveClient();
    const about = await drive.about.get({ fields: 'storageQuota' });
    const quota = about.data.storageQuota;

    return {
      limit: quota?.limit ? parseInt(quota.limit, 10) : 2 * 1024 * 1024 * 1024 * 1024,
      usage: quota?.usage ? parseInt(quota.usage, 10) : 0,
      usageInDrive: quota?.usageInDrive ? parseInt(quota.usageInDrive, 10) : 0,
    };
  }

  public static async getStorageQuota(_userId?: any) {
    return this.getMasterStorageQuota();
  }
}
