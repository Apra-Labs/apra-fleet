import { describe, it, expect, beforeEach } from 'vitest';
import { LRUCache } from '../src/utils/lru-cache.js';

// ── construction ─────────────────────────────────────────────────────────────

describe('LRUCache — construction', () => {
  it('creates a cache with the given capacity', () => {
    const cache = new LRUCache<string, number>(5);
    expect(cache.capacity).toBe(5);
    expect(cache.size).toBe(0);
  });

  it('throws RangeError for zero capacity', () => {
    expect(() => new LRUCache(0)).toThrow(RangeError);
  });

  it('throws RangeError for negative capacity', () => {
    expect(() => new LRUCache(-1)).toThrow(RangeError);
  });

  it('throws RangeError for fractional capacity', () => {
    expect(() => new LRUCache(1.5)).toThrow(RangeError);
  });

  it('allows capacity of 1', () => {
    const cache = new LRUCache<string, number>(1);
    expect(cache.capacity).toBe(1);
  });
});

// ── get / put basics ─────────────────────────────────────────────────────────

describe('LRUCache — get and put', () => {
  let cache: LRUCache<string, number>;

  beforeEach(() => {
    cache = new LRUCache<string, number>(3);
  });

  it('returns undefined for a missing key', () => {
    expect(cache.get('x')).toBeUndefined();
  });

  it('stores and retrieves a value', () => {
    cache.put('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('updates an existing key', () => {
    cache.put('a', 1);
    cache.put('a', 99);
    expect(cache.get('a')).toBe(99);
    expect(cache.size).toBe(1);
  });

  it('stores multiple keys independently', () => {
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('size reflects number of entries', () => {
    expect(cache.size).toBe(0);
    cache.put('a', 1);
    expect(cache.size).toBe(1);
    cache.put('b', 2);
    expect(cache.size).toBe(2);
  });

  it('size does not exceed capacity after eviction', () => {
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    cache.put('d', 4); // evicts 'a'
    expect(cache.size).toBe(3);
  });
});

// ── eviction ─────────────────────────────────────────────────────────────────

describe('LRUCache — LRU eviction', () => {
  it('evicts the least-recently-used entry when full', () => {
    const cache = new LRUCache<string, number>(3);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    // 'a' is LRU; adding 'd' should evict it
    cache.put('d', 4);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('a get() promotes the entry, preventing its eviction', () => {
    const cache = new LRUCache<string, number>(3);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    cache.get('a'); // 'a' becomes MRU; 'b' is now LRU
    cache.put('d', 4); // should evict 'b'
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('a put() update promotes the entry, preventing its eviction', () => {
    const cache = new LRUCache<string, number>(3);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    cache.put('a', 10); // update 'a' → MRU; 'b' is now LRU
    cache.put('d', 4);  // should evict 'b'
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('handles eviction with capacity 1', () => {
    const cache = new LRUCache<string, number>(1);
    cache.put('a', 1);
    cache.put('b', 2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  it('evicts correctly after many sequential inserts', () => {
    const cache = new LRUCache<number, number>(3);
    for (let i = 0; i < 10; i++) cache.put(i, i * 10);
    // Only the last 3 inserts should remain: 7, 8, 9
    for (let i = 0; i < 7; i++) expect(cache.get(i)).toBeUndefined();
    expect(cache.get(7)).toBe(70);
    expect(cache.get(8)).toBe(80);
    expect(cache.get(9)).toBe(90);
  });

  it('evicts the correct entry after an interleaved access pattern', () => {
    const cache = new LRUCache<string, number>(3);
    cache.put('a', 1); // order: a
    cache.put('b', 2); // order: b a
    cache.put('c', 3); // order: c b a
    cache.get('a');    // order: a c b  — 'b' is LRU
    cache.get('c');    // order: c a b  — 'b' is still LRU
    cache.put('d', 4); // evicts 'b'
    expect(cache.has('b')).toBe(false);
    expect(cache.size).toBe(3);
  });
});

// ── has / peek / delete ───────────────────────────────────────────────────────

describe('LRUCache — has, peek, delete', () => {
  let cache: LRUCache<string, string>;

  beforeEach(() => {
    cache = new LRUCache<string, string>(3);
    cache.put('x', 'alpha');
    cache.put('y', 'beta');
  });

  it('has() returns true for existing keys', () => {
    expect(cache.has('x')).toBe(true);
    expect(cache.has('y')).toBe(true);
  });

  it('has() returns false for missing keys', () => {
    expect(cache.has('z')).toBe(false);
  });

  it('peek() returns the value without altering order', () => {
    cache.put('z', 'gamma'); // order: z y x — 'x' is LRU
    expect(cache.peek('x')).toBe('alpha'); // should NOT promote 'x'
    cache.put('w', 'delta'); // should evict 'x' (still LRU)
    expect(cache.has('x')).toBe(false);
  });

  it('peek() returns undefined for missing keys', () => {
    expect(cache.peek('missing')).toBeUndefined();
  });

  it('delete() removes an existing entry and returns true', () => {
    expect(cache.delete('x')).toBe(true);
    expect(cache.has('x')).toBe(false);
    expect(cache.size).toBe(1);
  });

  it('delete() returns false for a missing key', () => {
    expect(cache.delete('nope')).toBe(false);
  });

  it('delete() on the LRU entry does not corrupt eviction order', () => {
    cache.put('z', 'gamma'); // order: z y x — 'x' is LRU
    cache.delete('x');
    // 'y' is now LRU; adding two new entries should evict 'y', then 'z'
    cache.put('a', 'A'); // order: a z y
    cache.put('b', 'B'); // order: b a z y — over capacity → evict 'y'
    expect(cache.has('y')).toBe(false);
    expect(cache.has('z')).toBe(true);
  });

  it('delete() on the MRU entry does not corrupt eviction order', () => {
    cache.put('z', 'gamma'); // order: z y x — 'z' is MRU
    cache.delete('z');       // size drops to 2/3; order: y x — 'x' is LRU
    cache.put('a', 'A');     // size 3/3, no eviction; order: a y x
    cache.put('b', 'B');     // at capacity → evicts 'x' (LRU); order: b a y
    expect(cache.has('x')).toBe(false);
    expect(cache.has('y')).toBe(true);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
  });
});

// ── clear ────────────────────────────────────────────────────────────────────

describe('LRUCache — clear', () => {
  it('empties the cache', () => {
    const cache = new LRUCache<string, number>(3);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(false);
  });

  it('can accept new entries after clear', () => {
    const cache = new LRUCache<string, number>(2);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.clear();
    cache.put('c', 3);
    cache.put('d', 4);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(2);
  });
});

// ── iteration ─────────────────────────────────────────────────────────────────

describe('LRUCache — iteration', () => {
  let cache: LRUCache<string, number>;

  beforeEach(() => {
    cache = new LRUCache<string, number>(4);
    cache.put('a', 1);
    cache.put('b', 2);
    cache.put('c', 3);
    cache.get('a'); // MRU order now: a c b
  });

  it('entries() yields [key, value] pairs in MRU→LRU order', () => {
    expect([...cache.entries()]).toEqual([['a', 1], ['c', 3], ['b', 2]]);
  });

  it('keys() yields keys in MRU→LRU order', () => {
    expect([...cache.keys()]).toEqual(['a', 'c', 'b']);
  });

  it('values() yields values in MRU→LRU order', () => {
    expect([...cache.values()]).toEqual([1, 3, 2]);
  });

  it('[Symbol.iterator] yields [key, value] pairs in MRU→LRU order', () => {
    expect([...cache]).toEqual([['a', 1], ['c', 3], ['b', 2]]);
  });

  it('iterating an empty cache yields nothing', () => {
    const empty = new LRUCache<string, number>(3);
    expect([...empty.entries()]).toEqual([]);
  });
});

// ── generic types ─────────────────────────────────────────────────────────────

describe('LRUCache — generic key and value types', () => {
  it('works with numeric keys', () => {
    const cache = new LRUCache<number, string>(2);
    cache.put(1, 'one');
    cache.put(2, 'two');
    expect(cache.get(1)).toBe('one');
    expect(cache.get(2)).toBe('two');
  });

  it('works with object values', () => {
    type User = { name: string; age: number };
    const cache = new LRUCache<string, User>(2);
    const user = { name: 'Alice', age: 30 };
    cache.put('u1', user);
    expect(cache.get('u1')).toStrictEqual(user);
  });

  it('works with symbol keys', () => {
    const k1 = Symbol('k1');
    const k2 = Symbol('k2');
    const cache = new LRUCache<symbol, number>(2);
    cache.put(k1, 100);
    cache.put(k2, 200);
    expect(cache.get(k1)).toBe(100);
    expect(cache.get(k2)).toBe(200);
  });

  it('treats distinct object-key references as different keys', () => {
    const cache = new LRUCache<object, string>(2);
    const obj1 = { id: 1 };
    const obj2 = { id: 1 }; // same shape, different reference
    cache.put(obj1, 'first');
    cache.put(obj2, 'second');
    expect(cache.get(obj1)).toBe('first');
    expect(cache.get(obj2)).toBe('second');
    expect(cache.size).toBe(2);
  });
});

// ── stress / edge-case ────────────────────────────────────────────────────────

describe('LRUCache — stress and edge cases', () => {
  it('handles repeated put/get of the same key without growing', () => {
    const cache = new LRUCache<string, number>(3);
    for (let i = 0; i < 1000; i++) {
      cache.put('only', i);
      expect(cache.get('only')).toBe(i);
    }
    expect(cache.size).toBe(1);
  });

  it('handles interleaved put and delete at capacity boundary', () => {
    const cache = new LRUCache<number, number>(3);
    cache.put(1, 1);
    cache.put(2, 2);
    cache.put(3, 3);
    cache.delete(2);
    cache.put(4, 4);
    cache.put(5, 5); // evicts 1 (LRU after deleting 2)
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(false);
    expect(cache.has(3)).toBe(true);
    expect(cache.has(4)).toBe(true);
    expect(cache.has(5)).toBe(true);
  });

  it('correctly survives a clear followed by full re-fill', () => {
    const cache = new LRUCache<number, number>(3);
    cache.put(1, 10); cache.put(2, 20); cache.put(3, 30);
    cache.clear();
    cache.put(4, 40); cache.put(5, 50); cache.put(6, 60);
    cache.put(7, 70); // evicts 4
    expect(cache.has(4)).toBe(false);
    expect(cache.get(5)).toBe(50);
    expect(cache.get(6)).toBe(60);
    expect(cache.get(7)).toBe(70);
  });

  it('correctly handles capacity-1 through repeated single-entry churn', () => {
    const cache = new LRUCache<number, number>(1);
    for (let i = 0; i < 100; i++) {
      cache.put(i, i);
      expect(cache.get(i)).toBe(i);
      expect(cache.size).toBe(1);
    }
  });

  it('MRU→LRU order is maintained after a long access sequence', () => {
    const cache = new LRUCache<number, number>(5);
    for (let i = 1; i <= 5; i++) cache.put(i, i);
    // access in reverse order: 5 4 3 2 1 → MRU order 1 2 3 4 5
    for (let i = 5; i >= 1; i--) cache.get(i);
    expect([...cache.keys()]).toEqual([1, 2, 3, 4, 5]);
  });
});
