import argon2 from 'argon2';
import { Types } from 'mongoose';
import { UserModel, IUser, UserPlan } from '../models/User.model.js';
import { EmailVerificationTokenModel } from '../models/EmailVerificationToken.model.js';
import { PasswordResetTokenModel } from '../models/PasswordResetToken.model.js';
import { GoogleOAuthConnectionModel } from '../models/GoogleOAuthConnection.model.js';
import { SessionService } from './session.service.js';
import { emailService } from './email.service.js';
import { generateSecureToken, hashToken } from '../utils/hash.util.js';

export interface UserResponseDTO {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  plan: UserPlan;
  storageLimit: number;
  storageUsed: number;
  googleDriveConnected: boolean;
  createdAt: string;
  updatedAt: string;
}

export class AuthService {
  /**
   * Hashes a password using Argon2id with recommended parameters.
   */
  public static async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,
      parallelism: 4,
    });
  }

  /**
   * Verifies a plain password against an Argon2id hash.
   */
  public static async verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /**
   * Transforms a User document to a safe public DTO.
   */
  public static async toUserDTO(user: IUser): Promise<UserResponseDTO> {
    const oauthConnection = await GoogleOAuthConnectionModel.findOne({
      userId: user._id,
      isConnected: true,
    });

    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      plan: user.plan,
      storageLimit: user.storageLimit,
      storageUsed: user.storageUsed,
      googleDriveConnected: Boolean(oauthConnection),
      createdAt: user.createdAt?.toISOString(),
      updatedAt: user.updatedAt?.toISOString(),
    };
  }

  /**
   * Registers a new user with Argon2id password hash, assigns plan, and generates verification token.
   */
  public static async register(params: {
    email: string;
    password: string;
    name?: string;
    plan?: UserPlan;
  }): Promise<{ user: IUser; verificationToken: string }> {
    const email = params.email.toLowerCase().trim();

    const existingUser = await UserModel.findOne({ email });
    if (existingUser) {
      throw new Error('An account with this email address already exists');
    }

    const passwordHash = await this.hashPassword(params.password);
    const plan = params.plan || 'free';
    const name = params.name?.trim() || email.split('@')[0];

    const userId = new Types.ObjectId();
    const user = await UserModel.create({
      _id: userId,
      userId: userId.toString(),
      email,
      passwordHash,
      name,
      emailVerified: false,
      plan,
    });

    // Generate secure one-time email verification token (24h expiry)
    const verificationToken = generateSecureToken(32);
    const tokenHash = hashToken(verificationToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await EmailVerificationTokenModel.create({
      userId: user._id,
      tokenHash,
      expiresAt,
    });

    // Send verification email
    await emailService.sendVerificationEmail(user.email, verificationToken);

    return { user, verificationToken };
  }

  /**
   * Authenticates user credentials using Argon2id.
   */
  public static async login(email: string, password: string): Promise<IUser> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await UserModel.findOne({ email: normalizedEmail });

    if (!user) {
      throw new Error('Invalid email or password');
    }

    const isMatch = await this.verifyPassword(user.passwordHash, password);
    if (!isMatch) {
      throw new Error('Invalid email or password');
    }

    return user;
  }

  /**
   * Verifies email using a one-time verification token or code.
   */
  public static async verifyEmail(tokenOrCode: string, email?: string): Promise<IUser> {
    const raw = tokenOrCode.trim();
    const tokenHash = hashToken(raw);

    // Look for hashed token or direct code match
    let record = await EmailVerificationTokenModel.findOne({
      $or: [{ tokenHash }, { tokenHash: raw }],
    });

    if (!record && email) {
      const normalizedEmail = email.toLowerCase().trim();
      const user = await UserModel.findOne({ email: normalizedEmail });
      if (user) {
        record = await EmailVerificationTokenModel.findOne({ userId: user._id });
      }
    }

    if (!record) {
      throw new Error('Invalid or expired verification token/code');
    }

    if (new Date() > new Date(record.expiresAt)) {
      await EmailVerificationTokenModel.deleteOne({ _id: record._id });
      throw new Error('Verification token has expired. Please request a new one.');
    }

    const user = await UserModel.findById(record.userId);
    if (!user) {
      await EmailVerificationTokenModel.deleteOne({ _id: record._id });
      throw new Error('User not found');
    }

    user.emailVerified = true;
    await user.save();

    // Invalidate token to prevent reuse
    await EmailVerificationTokenModel.deleteMany({ userId: user._id });

    return user;
  }

  /**
   * Resends verification email for unverified user.
   */
  public static async resendVerification(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await UserModel.findOne({ email: normalizedEmail });

    // Always respond generically to prevent user enumeration
    if (!user || user.emailVerified) {
      return;
    }

    // Invalidate old tokens
    await EmailVerificationTokenModel.deleteMany({ userId: user._id });

    // Generate new token
    const verificationToken = generateSecureToken(32);
    const tokenHash = hashToken(verificationToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await EmailVerificationTokenModel.create({
      userId: user._id,
      tokenHash,
      expiresAt,
    });

    await emailService.sendVerificationEmail(user.email, verificationToken);
  }

  /**
   * Generates a password reset token and sends email (anti-enumeration protected).
   */
  public static async forgotPassword(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await UserModel.findOne({ email: normalizedEmail });

    if (!user) {
      // Return early without error to avoid user enumeration
      return;
    }

    // Invalidate existing reset tokens for user
    await PasswordResetTokenModel.deleteMany({ userId: user._id });

    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await PasswordResetTokenModel.create({
      userId: user._id,
      tokenHash,
      expiresAt,
    });

    await emailService.sendPasswordResetEmail(user.email, rawToken);
  }

  /**
   * Resets user password using the token or code, hashes new password with Argon2id, and revokes active sessions.
   */
  public static async resetPassword(
    tokenOrCode: string,
    newPassword: string,
    email?: string
  ): Promise<IUser> {
    const raw = tokenOrCode.trim();
    const tokenHash = hashToken(raw);

    let record = await PasswordResetTokenModel.findOne({
      $or: [{ tokenHash }, { tokenHash: raw }],
    });

    if (!record && email) {
      const normalizedEmail = email.toLowerCase().trim();
      const user = await UserModel.findOne({ email: normalizedEmail });
      if (user) {
        record = await PasswordResetTokenModel.findOne({ userId: user._id });
      }
    }

    if (!record) {
      throw new Error('Invalid or expired password reset token/code');
    }

    if (new Date() > new Date(record.expiresAt)) {
      await PasswordResetTokenModel.deleteOne({ _id: record._id });
      throw new Error('Password reset token has expired. Please request a new one.');
    }

    const user = await UserModel.findById(record.userId);
    if (!user) {
      await PasswordResetTokenModel.deleteOne({ _id: record._id });
      throw new Error('User not found');
    }

    user.passwordHash = await this.hashPassword(newPassword);
    await user.save();

    // Invalidate reset tokens
    await PasswordResetTokenModel.deleteMany({ userId: user._id });

    // Revoke all existing sessions for security
    await SessionService.revokeAllUserSessions(user._id);

    return user;
  }

  /**
   * Changes password for an authenticated user.
   */
  public static async changePassword(
    userId: Types.ObjectId | string,
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const isMatch = await this.verifyPassword(user.passwordHash, currentPassword);
    if (!isMatch) {
      throw new Error('Current password is incorrect');
    }

    user.passwordHash = await this.hashPassword(newPassword);
    await user.save();

    // Revoke other user sessions
    await SessionService.revokeAllUserSessions(user._id);
  }

  /**
   * Updates user subscription plan.
   */
  public static async updatePlan(userId: Types.ObjectId | string, plan: UserPlan): Promise<IUser> {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    user.plan = plan;
    await user.save();
    return user;
  }

  /**
   * Updates user profile details (name and/or email).
   * If email is changed, resets verification status and sends a new verification email.
   */
  public static async updateProfile(
    userId: Types.ObjectId | string,
    params: { name?: string; email?: string }
  ): Promise<{ user: IUser; emailChanged: boolean }> {
    const user = await UserModel.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    let emailChanged = false;

    if (params.name && params.name.trim()) {
      user.name = params.name.trim();
    }

    if (params.email && params.email.trim()) {
      const normalizedEmail = params.email.toLowerCase().trim();
      if (normalizedEmail !== user.email) {
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
          throw new Error('Please provide a valid email address.');
        }

        // Check if already in use
        const existing = await UserModel.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
        if (existing) {
          throw new Error('This email is already associated with another account.');
        }

        user.email = normalizedEmail;
        user.emailVerified = false;
        emailChanged = true;

        // Invalidate old tokens & create new verification token
        await EmailVerificationTokenModel.deleteMany({ userId: user._id });
        const verificationToken = generateSecureToken(32);
        const tokenHash = hashToken(verificationToken);
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await EmailVerificationTokenModel.create({
          userId: user._id,
          tokenHash,
          expiresAt,
        });

        // Send verification email
        await emailService.sendVerificationEmail(user.email, verificationToken);
      }
    }

    await user.save();
    return { user, emailChanged };
  }
}
