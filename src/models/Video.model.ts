import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IVideo extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  driveFileId: string;
  fileName: string;
  mimeType: string;
  size: number; // in bytes
  duration: number; // in seconds
  thumbnail?: string;
  createdAt: Date;
  updatedAt: Date;
}

const VideoSchema = new Schema<IVideo>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    driveFileId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    mimeType: {
      type: String,
      required: true,
      default: 'video/mp4',
    },
    size: {
      type: Number,
      required: true,
      min: 0,
    },
    duration: {
      type: Number,
      default: 0,
    },
    thumbnail: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient user-isolated queries and sorting
VideoSchema.index({ userId: 1, createdAt: -1 });

export const VideoModel = mongoose.models.Video || mongoose.model<IVideo>('Video', VideoSchema);
