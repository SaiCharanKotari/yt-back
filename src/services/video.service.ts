import { Types } from 'mongoose';
import { VideoModel, IVideo } from '../models/Video.model.js';
import { UserModel } from '../models/User.model.js';
import { GoogleDriveService } from './google-drive.service.js';
import fs from 'fs';

export class VideoService {
  /**
   * Uploads a video file to Google Drive and saves metadata in MongoDB.
   */
  public static async uploadVideo(params: {
    userId: Types.ObjectId | string;
    filePath: string;
    fileName: string;
    mimeType?: string;
    duration?: number;
    thumbnail?: string;
  }): Promise<IVideo> {
    const userId = new Types.ObjectId(params.userId.toString());
    const user = await UserModel.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (user.plan === 'free') {
      throw new Error('Cloud storage is only available for Pro and Business subscribers.');
    }

    const fileSize = fs.statSync(params.filePath).size;

    // Check storage limits
    if (user.storageLimit > 0 && user.storageUsed + fileSize > user.storageLimit) {
      throw new Error(
        `Storage limit exceeded. Current usage: ${(user.storageUsed / (1024 * 1024)).toFixed(1)} MB / ${(
          user.storageLimit / (1024 * 1024)
        ).toFixed(1)} MB`
      );
    }

    // Upload to user's Google Drive
    console.log(`[VideoService] 📤 Uploading "${params.fileName}" (${(fileSize / (1024 * 1024)).toFixed(2)} MB) to Google Drive...`);
    const driveFile = await GoogleDriveService.uploadFile(
      userId,
      params.filePath,
      params.fileName,
      params.mimeType || 'video/mp4'
    );
    console.log(`[VideoService] ☁️ Uploaded to Google Drive successfully. Drive File ID: ${driveFile.id}`);

    // Save metadata in MongoDB
    console.log(`[VideoService] 💾 Creating VideoModel record in MongoDB Atlas...`);
    const video = await VideoModel.create({
      userId,
      driveFileId: driveFile.id,
      fileName: params.fileName,
      mimeType: driveFile.mimeType || params.mimeType || 'video/mp4',
      size: driveFile.size || fileSize,
      duration: params.duration || 0,
      thumbnail: params.thumbnail || '',
    });

    // Increment user storage used
    user.storageUsed += video.size;
    await user.save();
    console.log(`[VideoService] ✅ MongoDB record saved! User storage updated: ${(user.storageUsed / (1024 * 1024)).toFixed(1)} MB used.`);

    return video;
  }

  /**
   * Lists all cloud videos owned by the user.
   */
  public static async listUserVideos(
    userId: Types.ObjectId | string,
    page: number = 1,
    limit: number = 20
  ): Promise<{ videos: IVideo[]; total: number; page: number; totalPages: number }> {
    const userObjectId = new Types.ObjectId(userId.toString());
    const skip = (page - 1) * limit;

    const [videos, total] = await Promise.all([
      VideoModel.find({ userId: userObjectId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
      VideoModel.countDocuments({ userId: userObjectId }),
    ]);

    return {
      videos,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Retrieves a single video with strict ownership verification.
   */
  public static async getVideoById(
    userId: Types.ObjectId | string,
    videoId: string
  ): Promise<IVideo> {
    if (!Types.ObjectId.isValid(videoId)) {
      throw new Error('Invalid video ID');
    }

    const video = await VideoModel.findById(videoId);
    if (!video) {
      throw new Error('Video not found');
    }

    // Strict user ownership check
    if (video.userId.toString() !== userId.toString()) {
      throw new Error('Access denied: You do not have permission to access this video');
    }

    return video;
  }

  /**
   * Deletes a video from Google Drive and MongoDB with strict ownership check.
   */
  public static async deleteVideo(
    userId: Types.ObjectId | string,
    videoId: string
  ): Promise<void> {
    const video = await this.getVideoById(userId, videoId);

    // Delete from Google Drive
    await GoogleDriveService.deleteFile(userId, video.driveFileId);

    // Delete from MongoDB
    await VideoModel.deleteOne({ _id: video._id });

    // Decrement user storageUsed
    const user = await UserModel.findById(userId);
    if (user) {
      user.storageUsed = Math.max(0, user.storageUsed - video.size);
      await user.save();
    }
  }
}
