const EMOJI_ONLY_RE = /^[\p{Emoji}\s]+$/u;

export class NoiseFilter {
  private patterns: Set<string>;

  constructor(patterns: string[]) {
    this.patterns = new Set(patterns.map((p) => p.toLowerCase().trim()));
  }

  shouldProcess(message: string): boolean {
    const trimmed = message.trim();

    if (trimmed.length === 0) return false;

    // Too short to contain meaningful knowledge
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 5) return false;

    // Emoji-only
    if (EMOJI_ONLY_RE.test(trimmed)) return false;

    // Matches a known noise pattern
    if (this.patterns.has(trimmed.toLowerCase())) return false;

    return true;
  }
}
