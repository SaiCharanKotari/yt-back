import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const FFMPEG_BIN = path.join(process.cwd(), 'ffmpeg.exe');

export interface CropBoxCoordinates {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoCropOptions {
  url: string;
  format?: string;
  quality?: string;
  audioQuality?: string | number;
  trimStart?: number;
  trimEnd?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:5' | 'custom' | string;
  fitMode?: 'crop' | 'pad';
  cropPosition?: 'left' | 'center' | 'right';
  cropBox?: CropBoxCoordinates;
  customFileName?: string;
}

export interface CropPipelineResult {
  isCroppingNeeded: boolean;
  powerShellScript: string;
  tempRawPath?: string;
  finalOutputPath: string;
  ffmpegCmd?: string;
  filterString?: string;
}

/**
 * Returns the exact FFmpeg video filter for the given aspect ratio, fit mode, crop position, or interactive cropBox.
 */
export function getFFmpegAspectFilter(
  aspectRatio?: string,
  fitMode: 'crop' | 'pad' = 'pad',
  cropPosition: 'left' | 'center' | 'right' = 'center',
  cropBox?: CropBoxCoordinates
): string {
  if (!aspectRatio || aspectRatio === '16:9' || aspectRatio === 'original') {
    return ''; // Full 16:9 original video -> zero crop/pad filter
  }

  // Priority 1: Interactive Crop Box Coordinates (Drag-to-Frame / Custom)
  if (fitMode !== 'pad' && cropBox && cropBox.width > 0 && cropBox.height > 0) {
    const w = Math.min(1, Math.max(0.05, cropBox.width)).toFixed(4);
    const h = Math.min(1, Math.max(0.05, cropBox.height)).toFixed(4);
    const x = Math.min(1, Math.max(0, cropBox.x)).toFixed(4);
    const y = Math.min(1, Math.max(0, cropBox.y)).toFixed(4);
    return `crop=trunc(iw*${w}/2)*2:trunc(ih*${h}/2)*2:trunc(iw*${x}/2)*2:trunc(ih*${y}/2)*2`;
  }

  const isCrop = fitMode === 'crop';

  if (aspectRatio === '9:16') {
    if (isCrop) {
      if (cropPosition === 'left') {
        return 'crop=trunc(ih*(9/16)/2)*2:ih:0:0';
      } else if (cropPosition === 'right') {
        return 'crop=trunc(ih*(9/16)/2)*2:ih:iw-trunc(ih*(9/16)/2)*2:0';
      } else {
        return 'crop=trunc(ih*(9/16)/2)*2:ih:(iw-trunc(ih*(9/16)/2)*2)/2:0';
      }
    } else {
      return 'pad=ceil(max(iw\\,ih*9/16)/2)*2:ceil(max(ih\\,iw*16/9)/2)*2:(ow-iw)/2:(oh-ih)/2:color=black';
    }
  }

  if (aspectRatio === '1:1') {
    if (isCrop) {
      if (cropPosition === 'left') {
        return 'crop=min(iw\\,ih):min(iw\\,ih):0:(ih-min(iw\\,ih))/2';
      } else if (cropPosition === 'right') {
        return 'crop=min(iw\\,ih):min(iw\\,ih):iw-min(iw\\,ih):(ih-min(iw\\,ih))/2';
      } else {
        return 'crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2';
      }
    } else {
      return 'pad=ceil(max(iw\\,ih)/2)*2:ceil(max(ih\\,iw)/2)*2:(ow-iw)/2:(oh-ih)/2:color=black';
    }
  }

  if (aspectRatio === '4:5') {
    if (isCrop) {
      if (cropPosition === 'left') {
        return 'crop=trunc(ih*(4/5)/2)*2:ih:0:0';
      } else if (cropPosition === 'right') {
        return 'crop=trunc(ih*(4/5)/2)*2:ih:iw-trunc(ih*(4/5)/2)*2:0';
      } else {
        return 'crop=trunc(ih*(4/5)/2)*2:ih:(iw-trunc(ih*(4/5)/2)*2)/2:0';
      }
    } else {
      return 'pad=ceil(max(iw\\,ih*4/5)/2)*2:ceil(max(ih\\,iw*5/4)/2)*2:(ow-iw)/2:(oh-ih)/2:color=black';
    }
  }

  return '';
}

/**
 * Generates an end-to-end PowerShell workflow for cropping:
 * 1. Executes base yt-dlp download to an intermediate raw video file.
 * 2. Runs FFmpeg with pixel-perfect aspect ratio crop/pad filter.
 * 3. Deletes the intermediate raw video so ONLY the cropped video remains.
 */
export function buildCropWorkflow(
  baseYtDlpCmd: string,
  options: VideoCropOptions
): CropPipelineResult {
  const {
    format = 'mp4',
    aspectRatio = '16:9',
    fitMode = 'pad',
    cropPosition = 'center',
    cropBox,
    customFileName,
  } = options;

  const isAudio = format === 'mp3' || format === 'wav' || format === 'm4a' || format === 'aac';
  const filterString = !isAudio ? getFFmpegAspectFilter(aspectRatio, fitMode, cropPosition, cropBox) : '';
  const isCroppingNeeded = !isAudio && Boolean(filterString);

  // Determine base sanitized name
  let safeBaseName = '%(title)s';
  if (customFileName && customFileName.trim()) {
    safeBaseName = customFileName.replace(/[<>:"/\\|?*]/g, '_').trim();
  }

  const finalOutputPath = `$env:USERPROFILE\\Downloads\\${safeBaseName}_clip.mp4`;
  const tempRawPath = `$env:USERPROFILE\\Downloads\\${safeBaseName}_raw_temp.mp4`;

  if (!isCroppingNeeded) {
    return {
      isCroppingNeeded: false,
      powerShellScript: baseYtDlpCmd,
      finalOutputPath,
      filterString: '',
    };
  }

  // Rewrite yt-dlp command to download to temporary raw file instead of final path
  const adjustedYtDlpCmd = baseYtDlpCmd.replace(
    /-o\s+"[^"]+"/,
    `-o "${tempRawPath}"`
  );

  // Step 2: FFmpeg crop/pad command
  const ffmpegCmd = `& "${FFMPEG_BIN}" -i "${tempRawPath}" -vf "${filterString}" -c:v libx264 -preset fast -crf 20 -c:a copy -y "${finalOutputPath}"`;

  // Step 3: Delete raw temp video
  const cleanupCmd = `Remove-Item -Path "${tempRawPath}" -Force -ErrorAction SilentlyContinue`;

  // Combined PowerShell workflow script
  const powerShellScript = [
    `# ClipFlow Video Aspect Pipeline (${aspectRatio} - ${fitMode})`,
    adjustedYtDlpCmd,
    `if ($LASTEXITCODE -eq 0) {`,
    `    Write-Host "Framing video to ${aspectRatio}..." -ForegroundColor Cyan`,
    `    ${ffmpegCmd}`,
    `    if ($LASTEXITCODE -eq 0) {`,
    `        ${cleanupCmd}`,
    `        Write-Host "Success! Saved to ${finalOutputPath}" -ForegroundColor Green`,
    `    }`,
    `}`,
  ].join('\r\n');

  return {
    isCroppingNeeded: true,
    powerShellScript,
    tempRawPath,
    finalOutputPath,
    ffmpegCmd,
    filterString,
  };
}

/**
 * Node-side video cropper (for cloud / server jobs).
 */
export async function cropVideoFile(params: {
  inputPath: string;
  outputPath: string;
  aspectRatio: string;
  fitMode?: 'crop' | 'pad';
  cropPosition?: 'left' | 'center' | 'right';
  cropBox?: CropBoxCoordinates;
}): Promise<string> {
  const { inputPath, outputPath, aspectRatio, fitMode = 'pad', cropPosition = 'center', cropBox } = params;
  const filter = getFFmpegAspectFilter(aspectRatio, fitMode, cropPosition, cropBox);

  if (!filter) {
    throw new Error(`Invalid or unsupported aspect ratio: ${aspectRatio}`);
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input video not found: ${inputPath}`);
  }

  const cmd = `"${FFMPEG_BIN}" -i "${inputPath}" -vf "${filter}" -c:v libx264 -preset fast -crf 20 -c:a aac -y "${outputPath}"`;
  console.log(`[VideoCrop] Executing: ${cmd}`);

  await execAsync(cmd);

  // Delete intermediate original file
  if (fs.existsSync(inputPath) && inputPath !== outputPath) {
    try {
      fs.unlinkSync(inputPath);
      console.log(`[VideoCrop] Deleted intermediate video: ${inputPath}`);
    } catch (e: any) {
      console.warn(`[VideoCrop] Could not delete temp file:`, e.message);
    }
  }

  return outputPath;
}
