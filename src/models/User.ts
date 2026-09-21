import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  userId: string;
  authProvider: 'google' | 'local';
  email: string;
  passwordHash?: string;
  name: string;
  picture?: string;
  googleId?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: Date;
  driveFolderId?: string;
  isEmailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: Date;
  resetPasswordToken?: string;
  resetPasswordExpiry?: Date;
  createdAt: Date;
  lastLogin: Date;
}

export interface UserDTO {
  id: string;
  userId: string;
  authProvider: 'google' | 'local';
  email: string;
  name: string;
  picture?: string;
  googleId?: string;
  driveFolderId?: string;
  hasGoogleDrive: boolean;
  isEmailVerified: boolean;
  createdAt?: string;
  lastLogin?: string;
}

const UserSchema = new Schema<IUser>({
  userId: { type: String, required: true, unique: true, index: true },
  authProvider: { type: String, enum: ['google', 'local'], default: 'local', index: true },
  email: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String },
  name: { type: String, required: true },
  picture: { type: String, default: '' },
  googleId: { type: String, sparse: true, index: true },
  accessToken: { type: String },
  refreshToken: { type: String },
  tokenExpiry: { type: Date },
  driveFolderId: { type: String },
  isEmailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String },
  emailVerificationExpiry: { type: Date },
  resetPasswordToken: { type: String },
  resetPasswordExpiry: { type: Date },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now }
});

export const UserModel = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
