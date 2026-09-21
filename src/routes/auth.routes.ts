import { Router, Request, Response } from 'express';
import { AuthService } from '../services/auth.service.js';
import { SessionService } from '../services/session.service.js';
import {
  requireAuth,
  authRateLimiter,
  verificationRateLimiter,
  AuthenticatedRequest,
} from '../middlewares/auth.middleware.js';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  changePasswordSchema,
  selectPlanSchema,
} from '../utils/validation.schemas.js';

const router = Router();

// ─── POST /api/auth/register ────────────────────────────────────────────────
router.post('/register', authRateLimiter, async (req: Request, res: Response) => {
  const parseResult = registerSchema.safeParse(req.body);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0]?.message || 'Validation failed';
    return res.status(400).json({
      error: firstError,
      details: parseResult.error.flatten().fieldErrors,
    });
  }

  try {
    const { user } = await AuthService.register(parseResult.data);

    // Create a new server-side session and set secure cookie
    const { rawSessionId } = await SessionService.createSession(user._id, req);
    SessionService.setSessionCookie(res, rawSessionId);

    const userDTO = await AuthService.toUserDTO(user);
    res.status(201).json({
      success: true,
      message: 'Registration successful! A verification email has been sent.',
      user: userDTO,
    });
  } catch (err: any) {
    console.error('[Auth Register Error]', err.message);
    res.status(400).json({ error: err.message || 'Registration failed' });
  }
});

// ─── POST /api/auth/login ───────────────────────────────────────────────────
router.post('/login', authRateLimiter, async (req: Request, res: Response) => {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0]?.message || 'Validation failed';
    return res.status(400).json({
      error: firstError,
      details: parseResult.error.flatten().fieldErrors,
    });
  }

  try {
    const user = await AuthService.login(parseResult.data.email, parseResult.data.password);

    // Session rotation on login for session fixation protection
    const existingSessionId = req.cookies?.sessionId;
    const { rawSessionId } = await SessionService.rotateSession(existingSessionId, user._id, req);
    SessionService.setSessionCookie(res, rawSessionId);

    const userDTO = await AuthService.toUserDTO(user);
    res.json({
      success: true,
      message: 'Logged in successfully',
      user: userDTO,
    });
  } catch (err: any) {
    console.error('[Auth Login Error]', err.message);
    res.status(401).json({ error: err.message || 'Invalid email or password' });
  }
});

// ─── POST /api/auth/logout ──────────────────────────────────────────────────
router.post('/logout', async (req: Request, res: Response) => {
  const sessionId = req.cookies?.sessionId;
  if (sessionId) {
    await SessionService.revokeSession(sessionId).catch(() => {});
  }
  SessionService.clearSessionCookie(res);
  res.json({ success: true, message: 'Logged out successfully' });
});

// ─── GET /api/auth/me ───────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userDTO = await AuthService.toUserDTO(req.user!);
    res.json({
      authenticated: true,
      user: userDTO,
    });
  } catch (err: any) {
    console.error('[Auth Me Error]', err.message);
    res.status(500).json({ error: 'Failed to retrieve user profile' });
  }
});

// ─── POST /api/auth/verify-email ────────────────────────────────────────────
router.post('/verify-email', verificationRateLimiter, async (req: Request, res: Response) => {
  const parseResult = verifyEmailSchema.safeParse(req.body);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0]?.message || 'Verification token or code is required';
    return res.status(400).json({ error: firstError });
  }

  const tokenOrCode = (parseResult.data.token || parseResult.data.code || '').trim();

  try {
    const user = await AuthService.verifyEmail(tokenOrCode, parseResult.data.email);
    const userDTO = await AuthService.toUserDTO(user);
    res.json({
      success: true,
      message: 'Email successfully verified!',
      user: userDTO,
    });
  } catch (err: any) {
    console.error('[Verify Email Error]', err.message);
    res.status(400).json({ error: err.message || 'Email verification failed' });
  }
});

// ─── POST /api/auth/resend-verification ─────────────────────────────────────
router.post('/resend-verification', verificationRateLimiter, async (req: Request, res: Response) => {
  const parseResult = resendVerificationSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }

  try {
    await AuthService.resendVerification(parseResult.data.email);
    res.json({
      success: true,
      message: 'If an unverified account with that email exists, a verification link has been sent.',
    });
  } catch (err: any) {
    console.error('[Resend Verification Error]', err.message);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// ─── POST /api/auth/forgot-password ─────────────────────────────────────────
router.post('/forgot-password', verificationRateLimiter, async (req: Request, res: Response) => {
  const parseResult = forgotPasswordSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }

  try {
    await AuthService.forgotPassword(parseResult.data.email);
    res.json({
      success: true,
      message: 'If an account exists with that email, a password reset link has been sent.',
    });
  } catch (err: any) {
    console.error('[Forgot Password Error]', err.message);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// ─── POST /api/auth/reset-password ──────────────────────────────────────────
router.post('/reset-password', verificationRateLimiter, async (req: Request, res: Response) => {
  const parseResult = resetPasswordSchema.safeParse(req.body);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0]?.message || 'Validation failed';
    return res.status(400).json({
      error: firstError,
      details: parseResult.error.flatten().fieldErrors,
    });
  }

  const tokenOrCode = (parseResult.data.token || parseResult.data.code || '').trim();

  try {
    const user = await AuthService.resetPassword(
      tokenOrCode,
      parseResult.data.newPassword,
      parseResult.data.email
    );

    // Create a fresh session after password reset
    const { rawSessionId } = await SessionService.createSession(user._id, req);
    SessionService.setSessionCookie(res, rawSessionId);

    const userDTO = await AuthService.toUserDTO(user);
    res.json({
      success: true,
      message: 'Password reset successfully! You are now logged in.',
      user: userDTO,
    });
  } catch (err: any) {
    console.error('[Reset Password Error]', err.message);
    res.status(400).json({ error: err.message || 'Failed to reset password' });
  }
});

// ─── POST /api/auth/change-password ─────────────────────────────────────────
router.post('/change-password', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parseResult = changePasswordSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.flatten().fieldErrors,
    });
  }

  try {
    await AuthService.changePassword(
      req.user!._id,
      parseResult.data.currentPassword,
      parseResult.data.newPassword
    );

    // Rotate current session
    const existingSessionId = req.cookies?.sessionId;
    const { rawSessionId } = await SessionService.rotateSession(existingSessionId, req.user!._id, req);
    SessionService.setSessionCookie(res, rawSessionId);

    res.json({
      success: true,
      message: 'Password changed successfully.',
    });
  } catch (err: any) {
    console.error('[Change Password Error]', err.message);
    res.status(400).json({ error: err.message || 'Failed to change password' });
  }
});

// ─── POST /api/auth/select-plan ─────────────────────────────────────────────
router.post('/select-plan', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const parseResult = selectPlanSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Valid plan (free, pro, business) is required' });
  }

  try {
    const updatedUser = await AuthService.updatePlan(req.user!._id, parseResult.data.plan);
    const userDTO = await AuthService.toUserDTO(updatedUser);
    res.json({
      success: true,
      message: `Plan successfully updated to ${updatedUser.plan.toUpperCase()}`,
      user: userDTO,
    });
  } catch (err: any) {
    console.error('[Select Plan Error]', err.message);
    res.status(400).json({ error: err.message || 'Failed to update plan' });
  }
});

// ─── PATCH /api/auth/profile ─────────────────────────────────────────────
router.patch('/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, email } = req.body;
    if (!name && !email) {
      return res.status(400).json({ error: 'Name or email is required' });
    }

    const { user: updatedUser, emailChanged } = await AuthService.updateProfile(req.user!._id, {
      name,
      email,
    });
    const userDTO = await AuthService.toUserDTO(updatedUser);
    res.json({
      success: true,
      message: emailChanged
        ? 'Profile updated. A verification link has been sent to your new email.'
        : 'Profile updated successfully',
      emailChanged,
      user: userDTO,
    });
  } catch (err: any) {
    console.error('[Update Profile Error]', err.message);
    res.status(400).json({ error: err.message || 'Failed to update profile' });
  }
});

export default router;
