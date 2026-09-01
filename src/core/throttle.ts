export class ReplyThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly maxPerMinute: number) {}

  allow(contactKey: string, now: Date): boolean {
    const cutoff = now.getTime() - 60_000;
    const recent = (this.hits.get(contactKey) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.maxPerMinute) {
      this.hits.set(contactKey, recent);
      return false;
    }
    recent.push(now.getTime());
    this.hits.set(contactKey, recent);
    return true;
  }
}
