import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { SessionService, SESSION_COOKIE_NAME } from '../services/session.service.js';
import { IUser, UserPlan } from '../models/User.model.js';
import { ISession } from '../models/Session.model.js';

export interface AuthenticatedRequest extends Request {
  user?: IUser;
  session?: ISession;
  userId?: string;
}

/**
 * Middleware: Requires an active, valid server-side session.
 */
export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const sessionId =
    req.cookies?.[SESSION_COOKIE_NAME] ||
    (req.headers['x-session-id'] as string) ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);

  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  try {
    const result = await SessionService.validateSession(sessionId);
    if (!result) {
      SessionService.clearSessionCookie(res);
      return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    }

    req.user = result.user;
    req.session = result.session;
    req.userId = result.user._id.toString();
    next();
  } catch (err: any) {
    console.error('[Auth Middleware Error]', err.message);
    return res.status(500).json({ error: 'Failed to authenticate request' });
  }
};

/**
 * Middleware: Optionally attaches session and user if present.
 */
export const optionalAuth = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) => {
  const sessionId =
    req.cookies?.[SESSION_COOKIE_NAME] ||
    (req.headers['x-session-id'] as string) ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);

  if (sessionId) {
    try {
      const result = await SessionService.validateSession(sessionId);
      if (result) {
        req.user = result.user;
        req.session = result.session;
        req.userId = result.user._id.toString();
      }
    } catch {
      // Ignore errors in optional auth
    }
  }
  next();
};

/**
 * Middleware: Enforces verified email address.
 */
export const requireVerifiedEmail = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!req.user.emailVerified) {
    return res.status(403).json({
      error: 'Email verification required',
      emailVerified: false,
      message: 'Please verify your email address to access this feature.',
    });
  }

  next();
};

/**
 * Middleware: Enforces subscription plan tier.
 */
export const requirePlan = (requiredPlan: UserPlan) => {
  const planHierarchy: Record<UserPlan, number> = {
    free: 0,
    pro: 1,
    business: 2,
  };

  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userLevel = planHierarchy[req.user.plan || 'free'] ?? 0;
    const requiredLevel = planHierarchy[requiredPlan] ?? 0;

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        error: `Subscription upgrade required (${requiredPlan.toUpperCase()} plan or higher required)`,
        currentPlan: req.user.plan,
        requiredPlan,
      });
    }

    next();
  };
};

/**
 * Rate limiters for security.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

export const verificationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification requests. Please wait a few minutes and try again.' },
});
