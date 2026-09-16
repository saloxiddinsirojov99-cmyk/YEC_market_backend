import { Injectable } from '@nestjs/common';

@Injectable()
export class CacheService {
  private readonly store = new Map<string, { value: any; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const cached = this.store.get(key);
    if (!cached) return null;
    if (Date.now() > cached.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return cached.value as T;
  }

  async set(key: string, value: any, ttlSeconds = 300): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async invalidate(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}
