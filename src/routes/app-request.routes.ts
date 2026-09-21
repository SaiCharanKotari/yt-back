import { Router, Request, Response } from 'express';
import { AppRequest } from '../models/AppRequest.model.js';

const router = Router();

// POST /api/app-requests (or /api/waitlist)
router.post('/', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const userAgent = req.headers['user-agent'] || '';

    // Save email to MongoDB
    const record = await AppRequest.findOneAndUpdate(
      { email: cleanEmail },
      {
        email: cleanEmail,
        source: 'desktop_app_request',
        userAgent,
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log(`%c[AppRequest 📥] New desktop app request email saved: ${cleanEmail}`, 'color: #38bdf8;');

    return res.status(200).json({
      success: true,
      message: 'Thank you! Your request for the Desktop App has been received.',
      data: { email: record.email, createdAt: record.createdAt },
    });
  } catch (error: any) {
    console.error('[AppRequest Error]', error);
    return res.status(500).json({ error: 'Failed to record email request. Please try again.' });
  }
});

export default router;
