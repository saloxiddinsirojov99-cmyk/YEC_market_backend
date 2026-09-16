import { Injectable } from '@nestjs/common';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class CacheService {
  private cache = new Map<string, CacheEntry<any>>();

  /**
   * Cache'dan kalit bo'yicha qiymatni olish.
   * Agar cache muddati o'tgan bo'lsa, null qaytaradi va cache'dan o'chiradi.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value as T;
  }

  /**
   * Cache'ga kalit bo'yicha qiymat yozish.
   * @param key kesh kaliti
   * @param value kesh qiymati
   * @param ttlSeconds yashash muddati (sekundda)
   */
  set<T>(key: string, value: T, ttlSeconds: number): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { value, expiresAt });
  }

  /**
   * Cache'dan kalit bo'yicha o'chirish.
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Barcha keshni tozalash.
   */
  clear(): void {
    this.cache.clear();
  }
}
