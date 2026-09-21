import { Router, Request, Response } from 'express';
import { Settings } from '../models/Settings';

const router = Router();

// GET /api/settings - Get all settings
router.get('/', async (req: Request, res: Response) => {
  try {
    const settings = await Settings.find();
    const settingsMap = settings.reduce((acc, setting) => {
      acc[setting.key] = setting.value;
      return acc;
    }, {} as Record<string, string>);
    res.json(settingsMap);
  } catch (error: any) {
    console.error('[Settings] Error fetching settings:', error.message);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// GET /api/settings/:key - Get a specific setting
router.get('/:key', async (req: Request, res: Response) => {
  try {
    const setting = await Settings.findOne({ key: req.params.key });
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ key: setting.key, value: setting.value });
  } catch (error: any) {
    console.error('[Settings] Error fetching setting:', error.message);
    res.status(500).json({ error: 'Failed to fetch setting' });
  }
});

// POST /api/settings - Create or update a setting
router.post('/', async (req: Request, res: Response) => {
  try {
    const { key, value, description } = req.body;
    
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Key and value are required' });
    }

    const setting = await Settings.findOneAndUpdate(
      { key },
      { value, description },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ key: setting.key, value: setting.value, description: setting.description });
  } catch (error: any) {
    console.error('[Settings] Error saving setting:', error.message);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

// PUT /api/settings/:key - Update a specific setting
router.put('/:key', async (req: Request, res: Response) => {
  try {
    const { value, description } = req.body;
    
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }

    const setting = await Settings.findOneAndUpdate(
      { key: req.params.key },
      { value, description },
      { new: true }
    );

    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }

    res.json({ key: setting.key, value: setting.value, description: setting.description });
  } catch (error: any) {
    console.error('[Settings] Error updating setting:', error.message);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// DELETE /api/settings/:key - Delete a setting
router.delete('/:key', async (req: Request, res: Response) => {
  try {
    const deleted = await Settings.findOneAndDelete({ key: req.params.key });
    if (!deleted) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ message: 'Setting deleted' });
  } catch (error: any) {
    console.error('[Settings] Error deleting setting:', error.message);
    res.status(500).json({ error: 'Failed to delete setting' });
  }
});

export default router;