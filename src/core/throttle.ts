export class ReplyThrottle {
  private readonly hits = new Map<string, number[]>();

  /**
   * Окно параметром: тот же счётчик обслуживает и ответы боту (минута),
   * и попытки входа (пятнадцать минут). Две почти одинаковые реализации
   * разошлись бы при первой же правке.
   */
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(contactKey: string, now: Date): boolean {
    const cutoff = now.getTime() - this.windowMs;
    const recent = (this.hits.get(contactKey) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.maxPerWindow) {
      this.hits.set(contactKey, recent);
      return false;
    }
    recent.push(now.getTime());
    this.hits.set(contactKey, recent);
    return true;
  }
}
