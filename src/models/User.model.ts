import mongoose, { Document, Schema, Types } from 'mongoose';

export type UserPlan = 'free' | 'pro' | 'business';

export interface IUser extends Document {
  _id: Types.ObjectId;
  userId?: string;
  email: string;
  passwordHash: string;
  name: string;
  emailVerified: boolean;
  plan: UserPlan;
  storageLimit: number; // in bytes
  storageUsed: number; // in bytes
  createdAt: Date;
  updatedAt: Date;
}

const PLAN_STORAGE_LIMITS: Record<UserPlan, number> = {
  free: 0, // No cloud drive storage for free tier
  pro: 50 * 1024 * 1024 * 1024, // 50 GB
  business: 500 * 1024 * 1024 * 1024, // 500 GB
};

const UserSchema = new Schema<IUser>(
  {
    userId: {
      type: String,
      default: function (this: IUser) {
        return this._id ? this._id.toString() : new Types.ObjectId().toString();
      },
      sparse: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      default: function (this: IUser) {
        return this.email ? this.email.split('@')[0] : 'User';
      },
    },
    emailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    plan: {
      type: String,
      enum: ['free', 'pro', 'business'],
      default: 'free',
      index: true,
    },
    storageLimit: {
      type: Number,
      default: function (this: IUser) {
        return PLAN_STORAGE_LIMITS[this.plan || 'free'];
      },
    },
    storageUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Helper to calculate plan limits
UserSchema.pre('save', function () {
  if (this.isModified('plan')) {
    this.storageLimit = PLAN_STORAGE_LIMITS[this.plan || 'free'];
  }
  if (!this.userId && this._id) {
    this.userId = this._id.toString();
  }
});

export const UserModel = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);
export { PLAN_STORAGE_LIMITS };
