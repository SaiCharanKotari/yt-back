import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IGoogleOAuthConnection extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  googleEmail?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  tokenExpiry?: Date;
  scope?: string;
  isConnected: boolean;
  driveFolderId?: string; // Dedicated "ClipFlow Cloud Storage" Google Drive folder ID
  createdAt: Date;
  updatedAt: Date;
}

const GoogleOAuthConnectionSchema = new Schema<IGoogleOAuthConnection>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    googleEmail: {
      type: String,
      default: '',
    },
    encryptedAccessToken: {
      type: String,
      required: true,
    },
    encryptedRefreshToken: {
      type: String,
      default: '',
    },
    tokenExpiry: {
      type: Date,
    },
    scope: {
      type: String,
      default: '',
    },
    isConnected: {
      type: Boolean,
      default: true,
      index: true,
    },
    driveFolderId: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

export const GoogleOAuthConnectionModel =
  mongoose.models.GoogleOAuthConnection ||
  mongoose.model<IGoogleOAuthConnection>('GoogleOAuthConnection', GoogleOAuthConnectionSchema);
