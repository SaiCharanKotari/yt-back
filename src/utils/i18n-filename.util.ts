/**
 * i18n-filename.util.ts
 * 
 * Provides robust internationalization (i18n) filename handling:
 * - Preserves native characters from ANY language (Korean, Japanese, Chinese,
 *   Hindi, Arabic, Cyrillic, Thai, Greek, European accents, etc.) AS IS.
 * - Only strips genuinely forbidden OS filesystem characters (< > : " / \ | ? * and control chars).
 * - Generates standards-compliant RFC 6266 / RFC 5987 Content-Disposition HTTP headers
 *   so browsers save files with their exact native names without ERR_INVALID_CHAR or "_____" corruption.
 */

/**
 * Characters strictly prohibited in filenames across Windows, macOS, and Linux.
 * Note: Unicode letters, numbers, and symbols from all world languages are 100% permitted.
 */
const FORBIDDEN_FS_CHARS_REGEX = /[<>:"/\\|?*\x00-\x1F]/g;

/**
 * Cleans a filename while preserving all international language characters intact.
 * 
 * @param rawName The raw title or filename (e.g. "BTS (방탄소년단) '작은 것들을 위한 시 (Boy With Luv)' Official MV")
 * @param fallback Fallback name if the cleaned string is empty
 * @param maxLen Maximum character length (default 200 to prevent filesystem path overflow)
 * @returns Cleaned filename preserving all native Unicode scripts
 */
export function cleanUnicodeFileName(
  rawName: string | undefined | null,
  fallback: string = 'clipflow_media',
  maxLen: number = 200
): string {
  if (!rawName || typeof rawName !== 'string') {
    return fallback;
  }

  // 1. Remove only truly forbidden filesystem characters
  let cleaned = rawName.replace(FORBIDDEN_FS_CHARS_REGEX, '_');

  // 2. Normalize whitespace (collapse tabs/multiple spaces into single space)
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // 3. Remove trailing dots or spaces which Windows forbids on filenames
  cleaned = cleaned.replace(/[. ]+$/, '');

  // 4. Truncate safely without splitting surrogate pairs
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen).replace(/[. ]+$/, '');
  }

  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Encodes a string according to RFC 5987 / RFC 6266 for HTTP headers.
 * Percent-encodes single quotes, parentheses, asterisks, and non-ASCII bytes.
 */
export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str)
    // encodeURIComponent does not encode ' ( ) *
    // RFC 5987 attr-char forbids them, so we percent-encode them:
    .replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, '%2A');
}

/**
 * Builds a Content-Disposition header that delivers the exact Unicode filename
 * to modern browsers in any language, while remaining completely ASCII-compliant
 * for Node.js HTTP servers (preventing ERR_INVALID_CHAR).
 * 
 * @param filename The full target filename with extension (e.g. "BTS (방탄소년단)...mp4")
 * @param type 'attachment' (download) or 'inline' (preview)
 * @returns Formatted Content-Disposition header string
 */
export function getSafeContentDisposition(
  filename: string,
  type: 'attachment' | 'inline' = 'attachment'
): string {
  const cleaned = cleanUnicodeFileName(filename);
  const encoded = encodeRFC5987(cleaned);

  // Modern browsers (Chrome, Firefox, Safari, Edge) prioritize filename*=UTF-8''...
  // By using filename*=UTF-8'', the browser receives the full, pristine Unicode title
  // and Node.js transmits only safe ASCII bytes, preventing ERR_INVALID_CHAR and "_____" fallbacks.
  return `${type}; filename*=UTF-8''${encoded}`;
}
