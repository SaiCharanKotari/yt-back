import mongoose, { Document, Schema } from 'mongoose';

export interface IAppRequest extends Document {
  email: string;
  source: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AppRequestSchema = new Schema<IAppRequest>(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    source: {
      type: String,
      default: 'desktop_app_request',
    },
    userAgent: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

export const AppRequest =
  mongoose.models.AppRequest || mongoose.model<IAppRequest>('AppRequest', AppRequestSchema);
