import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISession extends Document {
  _id: Types.ObjectId;
  sessionHash: string; // SHA-256 hash of the random session token
  userId: Types.ObjectId;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const SessionSchema = new Schema<ISession>(
  {
    sessionHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // TTL index automatically removes expired sessions
    },
    ipAddress: {
      type: String,
      default: '',
    },
    userAgent: {
      type: String,
      default: '',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

export const SessionModel = mongoose.models.Session || mongoose.model<ISession>('Session', SessionSchema);
