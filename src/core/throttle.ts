/**
 * Сколько ключей накопить, прежде чем убираться. Уборка обходит всю таблицу,
 * поэтому делать её на каждый вызов нельзя; порог же означает, что стоимость
 * обхода размазывается по тем самым вызовам, которые таблицу и раздули.
 */
const SWEEP_AT = 10_000;

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

  /** Сколько ключей сейчас в памяти. Нужно тесту уборки — снаружи ни на что не влияет. */
  get tracked(): number {
    return this.hits.size;
  }

  allow(contactKey: string, now: Date): boolean {
    const cutoff = now.getTime() - this.windowMs;
    const recent = (this.hits.get(contactKey) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.maxPerWindow) {
      this.hits.set(contactKey, recent);
      return false;
    }
    recent.push(now.getTime());
    this.hits.set(contactKey, recent);
    if (this.hits.size > SWEEP_AT) this.sweep(cutoff);
    return true;
  }

  /**
   * Ключи приходят снаружи — присланная почта на входе, идентификатор
   * комментатора у бота, — и без уборки таблица росла бы, пока жив процесс:
   * каждая когда-либо увиденная почта оставалась бы в памяти навсегда.
   *
   * Удаляются только ключи с закрытым окном: их счёт всё равно пуст, и запись
   * о них ничего не решает. Ключ внутри окна уборка не трогает — иначе она
   * обнуляла бы действующий лимит, то есть снимала бы защиту.
   */
  private sweep(cutoff: number): void {
    for (const [key, times] of this.hits) {
      const last = times[times.length - 1];
      if (last === undefined || last <= cutoff) this.hits.delete(key);
    }
  }
}
