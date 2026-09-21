/**
 * ============================================================================
 * TWITCH METADATA SERVICE
 * ============================================================================
 * Handles lightweight live channel metadata, in-flight deduplication,
 * and robust retry handling for Twitch Clips, VODs, and Channels.
 * ============================================================================
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class TwitchMetadataService {
  private static inFlightRequests = new Map<string, Promise<any>>();
  private static metadataCache = new Map<string, { data: any; expiresAt: number }>();

  /**
   * Universal Twitch metadata resolver with deduplication and lightweight live channel detection
   */
  static async getMetadata(url: string, ytDlpBin: string, retries = 2): Promise<any> {
    const cleanUrl = url.trim();
    const cacheKey = cleanUrl.toLowerCase();

    // 1. Check in-memory cache (3 minutes TTL for live channels, 15 min for VODs)
    const cached = this.metadataCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // 2. Check if identical request is already in-flight (Deduplication)
    if (this.inFlightRequests.has(cacheKey)) {
      const channelMatch = cleanUrl.match(/twitch\.tv\/([a-zA-Z0-9_]+)(?:\/)?$/i);
      const channel = channelMatch ? channelMatch[1].toLowerCase() : cleanUrl;
      console.log(`[Twitch Metadata] Deduplicated existing request for ${channel}`);
      return await this.inFlightRequests.get(cacheKey);
    }

    const requestPromise = this.resolveMetadataInternal(cleanUrl, ytDlpBin, retries);
    this.inFlightRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      const isLive = Boolean(result?.is_live || result?.live_status === 'is_live');
      this.metadataCache.set(cacheKey, {
        data: result,
        expiresAt: Date.now() + (isLive ? 3 * 60 * 1000 : 15 * 60 * 1000),
      });
      return result;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }

  private static async resolveMetadataInternal(url: string, ytDlpBin: string, retries: number): Promise<any> {
    const channelMatch = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)(?:\/)?$/i);
    const isChannel = Boolean(
      channelMatch &&
      channelMatch[1] &&
      !['directory', 'videos', 'clip', 'p', 'settings', 'downloads'].includes(channelMatch[1].toLowerCase()) &&
      !url.includes('/videos') &&
      !url.includes('/clip')
    );

    // ─── 1. DEDICATED LIVE CHANNEL HANDLER (LIGHTWEIGHT GQL - NO HEAVY YT-DLP) ─
    if (isChannel && channelMatch) {
      const channel = channelMatch[1].toLowerCase();
      console.log(`[Twitch Metadata] LIVE channel detected: ${channel}`);

      let liveGqlUser: any = null;
      try {
        const gqlRes = await fetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: {
            'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `query { user(login: "${channel}") { displayName profileImageURL(width: 300) broadcastSettings { title game { name } } stream { id createdAt title type viewersCount } videos(first: 3, sort: TIME) { edges { node { id title createdAt lengthSeconds status broadcastType } } } } }`,
          }),
        });
        if (gqlRes.ok) {
          const gqlData = await gqlRes.json();
          liveGqlUser = gqlData?.data?.user;
        }
      } catch (gqlErr: any) {
        console.warn(`[Twitch Metadata] GQL query warning for ${channel}:`, gqlErr.message);
      }

      const isLiveNow = Boolean(
        liveGqlUser?.stream?.type === 'live' ||
        liveGqlUser?.stream?.createdAt ||
        liveGqlUser?.stream?.id
      );

      if (isLiveNow) {
        console.log(`[Twitch Metadata] Using lightweight LIVE metadata`);

        let elapsedSec = 0;
        let startEpoch = 0;
        if (liveGqlUser?.stream?.createdAt) {
          startEpoch = Math.floor(new Date(liveGqlUser.stream.createdAt).getTime() / 1000);
          elapsedSec = Math.max(10, Math.floor(Date.now() / 1000 - startEpoch));
        }

        const recordingVod = liveGqlUser?.videos?.edges?.find((e: any) => {
          const n = e?.node;
          return n && (n.status === 'RECORDING' || n.broadcastType === 'ARCHIVE');
        })?.node;

        const title =
          liveGqlUser?.stream?.title ||
          liveGqlUser?.broadcastSettings?.title ||
          `${liveGqlUser?.displayName || channel} — Live Stream`;

        const uploader = liveGqlUser?.displayName || channel;
        const thumbnail =
          liveGqlUser?.profileImageURL ||
          `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel}-640x360.jpg`;

        // Return lightweight metadata immediately — live playback chunks are handled separately
        return {
          id: liveGqlUser?.stream?.id || channel,
          title,
          uploader,
          channel,
          channel_url: `https://www.twitch.tv/${channel}`,
          thumbnail,
          duration: elapsedSec,
          duration_string: 'LIVE',
          is_live: true,
          live_status: 'is_live',
          release_timestamp: startEpoch,
          timestamp: startEpoch,
          game: liveGqlUser?.broadcastSettings?.game?.name || '',
          viewers_count: liveGqlUser?.stream?.viewersCount || 0,
          active_dvr_vod_id: recordingVod?.id || undefined,
          formats: [
            { format_id: '1080p', height: 1080, width: 1920, resolution: '1920x1080', url: '', tbr: 6000 },
            { format_id: '720p', height: 720, width: 1280, resolution: '1280x720', url: '', tbr: 3000 },
            { format_id: '480p', height: 480, width: 854, resolution: '854x480', url: '', tbr: 1500 },
            { format_id: '360p', height: 360, width: 640, resolution: '640x360', url: '', tbr: 800 },
          ],
          webpage_url: `https://www.twitch.tv/${channel}`,
          _isLightweightLive: true,
        };
      } else {
        throw new Error(`The Twitch channel "${channel}" is not currently live and has no active broadcast.`);
      }
    }

    // ─── 2. VODs AND CLIPS EXTRACTION (WITH TRANSIENT 10054 RETRY) ─────────────
    const runYtDlp = async (targetUrl: string, flags: string): Promise<any> => {
      let lastErr: any;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const { stdout } = await execAsync(
            `"${ytDlpBin}" --dump-json --js-runtimes node --no-warnings --no-check-certificate ${flags} "${targetUrl}"`,
            { maxBuffer: 1024 * 1024 * 50 }
          );
          return JSON.parse(stdout);
        } catch (err: any) {
          lastErr = err;
          const msg = err?.message || String(err);
          const isConnectionReset =
            msg.includes('10054') ||
            msg.includes('ConnectionResetError') ||
            msg.includes('Connection aborted') ||
            msg.includes('forcibly closed') ||
            msg.includes('commercial') ||
            msg.includes('timed out');

          if (attempt < retries && isConnectionReset) {
            console.log('[Twitch Metadata] Retry after transient connection reset');
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          break;
        }
      }
      throw lastErr;
    };

    return await runYtDlp(url, '');
  }
}
