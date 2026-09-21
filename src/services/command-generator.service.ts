// =========================================================================
// DO NOT TOUCH OR MODIFY THIS COMMAND GENERATING CODE UNTIL USER SAYS "edit commands code"
// =========================================================================

export interface CommandGeneratorOptions {
  url: string;
  format?: string;
  quality?: string;
  audioQuality?: string | number;
  trimStart?: number;
  trimEnd?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:5';
  fitMode?: 'crop' | 'pad';
  customFileName?: string;
}

export interface GeneratedCommands {
  powerShellScript: string;
  tempDownloadPath: string;
  finalOutputPath: string;
  ytDlpCmd: string;
  ffmpegCmd: string;
}

/**
 * Format seconds to HH:MM:SS string for yt-dlp / FFmpeg
 */
export function formatSecondsToTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Generates exact, standalone PowerShell workflow commands for yt-dlp + FFmpeg.
 * 
 * Rules:
 * - Includes --js-runtimes node
 * - Uses --force-keyframes-at-cuts when download-sections is active
 * - Quality format: bestvideo[height<=H]+bestaudio/best[height<=H] (or bestvideo+bestaudio/best)
 * - MP3 / audio: -x --audio-format mp3 --audio-quality 0 (or custom bitrate)
 * - Valid PowerShell syntax targeting $env:USERPROFILE\Downloads
 * - --no-playlist
 */
export function generatePowerShellWorkflow(options: CommandGeneratorOptions): GeneratedCommands {
  const {
    url,
    format = 'mp4',
    quality = '1080p',
    audioQuality = '0',
    trimStart = 0,
    trimEnd,
    aspectRatio = '16:9',
    fitMode = 'pad',
    customFileName,
  } = options;

  // Sanitize filename or use YouTube %(title)s template
  let safeBaseName = '%(title)s';
  if (customFileName && customFileName.trim()) {
    safeBaseName = customFileName.replace(/[<>:"/\\|?*]/g, '_').trim();
  }

  const isAudio = format === 'mp3' || format === 'wav' || format === 'm4a' || format === 'aac';
  const fileExt = isAudio ? format : 'mp4';
  const finalOutputPath = `$env:USERPROFILE\\Downloads\\${safeBaseName}_clip.${fileExt}`;
  const tempDownloadPath = `$env:USERPROFILE\\Downloads\\${safeBaseName}_full_temp.${fileExt}`;

  // Quality selector for yt-dlp (240p, 360p, 480p, 720p, 1080p, 1440p, 4k/2160p, or best)
  let heightLimit: number | null = null;
  if (quality && quality.toLowerCase() !== 'best' && quality.toLowerCase() !== 'max') {
    const cleanQuality = quality.toLowerCase().replace('p', '');
    if (cleanQuality === '4k' || cleanQuality === '2160') heightLimit = 2160;
    else if (cleanQuality === '1440' || cleanQuality === '2k') heightLimit = 1440;
    else if (cleanQuality === '1080') heightLimit = 1080;
    else if (cleanQuality === '720') heightLimit = 720;
    else if (cleanQuality === '480') heightLimit = 480;
    else if (cleanQuality === '360') heightLimit = 360;
    else if (cleanQuality === '240') heightLimit = 240;
    else if (!isNaN(Number(cleanQuality))) heightLimit = Number(cleanQuality);
  }

  // Format string
  const ytFormat = heightLimit
    ? `bestvideo[height<=${heightLimit}]+bestaudio/best[height<=${heightLimit}]`
    : `bestvideo+bestaudio/best`;

  // Format time strings if trimming
  const isTrimmed = typeof trimEnd === 'number' && trimEnd > trimStart;
  const startTimeStr = formatSecondsToTime(trimStart);
  const endTimeStr = isTrimmed ? formatSecondsToTime(trimEnd!) : '';

  // Audio quality parameter (0 = best VBR, or 320k, 256k, 192k, 128k)
  let cleanAudioQuality = '0';
  if (audioQuality) {
    cleanAudioQuality = String(audioQuality).trim().toUpperCase();
  }

  let powerShellScript = '';
  let ytDlpCmd = '';
  let ffmpegCmd = '';

  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  const ytExtractorArgs = '';

  if (isAudio) {
    // ── MP3 / Audio Extraction ──────────────────────────────────────────────
    const sectionFlag = isTrimmed ? `--download-sections "*${startTimeStr}-${endTimeStr}" ` : '';
    const keyframesFlag = isTrimmed ? `--force-keyframes-at-cuts ` : '';
    
    ytDlpCmd = `.\\yt-dlp.exe --js-runtimes node ${ytExtractorArgs}${sectionFlag}-x --audio-format ${format} --audio-quality ${cleanAudioQuality} ${keyframesFlag}--no-playlist -o "${finalOutputPath}" "${url}"`.replace(/\s+/g, ' ');
    powerShellScript = ytDlpCmd;
  } else {
    // ── MP4 Video Download ──────────────────────────────────────────────────
    const sectionFlag = isTrimmed ? `--download-sections "*${startTimeStr}-${endTimeStr}" ` : '';
    const keyframesFlag = isTrimmed ? `--force-keyframes-at-cuts ` : '';

    ytDlpCmd = `.\\yt-dlp.exe --js-runtimes node ${ytExtractorArgs}${sectionFlag}-f "${ytFormat}" --merge-output-format mp4 ${keyframesFlag}--no-playlist -o "${finalOutputPath}" "${url}"`.replace(/\s+/g, ' ');
    powerShellScript = ytDlpCmd;
  }

  return {
    powerShellScript,
    tempDownloadPath,
    finalOutputPath,
    ytDlpCmd,
    ffmpegCmd,
  };
}
