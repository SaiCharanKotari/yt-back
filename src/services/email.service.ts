import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const EMAIL_FROM = process.env.EMAIL_FROM || 'ClipFlow <no-reply@clipflow.app>';

class EmailService {
  private transporter: any = null;

  constructor() {
    this.initTransporter();
  }

  private initTransporter() {
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_PORT === '465',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD,
        },
      });
    }
  }

  /**
   * Sends an email verification link to the user.
   */
  public async sendVerificationEmail(email: string, rawToken: string): Promise<void> {
    const verificationUrl = `${FRONTEND_URL}/verify-email?token=${encodeURIComponent(rawToken)}`;

    console.log('\n================== EMAIL VERIFICATION ==================');
    console.log(`To: ${email}`);
    console.log(`Verification URL: ${verificationUrl}`);
    console.log(`Raw Token: ${rawToken}`);
    console.log('=========================================================\n');

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: EMAIL_FROM,
          to: email,
          subject: 'Verify your ClipFlow account email',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; background-color: #0c0c0f; color: #f8fafc; border-radius: 12px; border: 1px solid #27272a;">
              <h2 style="color: #a855f7;">Welcome to ClipFlow</h2>
              <p>Thank you for signing up! Please verify your email address to activate your account and start using your cloud features.</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${verificationUrl}" style="background: linear-gradient(135deg, #9333ea, #6366f1); color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Verify Email Address</a>
              </div>
              <p style="font-size: 12px; color: #a1a1aa;">This verification link will expire in 24 hours. If you did not create an account, you can safely ignore this email.</p>
            </div>
          `,
        });
      } catch (err: any) {
        console.warn('[EmailService] SMTP send error (console fallback was logged):', err.message);
      }
    }
  }

  /**
   * Sends a password reset link to the user.
   */
  public async sendPasswordResetEmail(email: string, rawToken: string): Promise<void> {
    const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;

    console.log('\n================== PASSWORD RESET ==================');
    console.log(`To: ${email}`);
    console.log(`Reset URL: ${resetUrl}`);
    console.log(`Raw Token: ${rawToken}`);
    console.log('====================================================\n');

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: EMAIL_FROM,
          to: email,
          subject: 'Reset your ClipFlow password',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; background-color: #0c0c0f; color: #f8fafc; border-radius: 12px; border: 1px solid #27272a;">
              <h2 style="color: #a855f7;">Password Reset Request</h2>
              <p>We received a request to reset your password. Click the button below to choose a new password:</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" style="background: linear-gradient(135deg, #9333ea, #6366f1); color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Reset Password</a>
              </div>
              <p style="font-size: 12px; color: #a1a1aa;">This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>
            </div>
          `,
        });
      } catch (err: any) {
        console.warn('[EmailService] SMTP send error (console fallback was logged):', err.message);
      }
    }
  }
}

export const emailService = new EmailService();
