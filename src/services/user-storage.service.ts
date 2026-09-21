import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { IUser, UserModel, UserDTO } from '../models/User.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

export interface StoredUser {
  id: string; // unique ID
  userId: string;
  authProvider: 'google' | 'local';
  email: string;
  name: string;
  passwordHash?: string;
  picture?: string;
  googleId?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: string;
  driveFolderId?: string;
  isEmailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: string;
  resetPasswordToken?: string;
  resetPasswordExpiry?: string;
  createdAt: string;
  lastLogin: string;
}

class UserStorageService {
  private inMemoryUsers: Map<string, StoredUser> = new Map();

  constructor() {
    this.initFileStore();
  }

  private initFileStore() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(USERS_FILE)) {
        const raw = fs.readFileSync(USERS_FILE, 'utf-8');
        const list: any[] = JSON.parse(raw);
        for (const u of list) {
          const id = u.userId || u.googleId || u.id;
          const authProvider = u.authProvider || (u.googleId ? 'google' : 'local');
          const isEmailVerified = u.isEmailVerified !== undefined
            ? Boolean(u.isEmailVerified)
            : (authProvider === 'google');

          const normalized: StoredUser = {
            id,
            userId: id,
            authProvider,
            email: u.email,
            name: u.name,
            passwordHash: u.passwordHash,
            picture: u.picture || '',
            googleId: u.googleId,
            accessToken: u.accessToken,
            refreshToken: u.refreshToken,
            tokenExpiry: u.tokenExpiry,
            driveFolderId: u.driveFolderId,
            isEmailVerified,
            emailVerificationToken: u.emailVerificationToken,
            emailVerificationExpiry: u.emailVerificationExpiry,
            resetPasswordToken: u.resetPasswordToken,
            resetPasswordExpiry: u.resetPasswordExpiry,
            createdAt: u.createdAt || new Date().toISOString(),
            lastLogin: u.lastLogin || new Date().toISOString(),
          };
          this.inMemoryUsers.set(id, normalized);
          if (normalized.googleId) {
            this.inMemoryUsers.set(normalized.googleId, normalized);
          }
          if (normalized.email) {
            this.inMemoryUsers.set(`email:${normalized.email.toLowerCase()}`, normalized);
          }
        }
      }
    } catch (err) {
      console.warn('[UserStorage] Error loading users.json:', err);
    }
  }

  private saveFileStore() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      // Unique users only (avoid alias duplicates)
      const uniqueMap = new Map<string, StoredUser>();
      for (const [key, user] of this.inMemoryUsers.entries()) {
        if (!key.startsWith('email:')) {
          uniqueMap.set(user.userId, user);
        }
      }
      const list = Array.from(uniqueMap.values());
      fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('[UserStorage] Failed to save users.json:', err);
    }
  }

  public async upsertGoogleUser(data: {
    googleId: string;
    email: string;
    name: string;
    picture: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: Date;
    driveFolderId?: string;
  }): Promise<StoredUser> {
    const existing = await this.getUser(data.googleId) || await this.getUserByEmail(data.email);
    const now = new Date().toISOString();
    const userId = existing?.userId || `g_${data.googleId}`;

    const updated: StoredUser = {
      id: userId,
      userId,
      authProvider: 'google',
      googleId: data.googleId,
      email: data.email,
      name: data.name,
      picture: data.picture,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || existing?.refreshToken,
      tokenExpiry: data.tokenExpiry ? data.tokenExpiry.toISOString() : existing?.tokenExpiry,
      driveFolderId: data.driveFolderId || existing?.driveFolderId,
      isEmailVerified: true,
      createdAt: existing?.createdAt || now,
      lastLogin: now,
    };

    this.inMemoryUsers.set(userId, updated);
    this.inMemoryUsers.set(data.googleId, updated);
    this.inMemoryUsers.set(`email:${data.email.toLowerCase()}`, updated);
    this.saveFileStore();

    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.findOneAndUpdate(
          { $or: [{ googleId: data.googleId }, { email: data.email }] },
          {
            userId,
            authProvider: 'google',
            googleId: data.googleId,
            email: updated.email,
            name: updated.name,
            picture: updated.picture,
            accessToken: updated.accessToken,
            ...(updated.refreshToken ? { refreshToken: updated.refreshToken } : {}),
            tokenExpiry: updated.tokenExpiry ? new Date(updated.tokenExpiry) : undefined,
            driveFolderId: updated.driveFolderId,
            isEmailVerified: true,
            lastLogin: new Date(updated.lastLogin),
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
      } catch (e: any) {
        console.warn('[UserStorage] MongoDB sync warning:', e.message);
      }
    }

    return updated;
  }

  // Alias for backward compatibility
  public async upsertUser(data: {
    googleId: string;
    email: string;
    name: string;
    picture: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: Date;
    driveFolderId?: string;
  }): Promise<StoredUser> {
    return this.upsertGoogleUser(data);
  }

  public async createLocalUser(data: {
    email: string;
    passwordHash: string;
    name: string;
    emailVerificationToken?: string;
    emailVerificationExpiry?: string;
  }): Promise<StoredUser> {
    const existing = await this.getUserByEmail(data.email);
    if (existing) {
      throw new Error('An account with this email already exists');
    }

    const now = new Date().toISOString();
    const userId = `u_${crypto.randomBytes(8).toString('hex')}`;

    const newUser: StoredUser = {
      id: userId,
      userId,
      authProvider: 'local',
      email: data.email.toLowerCase().trim(),
      name: data.name.trim(),
      passwordHash: data.passwordHash,
      picture: '',
      isEmailVerified: false,
      emailVerificationToken: data.emailVerificationToken,
      emailVerificationExpiry: data.emailVerificationExpiry,
      createdAt: now,
      lastLogin: now,
    };

    this.inMemoryUsers.set(userId, newUser);
    this.inMemoryUsers.set(`email:${newUser.email}`, newUser);
    this.saveFileStore();

    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.create({
          userId,
          authProvider: 'local',
          email: newUser.email,
          name: newUser.name,
          passwordHash: newUser.passwordHash,
          isEmailVerified: false,
          emailVerificationToken: newUser.emailVerificationToken,
          emailVerificationExpiry: newUser.emailVerificationExpiry ? new Date(newUser.emailVerificationExpiry) : undefined,
          createdAt: new Date(newUser.createdAt),
          lastLogin: new Date(newUser.lastLogin),
        });
      } catch (e: any) {
        console.warn('[UserStorage] MongoDB create error:', e.message);
      }
    }

    return newUser;
  }

  public async updateUser(user: StoredUser): Promise<StoredUser> {
    this.inMemoryUsers.set(user.userId, user);
    if (user.googleId) {
      this.inMemoryUsers.set(user.googleId, user);
    }
    if (user.email) {
      this.inMemoryUsers.set(`email:${user.email.toLowerCase()}`, user);
    }
    this.saveFileStore();

    if (mongoose.connection.readyState === 1) {
      try {
        await UserModel.findOneAndUpdate(
          { $or: [{ userId: user.userId }, { email: user.email }] },
          {
            authProvider: user.authProvider,
            email: user.email,
            name: user.name,
            passwordHash: user.passwordHash,
            picture: user.picture,
            googleId: user.googleId,
            accessToken: user.accessToken,
            refreshToken: user.refreshToken,
            tokenExpiry: user.tokenExpiry ? new Date(user.tokenExpiry) : undefined,
            driveFolderId: user.driveFolderId,
            isEmailVerified: Boolean(user.isEmailVerified),
            emailVerificationToken: user.emailVerificationToken,
            emailVerificationExpiry: user.emailVerificationExpiry ? new Date(user.emailVerificationExpiry) : undefined,
            resetPasswordToken: user.resetPasswordToken,
            resetPasswordExpiry: user.resetPasswordExpiry ? new Date(user.resetPasswordExpiry) : undefined,
            lastLogin: new Date(user.lastLogin),
          },
          { upsert: false, returnDocument: 'after' }
        );
      } catch (e: any) {
        console.warn('[UserStorage] MongoDB updateUser warning:', e.message);
      }
    }

    return user;
  }

  public async getUser(identifier: string): Promise<StoredUser | null> {
    if (!identifier) return null;
    const local = this.inMemoryUsers.get(identifier);
    if (local) return local;

    if (mongoose.connection.readyState === 1) {
      try {
        const dbUser = await UserModel.findOne({
          $or: [{ userId: identifier }, { googleId: identifier }]
        });
        if (dbUser) {
          const authProvider = dbUser.authProvider || (dbUser.googleId ? 'google' : 'local');
          const stored: StoredUser = {
            id: dbUser.userId || dbUser.googleId || dbUser._id.toString(),
            userId: dbUser.userId || dbUser.googleId || dbUser._id.toString(),
            authProvider,
            email: dbUser.email,
            name: dbUser.name,
            passwordHash: dbUser.passwordHash,
            picture: dbUser.picture || '',
            googleId: dbUser.googleId,
            accessToken: dbUser.accessToken,
            refreshToken: dbUser.refreshToken,
            tokenExpiry: dbUser.tokenExpiry?.toISOString(),
            driveFolderId: dbUser.driveFolderId,
            isEmailVerified: dbUser.isEmailVerified ?? (authProvider === 'google'),
            emailVerificationToken: dbUser.emailVerificationToken,
            emailVerificationExpiry: dbUser.emailVerificationExpiry?.toISOString(),
            resetPasswordToken: dbUser.resetPasswordToken,
            resetPasswordExpiry: dbUser.resetPasswordExpiry?.toISOString(),
            createdAt: dbUser.createdAt?.toISOString() || new Date().toISOString(),
            lastLogin: dbUser.lastLogin?.toISOString() || new Date().toISOString(),
          };
          this.inMemoryUsers.set(stored.userId, stored);
          if (stored.googleId) this.inMemoryUsers.set(stored.googleId, stored);
          this.inMemoryUsers.set(`email:${stored.email.toLowerCase()}`, stored);
          this.saveFileStore();
          return stored;
        }
      } catch (e) {}
    }

    return null;
  }

  public async getUserByEmail(email: string): Promise<StoredUser | null> {
    if (!email) return null;
    const normalized = email.toLowerCase().trim();
    const local = this.inMemoryUsers.get(`email:${normalized}`);
    if (local) return local;

    if (mongoose.connection.readyState === 1) {
      try {
        const dbUser = await UserModel.findOne({ email: normalized });
        if (dbUser) {
          const authProvider = dbUser.authProvider || (dbUser.googleId ? 'google' : 'local');
          const stored: StoredUser = {
            id: dbUser.userId || dbUser.googleId || dbUser._id.toString(),
            userId: dbUser.userId || dbUser.googleId || dbUser._id.toString(),
            authProvider,
            email: dbUser.email,
            name: dbUser.name,
            passwordHash: dbUser.passwordHash,
            picture: dbUser.picture || '',
            googleId: dbUser.googleId,
            accessToken: dbUser.accessToken,
            refreshToken: dbUser.refreshToken,
            tokenExpiry: dbUser.tokenExpiry?.toISOString(),
            driveFolderId: dbUser.driveFolderId,
            isEmailVerified: dbUser.isEmailVerified ?? (authProvider === 'google'),
            emailVerificationToken: dbUser.emailVerificationToken,
            emailVerificationExpiry: dbUser.emailVerificationExpiry?.toISOString(),
            resetPasswordToken: dbUser.resetPasswordToken,
            resetPasswordExpiry: dbUser.resetPasswordExpiry?.toISOString(),
            createdAt: dbUser.createdAt?.toISOString() || new Date().toISOString(),
            lastLogin: dbUser.lastLogin?.toISOString() || new Date().toISOString(),
          };
          this.inMemoryUsers.set(stored.userId, stored);
          if (stored.googleId) this.inMemoryUsers.set(stored.googleId, stored);
          this.inMemoryUsers.set(`email:${normalized}`, stored);
          this.saveFileStore();
          return stored;
        }
      } catch (e) {}
    }

    return null;
  }

  public toDTO(user: StoredUser): UserDTO {
    return {
      id: user.userId || user.id,
      userId: user.userId || user.id,
      authProvider: user.authProvider || (user.googleId ? 'google' : 'local'),
      email: user.email,
      name: user.name,
      picture: user.picture || '',
      googleId: user.googleId,
      driveFolderId: user.driveFolderId,
      hasGoogleDrive: Boolean(user.googleId && (user.accessToken || user.refreshToken)),
      isEmailVerified: user.isEmailVerified !== undefined ? Boolean(user.isEmailVerified) : (user.authProvider === 'google'),
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }
}

export const userStorage = new UserStorageService();
