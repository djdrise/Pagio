// Очередь отрисовки страниц.
//
// Без неё каждая попавшая в окно страница уходила бы в pdf.js немедленно: при
// быстрой прокрутке десяток задач стартует разом, воркер делит время между
// всеми, и пользователь ждёт, пока закончится последняя. Суммарной работы
// столько же, но видит он совсем другое.
//
// Глубина подобрана замером на прежнем проекте: время страницы почти целиком
// уходит на поход в воркер, а не на счёт, поэтому несколько задач разом идут
// почти без помех друг другу. Дальше четырёх выигрыша нет, зато первая
// страница начинает ждать.
//
// Приоритет позволяет рисовать сперва то, на что человек смотрит: страницу под
// курсором раньше, чем миниатюру на краю панели.

export class RenderQueue {
  /** @param {number} limit сколько задач выполняется одновременно */
  constructor(limit = 1) {
    this.limit = limit;
    this.pending = [];
    this.active = new Set();
    this.seq = 0;
  }

  /**
   * Ставит задачу в очередь.
   * @param {(signal: AbortSignal) => Promise<void>} job
   * @param {{priority?: number}} [opts] больший приоритет уходит в работу раньше
   * @returns {() => void} отмена: снимает задачу из очереди или прерывает начатую
   */
  add(job, { priority = 0 } = {}) {
    const item = { job, priority, seq: this.seq++, ctrl: new AbortController() };
    this.pending.push(item);
    this._pump();
    return () => {
      item.ctrl.abort();
      const i = this.pending.indexOf(item);
      if (i !== -1) this.pending.splice(i, 1);
    };
  }

  /** Снимает всё, что не начато, и прерывает то, что уже идёт. */
  cancelAll() {
    for (const item of this.pending) item.ctrl.abort();
    this.pending.length = 0;
    for (const item of this.active) item.ctrl.abort();
  }

  _pump() {
    while (this.active.size < this.limit && this.pending.length) {
      const item = this.pending.splice(this._next(), 1)[0];
      if (item.ctrl.signal.aborted) continue;
      this.active.add(item);
      Promise.resolve()
        .then(() => item.job(item.ctrl.signal))
        .catch(() => {
          // Отменённая или сломанная страница не должна ронять очередь:
          // остальные миниатюры обязаны дорисоваться.
        })
        .then(() => {
          this.active.delete(item);
          this._pump();
        });
    }
  }

  /** Индекс следующей задачи: сначала приоритет, при равном — кто раньше встал. */
  _next() {
    let best = 0;
    for (let i = 1; i < this.pending.length; i++) {
      const a = this.pending[i];
      const b = this.pending[best];
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    return best;
  }
}
