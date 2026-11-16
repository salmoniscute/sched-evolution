// 代替 kernel rbtree（cfs_rq->tasks_timeline）的有序陣列。
//
// 排序結果和 rbtree 相同：kernel 的 __enqueue_entity 遇到相同 key 時往右走
// （"Nodes with the same key stay together"），這裡也插在相同 key 之後。
// 成本以 rbtree 的走訪深度 ⌈log2(n+1)⌉ 計入 rq.ops，而不是陣列搬移的成本。

export class Timeline<T> {
  private readonly items: T[] = [];

  /** less(a, b) 為 true 表示 a 應排在 b 左邊 */
  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  /** rbtree 一次插入 / 刪除的成本模型 */
  depth(): number {
    return Math.ceil(Math.log2(this.items.length + 1));
  }

  insert(x: T): void {
    // 二分搜尋：找第一個「x 應排在它左邊」的位置
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.less(x, this.items[mid]!)) hi = mid;
      else lo = mid + 1;
    }
    this.items.splice(lo, 0, x);
  }

  remove(x: T): void {
    const i = this.items.indexOf(x);
    if (i < 0) throw new Error('Timeline.remove: entity not in tree');
    this.items.splice(i, 1);
  }

  /** rb_leftmost */
  first(): T | undefined {
    return this.items[0];
  }

  /** __pick_last_entity */
  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** 由左到右（給視覺化與 O(n) 掃描用） */
  toArray(): readonly T[] {
    return this.items;
  }
}
