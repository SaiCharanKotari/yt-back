import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address').max(255),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters long')
    .max(128, 'Password must not exceed 128 characters'),
  name: z.string().trim().max(100).optional().default(''),
  plan: z.enum(['free', 'pro', 'business']).optional().default('free'),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address'),
});

export const resetPasswordSchema = z
  .object({
    email: z.string().trim().optional(),
    token: z.string().optional(),
    code: z.string().optional(),
    newPassword: z
      .string()
      .min(6, 'Password must be at least 6 characters long')
      .max(128, 'Password must not exceed 128 characters'),
  })
  .refine((data) => Boolean((data.token && data.token.trim()) || (data.code && data.code.trim())), {
    message: 'Reset token or code is required',
    path: ['token'],
  });

export const verifyEmailSchema = z
  .object({
    token: z.string().optional(),
    code: z.string().optional(),
    email: z.string().trim().optional(),
  })
  .refine((data) => Boolean((data.token && data.token.trim()) || (data.code && data.code.trim())), {
    message: 'Verification token or code is required',
    path: ['token'],
  });

export const resendVerificationSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(6, 'Password must be at least 6 characters long')
    .max(128, 'Password must not exceed 128 characters'),
});

export const selectPlanSchema = z.object({
  plan: z.enum(['free', 'pro', 'business']),
});
