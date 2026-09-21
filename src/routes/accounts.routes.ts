import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { YouTubeAccount } from '../models/YouTubeAccount';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();

const getOAuth2Client = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'
  );
};

// GET /api/accounts
router.get('/', async (req: Request, res: Response) => {
  console.log('[API] Fetching all connected YouTube accounts from database...');
  try {
    const accounts = await YouTubeAccount.find().sort({ createdAt: -1 });
    console.log(`[API] Found ${accounts.length} accounts.`);
    
    // Do not return sensitive tokens to the frontend!
    const safeAccounts = accounts.map(acc => ({
      id: acc._id,
      channelId: acc.channelId,
      name: acc.channelName,
      avatar: acc.avatar,
      subscribers: acc.subscribers,
      status: acc.status,
    }));
    
    res.json(safeAccounts);
  } catch (error: any) {
    console.error('[API] Error fetching accounts:', error.message);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// GET /api/accounts/:id/analytics
router.get('/:id/analytics', async (req: Request, res: Response) => {
  const accountId = req.params.id;
  console.log(`[Analytics] ====== Starting analytics fetch for account: ${accountId} ======`);

  try {
    const account = await YouTubeAccount.findById(accountId);
    if (!account) {
      console.error(`[Analytics] Account ${accountId} not found in DB`);
      return res.status(404).json({ error: 'Account not found' });
    }
    console.log(`[Analytics] Found account: ${account.channelName} (channelId: ${account.channelId})`);
    console.log(`[Analytics] Has access_token: ${!!account.accessToken}, Has refresh_token: ${!!account.refreshToken}`);

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
    });

    // Force token refresh if needed
    try {
      const tokenInfo = await oauth2Client.getAccessToken();
      console.log(`[Analytics] Token status: ${tokenInfo.res?.status || 'OK'}`);
    } catch(e: any) {
      console.warn(`[Analytics] Token check warning: ${e.message}`);
    }

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    
    // 1. Get channel details & uploads playlist ID
    console.log(`[Analytics] Fetching channel info for channelId: ${account.channelId}`);
    const channelRes = await youtube.channels.list({
      part: ['contentDetails', 'statistics'],
      id: [account.channelId]
    });
    
    console.log(`[Analytics] Channel API response items count: ${channelRes.data.items?.length || 0}`);
    const channelItem = channelRes.data.items?.[0];
    if (!channelItem) {
      console.error(`[Analytics] No channel found on YouTube for ID: ${account.channelId}`);
      throw new Error('Channel not found on YouTube');
    }

    const uploadsPlaylistId = channelItem.contentDetails?.relatedPlaylists?.uploads;
    const currentSubscribers = channelItem.statistics?.subscriberCount || '0';
    console.log(`[Analytics] Subscribers: ${currentSubscribers}, Uploads Playlist: ${uploadsPlaylistId}`);

    // 2. Fetch the 2 most recent videos
    let recentVideos: any[] = [];
    let latestVideoStats: any = null;
    let latestVideoSnippet: any = null;

    if (uploadsPlaylistId) {
      console.log(`[Analytics] Fetching playlist items from: ${uploadsPlaylistId}`);
      const playlistRes = await youtube.playlistItems.list({
        part: ['snippet', 'contentDetails'],
        playlistId: uploadsPlaylistId,
        maxResults: 2
      });

      const playlistItems = playlistRes.data.items || [];
      console.log(`[Analytics] Playlist items returned: ${playlistItems.length}`);
      
      const videoIds = playlistItems
        .map(item => item.snippet?.resourceId?.videoId || item.contentDetails?.videoId)
        .filter(Boolean) as string[];
      
      console.log(`[Analytics] Video IDs extracted: ${JSON.stringify(videoIds)}`);
      
      if (videoIds.length > 0) {
        console.log(`[Analytics] Fetching video details for IDs: ${videoIds.join(', ')}`);
        const videosRes = await youtube.videos.list({
          part: ['statistics', 'snippet', 'contentDetails'],
          id: videoIds
        });
        
        recentVideos = videosRes.data.items || [];
        console.log(`[Analytics] Video details returned: ${recentVideos.length} videos`);
        
        if (recentVideos.length > 0) {
          latestVideoSnippet = recentVideos[0].snippet;
          latestVideoStats = recentVideos[0].statistics;
          console.log(`[Analytics] Latest video: "${latestVideoSnippet?.title}", Views: ${latestVideoStats?.viewCount}`);
        }
      } else {
        console.warn(`[Analytics] No video IDs found in playlist items`);
      }
    } else {
      console.warn(`[Analytics] No uploads playlist ID found on channel`);
    }

    // 3. YouTube Analytics API
    const analyticsApi = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client });
    const today = new Date();
    const twentyEightDaysAgo = new Date(today.getTime() - (28 * 24 * 60 * 60 * 1000));
    const twoDaysAgo = new Date(today.getTime() - (2 * 24 * 60 * 60 * 1000));
    const formatDate = (date: Date) => date.toISOString().split('T')[0];

    let summaryViews = 0;
    let summaryWatchTime = 0;
    let latestVideoCtr = 'N/A';
    let latestVideoAvd = 'N/A';
    let topContentWith48hViews: Array<{ title: string; views: string }> = [];

    // Use "MINE" which is more reliable than using the channel ID directly
    const analyticsChannelId = `channel==MINE`;

    console.log(`[Analytics] Fetching 28-day summary from ${formatDate(twentyEightDaysAgo)} to ${formatDate(today)}`);
    try {
      const summaryRes = await analyticsApi.reports.query({
        ids: analyticsChannelId,
        startDate: formatDate(twentyEightDaysAgo),
        endDate: formatDate(today),
        metrics: 'views,estimatedMinutesWatched',
      });
      console.log(`[Analytics] 28-day rows: ${JSON.stringify(summaryRes.data.rows)}`);
      if (summaryRes.data.rows && summaryRes.data.rows.length > 0) {
        summaryViews = summaryRes.data.rows[0][0] as number;
        summaryWatchTime = (summaryRes.data.rows[0][1] as number) / 60;
        console.log(`[Analytics] Summary - Views: ${summaryViews}, Watch hours: ${summaryWatchTime.toFixed(1)}`);
      }
    } catch (err: any) {
      console.error(`[Analytics] 28-day summary FAILED: ${err.message}`);
      if (err.response?.data) console.error(`[Analytics] Detail: ${JSON.stringify(err.response.data)}`);
    }

    // Per-video CTR & AVD for the latest video
    if (recentVideos.length > 0 && latestVideoSnippet) {
      const latestVideoId = recentVideos[0].id;
      const videoPublished = new Date(latestVideoSnippet.publishedAt);
      // Use the video's publish date as start, today as end
      const startDate = formatDate(videoPublished);
      console.log(`[Analytics] Fetching CTR/AVD for video ${latestVideoId} from ${startDate}`);
      try {
        const videoAnalyticsRes = await analyticsApi.reports.query({
          ids: analyticsChannelId,
          startDate: startDate,
          endDate: formatDate(today),
          metrics: 'impressionsClickThroughRate,averageViewDuration',
          filters: `video==${latestVideoId}`,
        });
        console.log(`[Analytics] Video metrics rows: ${JSON.stringify(videoAnalyticsRes.data.rows)}`);
        if (videoAnalyticsRes.data.rows && videoAnalyticsRes.data.rows.length > 0) {
          const ctrRaw = videoAnalyticsRes.data.rows[0][0] as number;
          const avdRaw = videoAnalyticsRes.data.rows[0][1] as number; // seconds
          latestVideoCtr = `${(ctrRaw * 100).toFixed(1)}%`;
          const avdMin = Math.floor(avdRaw / 60);
          const avdSec = Math.round(avdRaw % 60);
          latestVideoAvd = `${avdMin}:${avdSec.toString().padStart(2, '0')}`;
          console.log(`[Analytics] CTR: ${latestVideoCtr}, AVD: ${latestVideoAvd}`);
        }
      } catch (err: any) {
        console.error(`[Analytics] Video CTR/AVD FAILED: ${err.message}`);
        if (err.response?.data) console.error(`[Analytics] Detail: ${JSON.stringify(err.response.data)}`);
      }
    }

    // 48-hour top content from Analytics API (actual recent views, not all-time)
    console.log(`[Analytics] Fetching 48h top content from ${formatDate(twoDaysAgo)} to ${formatDate(today)}`);
    try {
      const topContentRes = await analyticsApi.reports.query({
        ids: analyticsChannelId,
        startDate: formatDate(twoDaysAgo),
        endDate: formatDate(today),
        metrics: 'views',
        dimensions: 'video',
        sort: '-views',
        maxResults: 5,
      });
      console.log(`[Analytics] 48h top content rows: ${JSON.stringify(topContentRes.data.rows)}`);
      if (topContentRes.data.rows && topContentRes.data.rows.length > 0) {
        // rows = [[videoId, views], ...]
        const topVideoIds = topContentRes.data.rows.map((r: any) => r[0]) as string[];
        const topViews = topContentRes.data.rows.reduce((acc: any, r: any) => ({ ...acc, [r[0]]: r[1] }), {});

        // Fetch titles for these video IDs
        const topVideosRes = await youtube.videos.list({
          part: ['snippet'],
          id: topVideoIds
        });
        topContentWith48hViews = (topVideosRes.data.items || []).map((vid: any) => ({
          title: vid.snippet?.title || 'Unknown',
          views: String(topViews[vid.id] || '0')
        }));
      } else {
        // Fallback: use all-time views from already fetched videos but mark them
        topContentWith48hViews = recentVideos.map(vid => ({
          title: vid.snippet?.title || 'Unknown',
          views: vid.statistics?.viewCount || '0'
        }));
      }
    } catch (err: any) {
      console.error(`[Analytics] 48h top content FAILED: ${err.message}`);
      if (err.response?.data) console.error(`[Analytics] Detail: ${JSON.stringify(err.response.data)}`);
      // Fallback to Data API view counts
      topContentWith48hViews = recentVideos.map(vid => ({
        title: vid.snippet?.title || 'Unknown',
        views: vid.statistics?.viewCount || '0'
      }));
    }

    // Build response
    const payload = {
      subscribers: currentSubscribers,
      summary: {
        views: summaryViews,
        watchTimeHours: summaryWatchTime.toFixed(1)
      },
      latestVideo: latestVideoSnippet ? {
        title: latestVideoSnippet.title,
        thumbnail: latestVideoSnippet.thumbnails?.maxres?.url
          || latestVideoSnippet.thumbnails?.high?.url
          || latestVideoSnippet.thumbnails?.medium?.url
          || latestVideoSnippet.thumbnails?.default?.url,
        publishedAt: latestVideoSnippet.publishedAt,
        views: latestVideoStats?.viewCount || '0',
        likes: latestVideoStats?.likeCount || '0',
        ctr: latestVideoCtr,
        avd: latestVideoAvd
      } : null,
      topContent: topContentWith48hViews
    };

    console.log(`[Analytics] ====== Successfully built payload for ${accountId} ======`);
    console.log(`[Analytics] Payload summary: subscribers=${payload.subscribers}, latestVideo=${!!payload.latestVideo}, topContent=${payload.topContent.length} items`);
    res.json(payload);

  } catch (error: any) {
    console.error(`[Analytics] FATAL ERROR for ${accountId}:`, error.message);
    if (error.response?.data) {
      console.error(`[Analytics] API Error detail: ${JSON.stringify(error.response.data)}`);
    }
    res.status(500).json({ error: 'Failed to fetch analytics', detail: error.message });
  }
});



// DELETE /api/accounts/:id
router.delete('/:id', async (req: Request, res: Response) => {
  console.log(`[API] Deleting account with ID ${req.params.id}...`);
  try {
    const deleted = await YouTubeAccount.findByIdAndDelete(req.params.id);
    if (!deleted) {
      console.warn(`[API] Account ${req.params.id} not found for deletion.`);
      return res.status(404).json({ error: 'Account not found' });
    }
    console.log(`[API] Successfully deleted account ${req.params.id}.`);
    res.json({ message: 'Account deleted' });
  } catch (error: any) {
    console.error(`[API] Error deleting account:`, error.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;
