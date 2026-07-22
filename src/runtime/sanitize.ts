const AUTHORIZATION_PATTERN =
  /\b(?:Authorization|Proxy-Authorization)(?:"\s*)?(?::|=)?\s*(?:"\s*)?(?:Bearer|Basic)?\s*[^"',;\s}]+/gi;
const API_KEY_PATTERN =
  /\b(?:api[_-]?key|x-api-key)(?:"\s*)?(?::|=)\s*(?:"\s*)?[^"',;\s}]+/gi;
const SK_KEY_PATTERN = /\bsk-[a-zA-Z0-9_-]{5,}\b/g;
const URL_PATTERN = /https?:\/\/[^\s]+/g;

export function sanitizeSensitiveText(text: string, maxLength = 2_000): string {
  return text
    .replace(URL_PATTERN, "[URL]")
    .replace(AUTHORIZATION_PATTERN, "[AUTH_HEADER]")
    .replace(API_KEY_PATTERN, "[API_KEY]")
    .replace(SK_KEY_PATTERN, "[API_KEY]")
    .slice(0, maxLength);
}

export function sanitizeToolResult(result: unknown, maxLength = 2_000): string {
  if (typeof result === "string") return sanitizeSensitiveText(result, maxLength);

  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(result, (_key, value: unknown) => {
      if (typeof value !== "object" || value === null) return value;
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      return value;
    });
  } catch {
    serialized = String(result);
  }
  return sanitizeSensitiveText(serialized ?? String(result), maxLength);
}
