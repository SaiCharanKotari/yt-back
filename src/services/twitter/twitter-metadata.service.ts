/**
 * ============================================================================
 * TWITTER / X METADATA SERVICE
 * ============================================================================
 * Primary: FixTweet API (Ultra-fast direct JSON without API rate-limiting)
 * Fallback: yt-dlp native extraction
 * ============================================================================
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export class TwitterMetadataService {
  /**
   * Fetches Twitter / X video metadata using FixTweet API with yt-dlp fallback
   */
  static async getMetadata(url: string, ytDlpBin: string): Promise<any> {
    const match = url.match(/(?:status|statuses)\/(\d+)/i);
    if (match && match[1]) {
      const tweetId = match[1];
      try {
        const fxRes = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });

        if (fxRes.ok) {
          const data: any = await fxRes.json();
          if (data.code === 200 && data.tweet) {
            const tweet = data.tweet;
            const videos =
              tweet.media?.videos ||
              tweet.media?.all?.filter((m: any) => m.type === 'video' || m.format === 'video/mp4') ||
              [];

            if (videos.length > 0) {
              const vid = videos[0];
              const rawFormats = (vid.formats || vid.variants || []).filter(
                (f: any) => f.url && !f.url.includes('.m3u8')
              );

              const formats = (rawFormats.length > 0 ? rawFormats : [{ url: vid.url, bitrate: 950000 }]).map(
                (f: any, idx: number) => {
                  const urlMatch = f.url?.match(/\/(\d+)x(\d+)\//);
                  const width = f.width || (urlMatch ? parseInt(urlMatch[1], 10) : vid.width);
                  const height = f.height || (urlMatch ? parseInt(urlMatch[2], 10) : vid.height);
                  return {
                    format_id: `http-${f.bitrate || (idx + 1) * 500000}`,
                    url: f.url,
                    ext: 'mp4',
                    vcodec: 'h264',
                    acodec: 'aac',
                    width: width,
                    height: height,
                    resolution: width && height ? `${width}x${height}` : (vid.width && vid.height ? `${vid.width}x${vid.height}` : undefined),
                    tbr: f.bitrate ? Math.round(f.bitrate / 1000) : undefined,
                  };
                }
              );

              formats.sort((a: any, b: any) => (a.height || 0) - (b.height || 0) || (a.tbr || 0) - (b.tbr || 0));

              const bestFormat = formats[formats.length - 1];
              const duration = Math.round(vid.duration || 0);

              return {
                id: tweet.id,
                title: tweet.text ? tweet.text.slice(0, 120) : `Twitter video by ${tweet.author?.name || 'User'}`,
                thumbnail: vid.thumbnail_url || tweet.author?.avatar_url,
                duration: duration,
                duration_string: formatDuration(duration),
                uploader: tweet.author?.name || tweet.author?.screen_name || 'Twitter User',
                view_count: tweet.views || 0,
                upload_date: tweet.created_timestamp
                  ? new Date(tweet.created_timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, '')
                  : undefined,
                extractor_key: 'Twitter',
                extractor: 'twitter',
                url: bestFormat.url || vid.url,
                direct_stream_url: bestFormat.url || vid.url,
                formats: formats,
              };
            } else {
              throw new Error('No video could be found in this tweet/post. Please make sure the link contains an active video or clip.');
            }
          }
        }
      } catch (fxErr: any) {
        if (fxErr.message?.includes('No video could be found')) {
          throw fxErr;
        }
        console.warn('[Twitter Metadata] FixTweet fallback to yt-dlp:', fxErr.message);
      }
    }

    // Fallback: yt-dlp native extraction
    const flags = '--js-runtimes node --no-playlist --no-warnings --no-check-certificate --dump-json';
    const { stdout } = await execAsync(`"${ytDlpBin}" ${flags} "${url}"`, { maxBuffer: 1024 * 1024 * 50 });
    return JSON.parse(stdout);
  }
}
