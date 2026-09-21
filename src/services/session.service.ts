import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { SessionModel, ISession } from '../models/Session.model.js';
import { UserModel, IUser } from '../models/User.model.js';
import { generateSecureToken, hashToken } from '../utils/hash.util.js';

export const SESSION_COOKIE_NAME = 'sessionId';
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export class SessionService {
  /**
   * Generates a cryptographically secure random session ID and stores its SHA-256 hash in MongoDB.
   */
  public static async createSession(
    userId: Types.ObjectId | string,
    req?: Request
  ): Promise<{ rawSessionId: string; session: ISession }> {
    const rawSessionId = generateSecureToken(32);
    const sessionHash = hashToken(rawSessionId);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const ipAddress = req?.ip || req?.socket.remoteAddress || '';
    const userAgent = req?.headers['user-agent'] || '';

    const session = await SessionModel.create({
      sessionHash,
      userId: new Types.ObjectId(userId.toString()),
      expiresAt,
      ipAddress,
      userAgent,
    });

    return { rawSessionId, session };
  }

  /**
   * Validates a raw session ID by hashing and checking MongoDB.
   */
  public static async validateSession(
    rawSessionId: string
  ): Promise<{ user: IUser; session: ISession } | null> {
    if (!rawSessionId) return null;

    const sessionHash = hashToken(rawSessionId);
    const session = await SessionModel.findOne({ sessionHash });

    if (!session) {
      return null;
    }

    // Check expiration
    if (new Date() > new Date(session.expiresAt)) {
      await SessionModel.deleteOne({ _id: session._id });
      return null;
    }

    const user = await UserModel.findById(session.userId);
    if (!user) {
      await SessionModel.deleteOne({ _id: session._id });
      return null;
    }

    return { user, session };
  }

  /**
   * Rotates a session: revokes existing session (if provided) and creates a fresh new session.
   */
  public static async rotateSession(
    oldRawSessionId: string | null | undefined,
    userId: Types.ObjectId | string,
    req?: Request
  ): Promise<{ rawSessionId: string; session: ISession }> {
    if (oldRawSessionId) {
      const oldHash = hashToken(oldRawSessionId);
      await SessionModel.deleteOne({ sessionHash: oldHash }).catch(() => {});
    }
    return this.createSession(userId, req);
  }

  /**
   * Revokes a specific session.
   */
  public static async revokeSession(rawSessionId: string): Promise<boolean> {
    if (!rawSessionId) return false;
    const sessionHash = hashToken(rawSessionId);
    const result = await SessionModel.deleteOne({ sessionHash });
    return (result.deletedCount ?? 0) > 0;
  }

  /**
   * Revokes all active sessions for a user (e.g. on password change).
   */
  public static async revokeAllUserSessions(userId: Types.ObjectId | string): Promise<void> {
    await SessionModel.deleteMany({ userId: new Types.ObjectId(userId.toString()) });
  }

  /**
   * Sets the secure HttpOnly cookie on the response.
   */
  public static setSessionCookie(res: Response, rawSessionId: string): void {
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie(SESSION_COOKIE_NAME, rawSessionId, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  /**
   * Clears the session cookie on the response.
   */
  public static clearSessionCookie(res: Response): void {
    const isProduction = process.env.NODE_ENV === 'production';
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      path: '/',
    });
  }
}
