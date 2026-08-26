const MEET_URL_PATTERN = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/i;

export function extractMeetingCode(url: string): string | null {
  const match = MEET_URL_PATTERN.exec(url);
  const code = match?.[1];
  return code ? code.toLowerCase() : null;
}

export function isMeetUrl(url: string): boolean {
  return url.startsWith('https://meet.google.com/');
}
