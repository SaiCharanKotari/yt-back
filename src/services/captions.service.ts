/**
 * captions.service.ts
 * 
 * Extracts, parses, filters, and formats video subtitles / captions (SRT, VTT, TXT)
 * trimmed to the user-selected timeline interval or full video duration.
 */

import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

function resolveYtDlpBinary(): string {
  const candidates = [
    path.join(process.cwd(), 'backend', 'yt-dlp.exe'),
    path.join(process.cwd(), 'yt-dlp.exe'),
    path.join(process.cwd(), 'backend', 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe'),
    path.join(process.cwd(), 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe'),
    path.join(process.cwd(), 'qt-app', 'bin', 'yt-dlp.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp';
}

function resolveTempDir(): string {
  const isInsideBackend = process.cwd().endsWith('backend') || process.cwd().endsWith('backend\\') || process.cwd().endsWith('backend/');
  const target = isInsideBackend
    ? path.join(process.cwd(), 'temp')
    : path.join(process.cwd(), 'backend', 'temp');

  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    return target;
  } catch {}

  const fallback = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const execAsync = promisify(exec);
const YTDLP_BIN = resolveYtDlpBinary();
const TEMP_DIR = resolveTempDir();

export interface SubtitleCue {
  start: number; // in seconds
  end: number;   // in seconds
  text: string;
}

export interface TrimCaptionsOptions {
  url: string;
  format?: 'srt' | 'vtt' | 'txt' | 'captions';
  lang?: string; // e.g. 'en', 'es', 'ko', 'ja', 'auto'
  trimStart?: number;
  trimEnd?: number;
  relativeTimecodes?: boolean; // true = timecodes shift to start at 00:00:00.000
}

export interface TrimmedCaptionResult {
  filePath: string;
  fileName: string;
  content: string;
  cueCount: number;
  format: 'srt' | 'vtt' | 'txt';
}

/**
 * Parses timestamp string (00:01:23.456 or 00:01:23,456 or 01:23.456) to seconds
 */
export function parseTimestampToSeconds(ts: string): number {
  const clean = ts.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(clean) || 0;
}

/**
 * Formats seconds to SRT timestamp: 00:01:23,456
 */
export function formatToSRTTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const totalMs = Math.round(s * 1000);
  const ms = totalMs % 1000;
  const totalSecs = Math.floor(totalMs / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Formats seconds to WebVTT timestamp: 00:01:23.456
 */
export function formatToVTTTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const totalMs = Math.round(s * 1000);
  const ms = totalMs % 1000;
  const totalSecs = Math.floor(totalMs / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * Strips HTML, WebVTT formatting tags, inline timestamp markers, and XML entities
 */
function cleanCueText(text: string): string {
  return text
    .replace(/<[^>]+>/g, '') // remove HTML tags & <00:00:01.000>
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .trim();
}

/**
 * Parses raw WebVTT or SRT text into an array of SubtitleCue objects
 */
export function parseSubtitleText(rawContent: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  if (!rawContent || !rawContent.trim()) return cues;

  // Normalize line breaks
  const normalized = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Regex to match timestamp lines: 00:00:01.000 --> 00:00:04.000 (with optional positioning headers)
  const timeRegex = /((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})/;

  const blocks = normalized.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let timeLineIdx = -1;
    let match: RegExpMatchArray | null = null;

    for (let i = 0; i < lines.length; i++) {
      match = lines[i].match(timeRegex);
      if (match) {
        timeLineIdx = i;
        break;
      }
    }

    if (timeLineIdx !== -1 && match) {
      const start = parseTimestampToSeconds(match[1]);
      const end = parseTimestampToSeconds(match[2]);

      const textLines = lines
        .slice(timeLineIdx + 1)
        .map(l => cleanCueText(l))
        .filter(l => Boolean(l));

      const text = textLines.join('\n').trim();

      if (text && end >= start) {
        cues.push({ start, end, text });
      }
    }
  }

  // Deduplicate rolling identical subtitles
  const deduped: SubtitleCue[] = [];
  for (const c of cues) {
    if (deduped.length > 0 && deduped[deduped.length - 1].text === c.text) {
      deduped[deduped.length - 1].end = Math.max(deduped[deduped.length - 1].end, c.end);
    } else {
      deduped.push({ ...c });
    }
  }

  return deduped;
}

/**
 * Filters and trims cues according to trimStart and trimEnd, with optional relative timecode shifting
 */
export function filterAndShiftCues(
  cues: SubtitleCue[],
  trimStart: number = 0,
  trimEnd?: number,
  relative: boolean = true
): SubtitleCue[] {
  const hasEnd = typeof trimEnd === 'number' && trimEnd > trimStart && trimEnd > 0;
  const startBound = Math.max(0, trimStart || 0);
  const endBound = hasEnd ? trimEnd! : Infinity;

  // If no trimming requested (full video from start 0 to infinity)
  const isFullVideo = startBound === 0 && !hasEnd;

  const filtered: SubtitleCue[] = [];

  for (const cue of cues) {
    if (isFullVideo) {
      filtered.push({ ...cue });
      continue;
    }

    // Cue overlaps with [startBound, endBound] if cue.end > startBound && cue.start < endBound
    if (cue.end > startBound && cue.start < endBound) {
      const clampedStart = Math.max(startBound, cue.start);
      const clampedEnd = Math.min(endBound, cue.end);

      const finalStart = relative ? clampedStart - startBound : clampedStart;
      const finalEnd = relative ? clampedEnd - startBound : clampedEnd;

      filtered.push({
        start: finalStart,
        end: Math.max(finalStart + 0.1, finalEnd),
        text: cue.text,
      });
    }
  }

  // Deduplicate consecutive identical text lines
  const result: SubtitleCue[] = [];
  for (const c of filtered) {
    if (result.length > 0 && result[result.length - 1].text === c.text) {
      result[result.length - 1].end = Math.max(result[result.length - 1].end, c.end);
    } else {
      result.push({ ...c });
    }
  }

  return result;
}

/**
 * Converts array of SubtitleCues to standard .srt string
 */
export function cuesToSRT(cues: SubtitleCue[]): string {
  return (
    cues
      .map((cue, idx) => {
        return `${idx + 1}\n${formatToSRTTimestamp(cue.start)} --> ${formatToSRTTimestamp(cue.end)}\n${cue.text}`;
      })
      .join('\n\n') + '\n'
  );
}

/**
 * Converts array of SubtitleCues to WebVTT string
 */
export function cuesToVTT(cues: SubtitleCue[]): string {
  const body = cues
    .map((cue, idx) => {
      return `${idx + 1}\n${formatToVTTTimestamp(cue.start)} --> ${formatToVTTTimestamp(cue.end)}\n${cue.text}`;
    })
    .join('\n\n');
  return `WEBVTT - Generated by ClipFlow\n\n${body}\n`;
}

/**
 * Converts array of SubtitleCues to plain continuous transcript (.txt)
 */
export function cuesToTXT(cues: SubtitleCue[]): string {
  return cues.map(c => c.text).join('\n');
}

/**
 * Fetches captions from YouTube via yt-dlp, trims to selected timeline, and writes output file.
 */
export async function fetchAndTrimCaptions(
  options: TrimCaptionsOptions
): Promise<TrimmedCaptionResult> {
  const {
    url,
    format = 'srt',
    lang = 'en',
    trimStart = 0,
    trimEnd,
    relativeTimecodes = true,
  } = options;

  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const tempPrefix = path.join(TEMP_DIR, `subs_${jobId}`);

  // Safe targeted language list to prevent 429 rate limit
  const englishLangs = 'en,en-orig,en-US,en-GB,en-IN,en-CA,en-AU,en-IE,en-NZ,en-ZA,en-en';
  const targetLangs =
    lang && lang !== 'en' && lang !== 'auto'
      ? `${lang},${englishLangs}`
      : englishLangs;

  // Helper to find downloaded subtitle files
  const getSubFiles = () =>
    fs.readdirSync(TEMP_DIR).filter(
      f =>
        f.startsWith(`subs_${jobId}`) &&
        (f.endsWith('.srt') ||
          f.endsWith('.vtt') ||
          f.endsWith('.ttml') ||
          f.endsWith('.json3') ||
          f.endsWith('.srv3'))
    );

  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  let baseArgs = '--no-warnings --no-check-certificate --no-playlist --skip-download --ignore-errors --js-runtimes node';
  if (isYouTube) {
    baseArgs += ' --extractor-args "youtube:player_client=android,web_embedded"';
  } else if (url.includes('instagram.com')) {
    baseArgs += ' --add-header "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"';
  }

  // Tier 1: Download human-uploaded subtitles (fast, high quality, no 429)
  console.log(`[Captions Service] Tier 1: Fetching human subtitles for ${url}...`);
  try {
    const cmd1 = `"${YTDLP_BIN}" ${baseArgs} --write-subs --sub-langs "${targetLangs},all" -o "${tempPrefix}.%(ext)s" "${url}"`;
    await execAsync(cmd1);
  } catch (err: any) {
    console.warn(`[Captions Service] Tier 1 note:`, err.message);
  }

  let files = getSubFiles();

  // Tier 2: If no human subs, fetch auto-generated subs for targeted languages
  if (files.length === 0) {
    console.log(`[Captions Service] Tier 2: No manual subs. Fetching auto-generated subs (${targetLangs})...`);
    try {
      const cmd2 = `"${YTDLP_BIN}" ${baseArgs} --write-auto-subs --sub-langs "${targetLangs}" -o "${tempPrefix}.%(ext)s" "${url}"`;
      await execAsync(cmd2);
    } catch (err: any) {
      console.warn(`[Captions Service] Tier 2 note:`, err.message);
    }
    files = getSubFiles();
  }

  // Tier 3: Fallback - native auto-sub in case video is non-English
  if (files.length === 0) {
    console.log(`[Captions Service] Tier 3: Fetching native auto-sub fallback...`);
    try {
      const cmd3 = `"${YTDLP_BIN}" ${baseArgs} --write-auto-subs --sub-langs "auto,orig,${lang},en" -o "${tempPrefix}.%(ext)s" "${url}"`;
      await execAsync(cmd3);
    } catch (err: any) {
      console.warn(`[Captions Service] Tier 3 note:`, err.message);
    }
    files = getSubFiles();
  }

  let rawContent = '';
  if (files.length > 0) {
    // Priority: clean English human, then English auto dialects, then any English, then any VTT/SRT, then first found
    const matchFile =
      files.find(f => f.endsWith('.en.vtt') || f.endsWith('.en.srt')) ||
      files.find(
        f =>
          f.includes('.en-orig.') ||
          f.includes('.en-US.') ||
          f.includes('.en-GB.') ||
          f.includes('.en-IN.') ||
          f.includes('.en-CA.') ||
          f.includes('.en-AU.')
      ) ||
      files.find(f => f.includes('.en.') || f.includes('.en-') || f.includes('-en.')) ||
      files.find(f => f.endsWith('.vtt') || f.endsWith('.srt')) ||
      files[0];

    const subPath = path.join(TEMP_DIR, matchFile);
    try {
      rawContent = fs.readFileSync(subPath, 'utf8');
      console.log(`[Captions Service] Successfully loaded subtitle file: ${matchFile} (${rawContent.length} bytes)`);
    } catch (e: any) {
      console.error(`[Captions Service] Error reading subtitle file ${subPath}:`, e.message);
    }

    // Clean up temporary downloaded files for this job
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(TEMP_DIR, f));
      } catch {}
    }
  }

  // Parse, filter & shift cues
  let cues = parseSubtitleText(rawContent);
  cues = filterAndShiftCues(cues, trimStart, trimEnd, relativeTimecodes);

  // Format to requested target format
  const targetFmt = format === 'vtt' ? 'vtt' : format === 'txt' ? 'txt' : 'srt';
  let outputContent = '';
  if (targetFmt === 'vtt') {
    outputContent = cuesToVTT(cues);
  } else if (targetFmt === 'txt') {
    outputContent = cuesToTXT(cues);
  } else {
    outputContent = cuesToSRT(cues);
  }

  // If no subtitles were found or video has no speech in that range:
  if (cues.length === 0) {
    outputContent =
      targetFmt === 'txt'
        ? '[No captions found or no speech detected in this timeline section]'
        : targetFmt === 'vtt'
        ? 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\n[No speech detected in this section]\n'
        : '1\n00:00:00,000 --> 00:00:05,000\n[No speech detected in this section]\n';
  }

  const finalFileName = `${jobId}.${targetFmt}`;
  const finalFilePath = path.join(TEMP_DIR, finalFileName);
  fs.writeFileSync(finalFilePath, outputContent, 'utf8');

  return {
    filePath: finalFilePath,
    fileName: finalFileName,
    content: outputContent,
    cueCount: cues.length,
    format: targetFmt,
  };
}
