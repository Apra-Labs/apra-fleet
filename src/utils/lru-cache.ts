/**
 * A doubly-linked list node used internally by {@link LRUCache}.
 * @internal
 */
interface Node<K, V> {
  key: K;
  value: V;
  prev: Node<K, V> | null;
  next: Node<K, V> | null;
}

/**
 * A generic Least-Recently-Used (LRU) cache with O(1) `get` and `put`.
 *
 * Internally it combines a `Map` (for O(1) key lookup) with a doubly-linked
 * list (for O(1) eviction of the least-recently-used entry).  The head of the
 * list is always the most-recently-used entry; the tail is the LRU candidate.
 *
 * @typeParam K - Key type (must be usable as a `Map` key).
 * @typeParam V - Value type.
 *
 * @example
 * ```ts
 * const cache = new LRUCache<string, number>(3);
 * cache.put('a', 1);
 * cache.put('b', 2);
 * cache.put('c', 3);
 * cache.get('a');      // 1  — 'a' is now MRU
 * cache.put('d', 4);  // evicts 'b' (LRU)
 * cache.has('b');      // false
 * ```
 */
export class LRUCache<K, V> {
  /** Maximum number of entries the cache can hold before evicting. */
  readonly capacity: number;

  /** Current number of entries in the cache. */
  get size(): number {
    return this._map.size;
  }

  private readonly _map: Map<K, Node<K, V>>;
  /** Sentinel head — the node after head is the MRU entry. */
  private readonly _head: Node<K, V>;
  /** Sentinel tail — the node before tail is the LRU entry. */
  private readonly _tail: Node<K, V>;

  /**
   * Create a new LRU cache.
   *
   * @param capacity - Maximum number of entries to hold.  Must be a positive
   *   integer.
   * @throws {RangeError} If `capacity` is not a positive integer.
   */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`LRUCache capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this._map = new Map();
    this._head = { key: null as unknown as K, value: null as unknown as V, prev: null, next: null };
    this._tail = { key: null as unknown as K, value: null as unknown as V, prev: null, next: null };
    this._head.next = this._tail;
    this._tail.prev = this._head;
  }

  /**
   * Retrieve the value associated with `key`, or `undefined` if the key is
   * not present.  Accessing an entry promotes it to most-recently-used.
   *
   * @param key - The key to look up.
   * @returns The cached value, or `undefined`.
   */
  get(key: K): V | undefined {
    const node = this._map.get(key);
    if (!node) return undefined;
    this._moveToFront(node);
    return node.value;
  }

  /**
   * Store `value` under `key`.  If the key already exists its value is
   * updated and the entry is promoted to most-recently-used.  If adding a
   * new entry would exceed `capacity`, the least-recently-used entry is
   * evicted first.
   *
   * @param key   - The key under which to store the value.
   * @param value - The value to store.
   */
  put(key: K, value: V): void {
    const existing = this._map.get(key);
    if (existing) {
      existing.value = value;
      this._moveToFront(existing);
      return;
    }

    if (this._map.size === this.capacity) {
      this._evictLRU();
    }

    const node: Node<K, V> = { key, value, prev: null, next: null };
    this._map.set(key, node);
    this._insertAtFront(node);
  }

  /**
   * Remove the entry associated with `key`.
   *
   * @param key - The key to remove.
   * @returns `true` if an entry was removed, `false` if the key was not
   *   present.
   */
  delete(key: K): boolean {
    const node = this._map.get(key);
    if (!node) return false;
    this._removeNode(node);
    this._map.delete(key);
    return true;
  }

  /**
   * Check whether `key` is present in the cache **without** affecting
   * recency order.
   *
   * @param key - The key to test.
   * @returns `true` if the key exists, `false` otherwise.
   */
  has(key: K): boolean {
    return this._map.has(key);
  }

  /**
   * Return the value for `key` **without** updating recency order.  Useful
   * for non-destructive inspection.
   *
   * @param key - The key to peek at.
   * @returns The cached value, or `undefined`.
   */
  peek(key: K): V | undefined {
    return this._map.get(key)?.value;
  }

  /**
   * Remove all entries from the cache.
   */
  clear(): void {
    this._map.clear();
    this._head.next = this._tail;
    this._tail.prev = this._head;
  }

  /**
   * Return an iterator over `[key, value]` pairs in MRU→LRU order (most
   * recently used first).
   *
   * @example
   * ```ts
   * for (const [k, v] of cache.entries()) { … }
   * ```
   */
  *entries(): IterableIterator<[K, V]> {
    let node = this._head.next!;
    while (node !== this._tail) {
      yield [node.key, node.value];
      node = node.next!;
    }
  }

  /**
   * Return an iterator over keys in MRU→LRU order.
   */
  *keys(): IterableIterator<K> {
    for (const [k] of this.entries()) yield k;
  }

  /**
   * Return an iterator over values in MRU→LRU order.
   */
  *values(): IterableIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }

  /**
   * Allow the cache to be iterated with `for…of`, yielding `[key, value]`
   * pairs in MRU→LRU order.
   */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  // ── private helpers ────────────────────────────────────────────────────────

  /** Detach `node` from its current position in the list. */
  private _removeNode(node: Node<K, V>): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
    node.prev = null;
    node.next = null;
  }

  /** Insert `node` immediately after the sentinel head (MRU position). */
  private _insertAtFront(node: Node<K, V>): void {
    node.next = this._head.next;
    node.prev = this._head;
    this._head.next!.prev = node;
    this._head.next = node;
  }

  /** Move an existing `node` to the MRU position. */
  private _moveToFront(node: Node<K, V>): void {
    this._removeNode(node);
    this._insertAtFront(node);
  }

  /** Remove the LRU entry (the node just before the sentinel tail). */
  private _evictLRU(): void {
    const lru = this._tail.prev!;
    this._removeNode(lru);
    this._map.delete(lru.key);
  }
}
