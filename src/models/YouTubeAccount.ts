import mongoose, { Schema, Document } from 'mongoose';

export interface IYouTubeAccount extends Document {
  channelId: string;
  channelName: string;
  avatar: string;
  subscribers: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const YouTubeAccountSchema = new Schema(
  {
    channelId: { type: String, required: true, unique: true },
    channelName: { type: String, required: true },
    avatar: { type: String, default: '' },
    subscribers: { type: String, default: '0' },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    tokenExpiry: { type: Date, required: true },
    status: { type: String, default: 'Connected' },
  },
  {
    timestamps: true, // adds createdAt and updatedAt
  }
);

export const YouTubeAccount = mongoose.model<IYouTubeAccount>('YouTubeAccount', YouTubeAccountSchema);
