/**
 * ============================================================================
 * TWITCH STREAM RESOLVER SERVICE
 * ============================================================================
 * Resolves Twitch Channels, DVR VODs, Standard VODs, and Clips to their
 * direct HLS stream URLs using Twitch's internal GQL + Usher API.
 *
 * This approach avoids yt-dlp entirely for URL resolution, preventing
 * the ConnectionResetError(10054) that Twitch triggers on yt-dlp requests.
 * ============================================================================
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Twitch Client ID (Public, same one browsers use) ────────────────────────
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

export interface StreamResolutionResult {
  streamUrl: string;
  sourceType: 'dvr' | 'live' | 'vod' | 'clip';
  vodId?: string;
  channel?: string;
}

interface CacheEntry {
  result: StreamResolutionResult;
  expiresAt: number;
}

const streamCache = new Map<string, CacheEntry>();
const inFlightResolutions = new Map<string, Promise<StreamResolutionResult>>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function gqlHeaders(): Record<string, string> {
  return {
    'Client-ID': TWITCH_CLIENT_ID,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
}

/**
 * Obtains a PlaybackAccessToken (token + signature) from Twitch GQL.
 * This is the same flow the Twitch web player performs before making Usher requests.
 */
async function getPlaybackAccessToken(
  channelOrVodId: string,
  isVod = false
): Promise<{ token: string; sig: string } | null> {
  const body = isVod
    ? JSON.stringify({
        operationName: 'PlaybackAccessToken',
        extensions: { persistedQuery: { version: 1, sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712' } },
        variables: { isLive: false, login: '', isVod: true, vodID: channelOrVodId, playerType: 'embed' },
      })
    : JSON.stringify({
        operationName: 'PlaybackAccessToken',
        extensions: { persistedQuery: { version: 1, sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712' } },
        variables: { isLive: true, login: channelOrVodId, isVod: false, vodID: '', playerType: 'embed' },
      });

  try {
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: gqlHeaders(),
      body,
    });

    if (!res.ok) {
      console.warn(`[Twitch GQL] PlaybackAccessToken returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const tokenObj = isVod
      ? data?.data?.videoPlaybackAccessToken
      : data?.data?.streamPlaybackAccessToken;

    if (!tokenObj?.value || !tokenObj?.signature) {
      console.warn('[Twitch GQL] PlaybackAccessToken missing value/signature', JSON.stringify(data).substring(0, 200));
      return null;
    }

    return { token: tokenObj.value, sig: tokenObj.signature };
  } catch (err: any) {
    console.warn('[Twitch GQL] PlaybackAccessToken error:', err.message);
    return null;
  }
}

/**
 * Picks the best-quality variant URL from an M3U8 master playlist text.
 * Filters by quality height if provided.
 */
function selectBestVariantUrl(m3u8: string, quality?: string): string | null {
  const lines = m3u8.split('\n');
  const streams: Array<{ bandwidth: number; height: number; url: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
      const urlLine = lines[i + 1]?.trim();
      if (urlLine && urlLine.startsWith('http')) {
        streams.push({
          bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
          height: resMatch ? parseInt(resMatch[1], 10) : 0,
          url: urlLine,
        });
      }
    }
  }

  if (streams.length === 0) return null;
  streams.sort((a, b) => b.bandwidth - a.bandwidth);

  if (quality && quality !== 'best' && quality !== 'source') {
    const targetHeight = parseInt(quality.replace('p', ''), 10);
    if (!isNaN(targetHeight)) {
      const match = streams.find((s) => s.height <= targetHeight);
      if (match) return match.url;
    }
  }

  return streams[0].url;
}

/**
 * Resolves a live channel HLS URL via Twitch Usher API.
 */
async function resolveChannelHls(channelName: string, quality?: string): Promise<string | null> {
  const tokenData = await getPlaybackAccessToken(channelName.toLowerCase(), false);
  if (!tokenData) return null;

  const params = new URLSearchParams({
    sig: tokenData.sig,
    token: tokenData.token,
    allow_source: 'true',
    allow_spectre: 'false',
    allow_audio_only: 'true',
    fast_bread: 'true',
    p: String(Math.floor(Math.random() * 999999)),
    platform: 'web',
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    reassignments_supported: 'true',
    supported_codecs: 'avc1',
    cdm: 'wv',
    transcode_mode: 'cbr_v1',
  });

  const usherUrl = `https://usher.ttvnw.net/api/channel/hls/${channelName.toLowerCase()}.m3u8?${params.toString()}`;
  console.log(`[Twitch Usher] 🎯 Fetching live HLS for channel: ${channelName}`);

  try {
    const res = await fetch(usherUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.twitch.tv/',
        'Origin': 'https://www.twitch.tv',
      },
    });

    if (!res.ok) {
      console.warn(`[Twitch Usher] ❌ Live Usher returned HTTP ${res.status} for ${channelName}`);
      return null;
    }

    const m3u8Text = await res.text();
    const bestUrl = selectBestVariantUrl(m3u8Text, quality);
    if (bestUrl) {
      console.log(`[Twitch Usher] ✅ Resolved live HLS for ${channelName}: ${bestUrl.substring(0, 80)}...`);
      return bestUrl;
    }
    // Return the master playlist URL as fallback
    return usherUrl;
  } catch (err: any) {
    console.warn('[Twitch Usher] ❌ Failed to fetch live channel playlist:', err.message);
    return null;
  }
}

/**
 * Resolves a VOD/DVR VOD HLS URL via Twitch Usher API.
 */
async function resolveVodHls(vodId: string, quality?: string): Promise<string | null> {
  const tokenData = await getPlaybackAccessToken(vodId, true);
  if (!tokenData) return null;

  const params = new URLSearchParams({
    sig: tokenData.sig,
    token: tokenData.token,
    allow_source: 'true',
    allow_audio_only: 'true',
    allow_spectre: 'false',
    p: String(Math.floor(Math.random() * 999999)),
    platform: 'web',
    supported_codecs: 'avc1',
    cdm: 'wv',
  });

  const usherUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?${params.toString()}`;
  console.log(`[Twitch Usher] 🎯 Fetching VOD HLS for VOD: ${vodId}`);

  try {
    const res = await fetch(usherUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.twitch.tv/',
        'Origin': 'https://www.twitch.tv',
      },
    });

    if (!res.ok) {
      console.warn(`[Twitch Usher] ❌ VOD Usher returned HTTP ${res.status} for VOD ${vodId}`);
      return null;
    }

    const m3u8Text = await res.text();
    const bestUrl = selectBestVariantUrl(m3u8Text, quality);
    if (bestUrl) {
      console.log(`[Twitch Usher] ✅ Resolved VOD HLS for ${vodId}: ${bestUrl.substring(0, 80)}...`);
      return bestUrl;
    }
    return usherUrl;
  } catch (err: any) {
    console.warn('[Twitch Usher] ❌ Failed to fetch VOD playlist:', err.message);
    return null;
  }
}

/**
 * Resolves direct HLS playlist from Twitch CloudFront CDN using VOD metadata.
 * Bypasses Usher and yt-dlp completely for 100% reliable, instant playback.
 */
async function resolveCloudFrontDvrFromNode(node: any, quality?: string): Promise<string | null> {
  if (!node) return null;
  let baseDomain = '';
  let basePath = '';

  if (node.seekPreviewsURL) {
    const match = node.seekPreviewsURL.match(/https:\/\/([^/]+)\/([^/]+)\/storyboards/);
    if (match) {
      baseDomain = match[1];
      basePath = match[2];
    }
  }

  if (!basePath && node.previewThumbnailURL) {
    const match = node.previewThumbnailURL.match(/\/cf_vods\/([^/]+)\/([^/]+)\//);
    if (match) {
      baseDomain = `${match[1]}.cloudfront.net`;
      basePath = match[2];
    }
  }

  if (!baseDomain || !basePath) return null;

  // Build candidate paths in order of preference
  const candidates: string[] = [];
  if (quality && quality !== 'best' && quality !== 'source' && quality !== '1080p') {
    const cleanQ = quality.toLowerCase().replace('p', '');
    candidates.push(`https://${baseDomain}/${basePath}/${cleanQ}p60/index-dvr.m3u8`);
    candidates.push(`https://${baseDomain}/${basePath}/${cleanQ}p30/index-dvr.m3u8`);
  }
  candidates.push(`https://${baseDomain}/${basePath}/chunked/index-dvr.m3u8`);
  candidates.push(`https://${baseDomain}/${basePath}/chunked/index-muted.m3u8`);
  candidates.push(`https://${baseDomain}/${basePath}/chunked/index.m3u8`);

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { method: 'HEAD' });
      if (res.ok) {
        console.log(`[Twitch CloudFront Direct ✅] Resolved: ${candidate}`);
        return candidate;
      }
    } catch {
      // Continue to next candidate
    }
  }

  return null;
}

/**
 * Resolves explicit VOD URL via CloudFront directly.
 */
async function resolveVodCloudFront(vodId: string, quality?: string): Promise<string | null> {
  try {
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: gqlHeaders(),
      body: JSON.stringify({
        query: `query {
          video(id: "${vodId}") {
            id
            seekPreviewsURL
            previewThumbnailURL(height: 180, width: 320)
          }
        }`,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const node = data?.data?.video;
    if (!node) return null;
    return await resolveCloudFrontDvrFromNode(node, quality);
  } catch (err: any) {
    console.warn('[Twitch VOD GQL Error]', err.message);
    return null;
  }
}

/**
 * yt-dlp fallback — used only for clips and as absolute last resort.
 */
async function resolveViaYtDlp(targetUrl: string, ytDlpBin: string, quality?: string): Promise<string | null> {
  let formatFilter = 'best/bestvideo+bestaudio';
  if (quality && quality !== 'source' && quality !== 'best') {
    const height = parseInt(quality.replace('p', ''), 10);
    if (!isNaN(height) && height > 0) {
      formatFilter = `best[height<=${height}]/bestvideo[height<=${height}]+bestaudio/best`;
    }
  }

  const cmd = `"${ytDlpBin}" -g -f "${formatFilter}" --no-warnings --no-check-certificate "${targetUrl}"`;
  console.log(`[Twitch yt-dlp Fallback] 🔧 Trying yt-dlp for: ${targetUrl.substring(0, 80)}`);

  try {
    const { stdout } = await execAsync(cmd, { timeout: 25000 });
    const url = stdout.trim().split('\n')[0].trim();
    if (url && url.startsWith('http')) {
      console.log(`[Twitch yt-dlp Fallback] ✅ yt-dlp resolved: ${url.substring(0, 80)}...`);
      return url;
    }
  } catch (err: any) {
    console.warn(`[Twitch yt-dlp Fallback] ❌ yt-dlp failed: ${err.message?.split('\n')[0]}`);
  }
  return null;
}

// ─── Main Service ─────────────────────────────────────────────────────────────

export class TwitchStreamResolverService {
  /**
   * Resolves the active recording DVR VOD node for a live Twitch channel via GQL.
   */
  static async resolveActiveDvrNode(channelName: string): Promise<any | null> {
    const channel = channelName.toLowerCase().trim();
    if (!channel || ['videos', 'clip', 'directory', 'p', 'settings'].includes(channel)) {
      return null;
    }

    try {
      const gqlRes = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: gqlHeaders(),
        body: JSON.stringify({
          query: `query {
            user(login: "${channel}") {
              stream { id createdAt }
              videos(first: 5, sort: TIME) {
                edges {
                  node {
                    id
                    status
                    broadcastType
                    createdAt
                    seekPreviewsURL
                    previewThumbnailURL(height: 180, width: 320)
                  }
                }
              }
            }
          }`,
        }),
      });

      if (!gqlRes.ok) return null;

      const gqlData = await gqlRes.json();
      const userObj = gqlData?.data?.user;
      const streamObj = userObj?.stream;
      const edges = userObj?.videos?.edges || [];

      // 1. Explicit RECORDING status = active DVR VOD
      let recordingVod = edges.find((e: any) => e?.node?.status === 'RECORDING')?.node;

      // 2. If stream is live and top video is ARCHIVE type → it's the DVR VOD
      if (!recordingVod && streamObj?.id && edges.length > 0) {
        const topNode = edges[0]?.node;
        if (topNode?.broadcastType === 'ARCHIVE') {
          recordingVod = topNode;
        }
      }

      // 3. Fallback to latest video if created within recent broadcast
      if (!recordingVod && edges.length > 0) {
        const topNode = edges[0]?.node;
        if (topNode?.broadcastType === 'ARCHIVE' || topNode?.status === 'RECORDED') {
          recordingVod = topNode;
        }
      }

      if (recordingVod) {
        return recordingVod;
      }
    } catch (err: any) {
      console.warn(`[Twitch Stream Resolver] GQL DVR check error for ${channel}:`, err.message);
    }
    return null;
  }

  /**
   * Resolves direct HLS stream URL for any Twitch URL.
   *
   * Strategy (in order):
   *   1. CloudFront Direct DVR (instant, no auth, no blocking)
   *   2. Usher API (usher.ttvnw.net)
   *   3. yt-dlp last resort
   */
  static async resolveStreamUrl(
    targetUrl: string,
    ytDlpBin: string,
    quality?: string,
    forceRefresh = false
  ): Promise<StreamResolutionResult> {
    const cleanUrl = targetUrl.split('?')[0].replace(/\/$/, '');
    const cacheKey = `${cleanUrl.toLowerCase()}_${quality || 'best'}`;

    // 1. Cache hit
    if (!forceRefresh) {
      const cached = streamCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        console.log(`[Twitch Stream Resolver ⚡ CACHE HIT] ${cacheKey}`);
        return cached.result;
      }
    }

    // 2. Single-flight deduplication
    const existingInFlight = inFlightResolutions.get(cacheKey);
    if (existingInFlight && !forceRefresh) {
      console.log(`[Twitch Stream Resolver ⚡ SINGLE-FLIGHT] Joining in-flight resolution for: ${cacheKey}`);
      return await existingInFlight;
    }

    // 3. Initiate new resolution
    const resolutionPromise = (async (): Promise<StreamResolutionResult> => {
      const channelMatch = cleanUrl.match(/twitch\.tv\/([a-zA-Z0-9_]+)$/i);
      const isChannel = Boolean(
        channelMatch &&
        channelMatch[1] &&
        !['videos', 'clip', 'directory', 'p', 'settings'].includes(channelMatch[1].toLowerCase())
      );
      const channel = isChannel ? channelMatch![1].toLowerCase() : undefined;

      const isClip = targetUrl.includes('/clip/') || targetUrl.includes('clips.twitch.tv');
      const isVodUrl = targetUrl.includes('/videos/');
      const vodMatch = targetUrl.match(/videos\/(\d+)/);
      const vodId = vodMatch ? vodMatch[1] : undefined;

      let sourceType: 'dvr' | 'live' | 'vod' | 'clip' = 'vod';
      let resolvedVodId: string | undefined = vodId;
      let resolvedChannel: string | undefined = channel;
      let streamUrl: string | null = null;

      // ─── CLIP ─────────────────────────────────────────────────────────────
      if (isClip) {
        sourceType = 'clip';
        streamUrl = await resolveViaYtDlp(targetUrl, ytDlpBin, quality);
        if (!streamUrl) throw new Error('Failed to resolve Twitch clip URL');
      }

      // ─── LIVE CHANNEL ─────────────────────────────────────────────────────
      else if (isChannel && channel) {
        const dvrNode = await this.resolveActiveDvrNode(channel);

        if (dvrNode) {
          console.log(`[Twitch Stream Resolver] 🎯 DVR VOD found: ${dvrNode.id} for channel "${channel}"`);
          sourceType = 'dvr';
          resolvedVodId = String(dvrNode.id);

          // Priority 1: Direct CloudFront HLS (Fastest, zero blocking, instant 200 OK)
          streamUrl = await resolveCloudFrontDvrFromNode(dvrNode, quality);

          // Priority 2: Usher VOD
          if (!streamUrl) {
            console.warn(`[Twitch Stream Resolver ⚠️] CloudFront direct failed, trying Usher VOD...`);
            streamUrl = await resolveVodHls(dvrNode.id, quality);
          }

          // Priority 3: Live Usher
          if (!streamUrl) {
            console.warn(`[Twitch Stream Resolver ⚠️] VOD Usher failed, trying live Usher...`);
            streamUrl = await resolveChannelHls(channel, quality);
            if (streamUrl) sourceType = 'live';
          }

          // Priority 4: yt-dlp last resort
          if (!streamUrl) {
            console.warn(`[Twitch Stream Resolver ⚠️] Usher methods failed, trying yt-dlp...`);
            streamUrl = await resolveViaYtDlp(`https://www.twitch.tv/videos/${dvrNode.id}`, ytDlpBin, quality);
          }
        } else {
          sourceType = 'live';
          console.log(`[Twitch Stream Resolver] 📡 No DVR VOD found, resolving live channel via Usher: ${channel}`);
          streamUrl = await resolveChannelHls(channel, quality);

          if (!streamUrl) {
            console.warn(`[Twitch Stream Resolver ⚠️] Live Usher failed, trying yt-dlp...`);
            streamUrl = await resolveViaYtDlp(targetUrl, ytDlpBin, quality);
          }
        }

        if (!streamUrl) {
          throw new Error(`The channel "${channel}" is not currently live or stream resolution failed.`);
        }
      }

      // ─── EXPLICIT VOD URL ─────────────────────────────────────────────────
      else if (isVodUrl && vodId) {
        sourceType = 'vod';

        // Priority 1: Direct CloudFront HLS
        streamUrl = await resolveVodCloudFront(vodId, quality);

        // Priority 2: Usher VOD
        if (!streamUrl) {
          console.warn(`[Twitch Stream Resolver ⚠️] CloudFront direct failed, trying Usher VOD...`);
          streamUrl = await resolveVodHls(vodId, quality);
        }

        // Priority 3: yt-dlp
        if (!streamUrl) {
          console.warn(`[Twitch Stream Resolver ⚠️] VOD Usher failed, trying yt-dlp...`);
          streamUrl = await resolveViaYtDlp(targetUrl, ytDlpBin, quality);
        }

        if (!streamUrl) throw new Error(`Failed to resolve Twitch VOD ${vodId}`);
      }

      // ─── UNKNOWN ──────────────────────────────────────────────────────────
      else {
        streamUrl = await resolveViaYtDlp(targetUrl, ytDlpBin, quality);
        if (!streamUrl) throw new Error(`Failed to resolve Twitch URL: ${targetUrl}`);
      }

      const result: StreamResolutionResult = {
        streamUrl,
        sourceType,
        vodId: resolvedVodId,
        channel: resolvedChannel,
      };

      // Cache for 12 minutes
      streamCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + 12 * 60 * 1000,
      });

      return result;
    })();

    inFlightResolutions.set(cacheKey, resolutionPromise);

    try {
      const result = await resolutionPromise;
      return result;
    } finally {
      inFlightResolutions.delete(cacheKey);
    }
  }

  /**
   * Manually invalidate cache for a given URL.
   */
  static invalidateCache(targetUrl: string, quality?: string) {
    const cleanUrl = targetUrl.split('?')[0].replace(/\/$/, '');
    const cacheKey = `${cleanUrl.toLowerCase()}_${quality || 'best'}`;
    streamCache.delete(cacheKey);
    console.log(`[Twitch Stream Resolver 🗑️] Cache invalidated for: ${cacheKey}`);
  }
}

