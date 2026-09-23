// Готовые миниатюры в памяти, чтобы не рисовать одно и то же дважды.
//
// Боковую панель закрывают и открывают, по документу ходят вверх-вниз, и каждый
// раз перерисовывать одни и те же страницы незачем.
//
// Память считаем честно: канва 180 px при удвоенной плотности занимает около
// полумегабайта, и на документе в тысячу страниц хранить всё подряд нельзя.
// Поэтому у хранилища есть бюджет в байтах, а вытесняются те миниатюры, к
// которым дольше всего не обращались.

/** Сколько байт канвы держим в памяти: хватает на несколько сотен миниатюр
 *  боковой панели. */
const BUDGET = 64 * 1024 * 1024;

const bytesOf = (canvas) => canvas.width * canvas.height * 4;

export class ThumbStore {
  constructor(budget = BUDGET) {
    this.budget = budget;
    /** @type {Map<string, {canvas: HTMLCanvasElement, bytes: number, docId: number}>} */
    this.items = new Map(); // порядок вставки = порядок обращения, см. get()
    this.bytes = 0;
  }

  static key(docId, width, page) {
    return `${docId}:${width}:${page}`;
  }

  get(docId, width, page) {
    const key = ThumbStore.key(docId, width, page);
    const item = this.items.get(key);
    if (!item) return null;
    // Перекладываем в конец: Map хранит порядок вставки, и удаление со вставкой
    // делает из него список «давно не трогали → трогали только что».
    this.items.delete(key);
    this.items.set(key, item);
    return item.canvas;
  }

  put(docId, width, page, canvas) {
    const key = ThumbStore.key(docId, width, page);
    const prev = this.items.get(key);
    if (prev) this.bytes -= prev.bytes;
    const bytes = bytesOf(canvas);
    this.items.set(key, { canvas, bytes, docId });
    this.bytes += bytes;
    this._evict();
  }

  /** Документ закрыли — его миниатюры больше не нужны. */
  dropDoc(docId) {
    for (const [key, item] of this.items) {
      if (item.docId !== docId) continue;
      this.items.delete(key);
      this.bytes -= item.bytes;
    }
  }

  _evict() {
    for (const [key, item] of this.items) {
      if (this.bytes <= this.budget) return;
      this.items.delete(key);
      this.bytes -= item.bytes;
    }
  }
}
