import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { CarpetInventoryStatus, OrderStatus } from '@prisma/client';

export interface SearchCarpetItem {
  id: string;
  uniqueCode: string;
  name: string;
  normalizedName: string;
  patternCode: string;
  normalizedPatternCode: string;
  designCode: string | null;
  normalizedDesignCode: string | null;
  description: string | null;
  normalizedDescription: string | null;
  material: string;
  normalizedMaterial: string;
  price: number;
  discountPercent: number;
  images: string[];
  categoryId: string | null;
  categoryName: string;
  normalizedCategoryName: string;
  brand: string | null;
  normalizedBrand: string | null;
  priceSegment: string | null;
  type: string;
  shape: string;
  createdAt: Date;
  likes: number;
  sizes: {
    widthCm: number;
    lengthCm: number;
    sizeStr: string;
    stock: number;
  }[];
}

export interface ExtractedSize {
  widthCm: number;
  lengthCm: number;
  originalText: string;
}

export interface SearchQueryAttributes {
  sizes: ExtractedSize[];
  colors: string[];
  shapes: string[];
  categories: string[];
  materials: string[];
  brands: string[];
  isPremium: boolean;
  textTokens: string[];
}

export interface SearchResult {
  carpet: SearchCarpetItem;
  score: number;
}

export interface SearchOptions {
  categoryId?: string;
  shape?: string;
  size?: string;
  minPrice?: number;
  maxPrice?: number;
  material?: string;
  onlyAvailable?: boolean;
  onlyPromo?: boolean;
  onlyNew?: boolean;
  page?: number;
  limit?: number;
}

// Utility: Normalize text to support Uzbek letters, remove extra spacing and symbols
export function normalizeText(text: string): string {
  if (!text) return '';
  let normalized = text.normalize('NFKC').toLowerCase();

  // Cyrillic to Latin transliteration
  const cyrillicToLatin: { [key: string]: string } = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'yo',
    ж: 'j',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'x',
    ц: 'ts',
    ч: 'ch',
    š: 'sh',
    ш: 'sh',
    щ: 'sh',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
    ғ: 'g',
    қ: 'q',
    ҳ: 'h',
    ў: 'o',
  };

  normalized = normalized
    .split('')
    .map((char) => cyrillicToLatin[char] || char)
    .join('');

  return normalized
    .replace(/[_-]/g, ' ')
    .replace(/[o‘'’`ʻ]/g, 'o')
    .replace(/[g‘'’`ʻ]/g, 'g')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Calculate Levenshtein Distance
export function getLevenshteinDistance(a: string, b: string): number {
  const tmp: number[][] = [];
  let i, j;
  for (i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1,
        tmp[i][j - 1] + 1,
        tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return tmp[a.length][b.length];
}

// Calculate Trigrams
export function getTrigrams(str: string): string[] {
  const s = '  ' + str + '  ';
  const trigrams: string[] = [];
  for (let i = 0; i < s.length - 2; i++) {
    trigrams.push(s.slice(i, i + 3));
  }
  return trigrams;
}

// Calculate Trigram Similarity
export function getTrigramSimilarity(a: string, b: string): number {
  const trigramsA = getTrigrams(a);
  const trigramsB = getTrigrams(b);
  if (trigramsA.length === 0 || trigramsB.length === 0) return 0;

  const setA = new Set(trigramsA);
  let intersection = 0;
  for (const t of trigramsB) {
    if (setA.has(t)) {
      intersection++;
    }
  }
  return (2 * intersection) / (trigramsA.length + trigramsB.length);
}

const SYNONYMS: { [key: string]: string[] } = {
  turk: ['turkiya', 'turkcha', 'turkic'],
  eron: ['iran', 'eroncha', 'iranian'],
  belgiya: ['belgium', 'belgiyacha'],
  oq: ['oq', 'white', 'beliy', 'cream', 'krem'],
  beige: ['bej', 'bejoviy', 'beige', 'cream', 'krem'],
  cream: ['krem', 'cream', 'kremli', 'beige', 'bej'],
  kok: ["ko'k", 'kok', 'siny', 'blue'],
  yashil: ['yashil', 'green', 'zeleniy'],
  qizil: ['qizil', 'red', 'krasniy'],
  qora: ['qora', 'black', 'cherniy'],
  kulrang: ['kulrang', 'grey', 'gray', 'seriy'],
  dumaloq: ['dumaloq', 'doira', 'aylana', 'krug', 'krugliy', 'circle'],
  oval: ['oval', 'ovalniy'],
  tortburchak: ["to'rtburchak", 'tortburchak', 'rectangle', 'pryamougolnik'],
  premium: ['premium', 'qimmat', 'lyuks', 'luxury', 'vip'],
  klassik: ['klassik', 'classic', 'klassika', 'traditional'],
  zamonaviy: ['zamonaviy', 'modern', 'moderncha', 'newstyle'],
  qalin: ['qalin', 'tolstiy', 'thick'],
  yumshoq: ['yumshoq', 'myagkiy', 'soft'],
};

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Periodically builds or gets the in-memory search index of carpets.
   */
  async buildSearchIndex(): Promise<SearchCarpetItem[]> {
    const cacheKey = 'search_carpet_index_v2';
    const cached = await this.cacheService.get<SearchCarpetItem[]>(cacheKey);
    if (cached) return cached;

    this.logger.log('Search index cache miss, loading carpets...');
    const carpets = await this.prisma.carpet.findMany({
      where: { isArchived: false },
      include: {
        category: true,
        inventoryItems: {
          where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
          select: {
            widthMm: true,
            lengthMm: true,
            size: true,
          },
        },
        rollInventories: {
          select: {
            widthCm: true,
            currentLengthCm: true,
          },
        },
      },
    });

    const indexItems: SearchCarpetItem[] = carpets.map((c) => {
      // Group unique sizes and calculate stock counts
      const sizeMap = new Map<
        string,
        { widthCm: number; lengthCm: number; sizeStr: string; stock: number }
      >();

      if (c.type === 'ROLL') {
        for (const roll of c.rollInventories) {
          const widthCm = roll.widthCm;
          const lengthCm = roll.currentLengthCm;
          const sizeStr = `${widthCm}x${lengthCm}`;
          sizeMap.set(sizeStr, {
            widthCm,
            lengthCm,
            sizeStr,
            stock: lengthCm > 0 ? 1 : 0,
          });
        }
      } else {
        for (const item of c.inventoryItems) {
          const widthCm = Math.round(item.widthMm / 10);
          const lengthCm = Math.round(item.lengthMm / 10);
          const sizeStr = `${widthCm}x${lengthCm}`;
          const existing = sizeMap.get(sizeStr);
          if (existing) {
            existing.stock++;
          } else {
            sizeMap.set(sizeStr, {
              widthCm,
              lengthCm,
              sizeStr,
              stock: 1,
            });
          }
        }
      }

      return {
        id: c.id,
        uniqueCode: c.uniqueCode,
        name: c.name,
        normalizedName: normalizeText(c.name),
        patternCode: c.patternCode,
        normalizedPatternCode: normalizeText(c.patternCode),
        designCode: c.designCode,
        normalizedDesignCode: c.designCode ? normalizeText(c.designCode) : null,
        description: c.description,
        normalizedDescription: c.description
          ? normalizeText(c.description)
          : null,
        material: c.material,
        normalizedMaterial: normalizeText(c.material),
        price: Number(c.price),
        discountPercent: c.discountPercent,
        images: c.images,
        categoryId: c.categoryId,
        categoryName: c.category?.name || '',
        normalizedCategoryName: c.category?.name
          ? normalizeText(c.category.name)
          : '',
        brand: c.brand,
        normalizedBrand: c.brand ? normalizeText(c.brand) : null,
        priceSegment: c.priceSegment,
        type: c.type,
        shape: c.shape,
        createdAt: c.createdAt,
        likes: c.likes,
        sizes: Array.from(sizeMap.values()),
      };
    });

    // Cache index for 5 minutes (300 seconds)
    await this.cacheService.set(cacheKey, indexItems, 300);
    this.logger.log(
      `Successfully built search index with ${indexItems.length} active carpets.`,
    );
    return indexItems;
  }

  /**
   * Corrects typos in the query using Levenshtein distance against known vocabulary terms.
   */
  async correctTypos(
    query: string,
    index: SearchCarpetItem[],
  ): Promise<{
    correctedQuery: string;
    corrections: { from: string; to: string }[];
  }> {
    const tokens = query.split(/\s+/).filter(Boolean);
    const corrections: { from: string; to: string }[] = [];

    // Extract all unique candidate terms from catalog
    const candidates = new Set<string>();
    for (const item of index) {
      if (item.name) {
        item.name.split(/\s+/).forEach((w) => candidates.add(normalizeText(w)));
      }
      if (item.designCode) {
        candidates.add(normalizeText(item.designCode));
      }
      if (item.categoryName) {
        item.categoryName
          .split(/\s+/)
          .forEach((w) => candidates.add(normalizeText(w)));
      }
      if (item.brand) {
        candidates.add(normalizeText(item.brand));
      }
    }

    const correctedTokens = tokens.map((token) => {
      const normToken = normalizeText(token);
      if (normToken.length < 3 || candidates.has(normToken)) {
        return token; // too short or already valid
      }

      // Check Levenshtein distance
      let bestCandidate = '';
      let minDistance = 3; // Must be < 3 (i.e. max 2 typos)
      for (const cand of candidates) {
        if (Math.abs(cand.length - normToken.length) > 2) continue;
        const dist = getLevenshteinDistance(normToken, cand);
        if (dist < minDistance) {
          minDistance = dist;
          bestCandidate = cand;
        }
      }

      if (bestCandidate && bestCandidate !== normToken) {
        corrections.push({ from: token, to: bestCandidate });
        return bestCandidate;
      }

      return token;
    });

    return {
      correctedQuery: correctedTokens.join(' '),
      corrections,
    };
  }

  /**
   * Extract sizes (e.g. 3ga 2, 2 ga 3, 3x2, 300x200, 200x30) from query
   */
  extractSizes(query: string): ExtractedSize[] {
    const results: ExtractedSize[] = [];
    const text = query.toLowerCase();

    // 1. Match patterns like "3ga 2", "3 ga 2", "2-ga 3", "2.5ga 3", "3x2", "3*2", "300x200", "200x30"
    const sizePattern =
      /(\d+(?:\.\d+)?)\s*(?:ga|-ga|x|\*|by|do|\s*x\s*|\s*\*\s*)\s*(\d+(?:\.\d+)?)/gi;
    let match;

    while ((match = sizePattern.exec(text)) !== null) {
      let w = parseFloat(match[1]);
      let l = parseFloat(match[2]);

      // If dimensions given in meters (e.g. 2, 3, 2.5, 4, 8)
      if (w < 15) w = Math.round(w * 100);
      if (l < 15) l = Math.round(l * 100);
      // Handle roll length in meters when width is given in cm (e.g. 200x30 -> 200cm x 30m = 3000cm)
      else if (w >= 50 && l < 50) l = Math.round(l * 100);

      results.push({
        widthCm: Math.round(w),
        lengthCm: Math.round(l),
        originalText: match[0],
      });
    }

    // 2. Match space separated pairs like "200 300" or "3 2" if not matched above
    if (results.length === 0) {
      const spacePattern = /\b(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\b/g;
      while ((match = spacePattern.exec(text)) !== null) {
        let w = parseFloat(match[1]);
        let l = parseFloat(match[2]);
        if (w < 15) w = Math.round(w * 100);
        if (l < 15) l = Math.round(l * 100);

        results.push({
          widthCm: Math.round(w),
          lengthCm: Math.round(l),
          originalText: match[0],
        });
      }
    }

    // 3. Single dimension roll/width query like "2 metr", "2m", "200cm", "2 metrlik"
    if (results.length === 0) {
      const singleMeterPattern =
        /\b(\d+(?:\.\d+)?)\s*(?:metr|metrlik|m|cm|sm)\b/gi;
      while ((match = singleMeterPattern.exec(text)) !== null) {
        let w = parseFloat(match[1]);
        if (w < 15) w = Math.round(w * 100);
        results.push({
          widthCm: Math.round(w),
          lengthCm: 0,
          originalText: match[0],
        });
      }
    }

    return results;
  }

  /**
   * Parses the text query into structured search attributes
   */
  parseQuery(query: string): SearchQueryAttributes {
    const sizes = this.extractSizes(query);
    let workingText = query;
    for (const sz of sizes) {
      workingText = workingText.replace(sz.originalText, '');
    }

    const rawTokens = workingText.split(/[\s,.*_+-]+/).filter(Boolean);
    const textTokens = rawTokens.map((t) => normalizeText(t)).filter(Boolean);

    const colors: string[] = [];
    const shapes: string[] = [];
    const categories: string[] = [];
    const materials: string[] = [];
    const brands: string[] = [];
    let isPremium = false;

    // Check tokens against synonym dictionaries
    for (const token of textTokens) {
      for (const [synKey, list] of Object.entries(SYNONYMS)) {
        if (list.includes(token) || token === synKey) {
          if (
            [
              'oq',
              'beige',
              'cream',
              'kok',
              'yashil',
              'qizil',
              'qora',
              'kulrang',
            ].includes(synKey)
          ) {
            colors.push(synKey);
          } else if (['dumaloq', 'oval', 'tortburchak'].includes(synKey)) {
            shapes.push(
              synKey === 'dumaloq'
                ? 'CIRCLE'
                : synKey === 'oval'
                  ? 'OVAL'
                  : 'RECTANGLE',
            );
          } else if (['klassik', 'zamonaviy'].includes(synKey)) {
            categories.push(synKey === 'klassik' ? 'Classic' : 'Modern');
          } else if (['yumshoq', 'qalin'].includes(synKey)) {
            // general attributes
          } else if (['premium'].includes(synKey)) {
            isPremium = true;
          }
        }
      }

      if (['turk', 'eron', 'belgiya'].includes(token)) {
        brands.push(
          token === 'turk' ? 'Turkiya' : token === 'eron' ? 'Eron' : 'Belgiya',
        );
      }
      if (['bambuk', 'paxta', 'sintetika', 'ipak', 'jun'].includes(token)) {
        materials.push(token);
      }
    }

    return {
      sizes,
      colors,
      shapes,
      categories,
      materials,
      brands,
      isPremium,
      textTokens,
    };
  }

  /**
   * Professional multifacted search engine with caching & ranking.
   */
  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<{ results: SearchCarpetItem[]; totalCount: number }> {
    const index = await this.buildSearchIndex();

    // Step 1: Typo correction
    const { correctedQuery } = await this.correctTypos(query, index);
    const attributes = this.parseQuery(correctedQuery);

    const scoredResults: SearchResult[] = [];

    // Step 2: Rank items using relevance score system
    for (const item of index) {
      let score = 0;
      let isMatch = false;

      // Size match logic (heavy prioritization for standard & roll sizes)
      if (attributes.sizes.length > 0) {
        let sizeMatch = false;
        let rollMatch = false;

        for (const sz of attributes.sizes) {
          // If roll query (e.g. 200x30 or 2 metr or single width roll search)
          if (sz.lengthCm === 0 || sz.lengthCm >= 1000) {
            const matchedRoll = item.sizes.some(
              (s) => Math.abs(s.widthCm - sz.widthCm) <= 15,
            );
            if (
              matchedRoll &&
              (item.type === 'ROLL' ||
                item.categoryName.toLowerCase().includes('metraj'))
            ) {
              rollMatch = true;
              break;
            }
          }

          // Interchangeable match (3x2 matches both 3x2 and 2x3)
          const matched = item.sizes.some(
            (s) =>
              (Math.abs(s.widthCm - sz.widthCm) <= 15 &&
                Math.abs(s.lengthCm - sz.lengthCm) <= 15) ||
              (Math.abs(s.widthCm - sz.lengthCm) <= 15 &&
                Math.abs(s.lengthCm - sz.widthCm) <= 15),
          );

          if (matched) {
            sizeMatch = true;
            break;
          }
        }

        if (sizeMatch) {
          score += 250;
          isMatch = true;
        } else if (rollMatch) {
          score += 300;
          isMatch = true;
        }
      }

      // Color matching
      if (attributes.colors.length > 0) {
        let colorMatch = false;
        for (const col of attributes.colors) {
          if (
            (item.description &&
              normalizeText(item.description).includes(col)) ||
            item.normalizedName.includes(col) ||
            (item.normalizedCategoryName &&
              item.normalizedCategoryName.includes(col))
          ) {
            colorMatch = true;
            score += 50;
          }
        }
        if (colorMatch) isMatch = true;
      }

      // Shape matching
      if (attributes.shapes.length > 0) {
        if (attributes.shapes.includes(item.shape)) {
          score += 100;
          isMatch = true;
        }
      }

      // Category matching
      if (attributes.categories.length > 0) {
        let catMatch = false;
        for (const cat of attributes.categories) {
          if (item.normalizedCategoryName.includes(cat.toLowerCase())) {
            catMatch = true;
            score += 80;
          }
        }
        if (catMatch) isMatch = true;
      }

      // Material matching
      if (attributes.materials.length > 0) {
        let matMatch = false;
        for (const mat of attributes.materials) {
          if (
            item.normalizedMaterial.includes(mat) ||
            (item.description && normalizeText(item.description).includes(mat))
          ) {
            matMatch = true;
            score += 60;
          }
        }
        if (matMatch) isMatch = true;
      }

      // Premium segment matching
      if (attributes.isPremium) {
        if (
          item.priceSegment === 'PREMIUM' ||
          item.price > 400000 ||
          item.normalizedName.includes('premium')
        ) {
          score += 100;
          isMatch = true;
        }
      }

      // Text tokens ranking (contains, prefix, suffix, fuzzy, trigram)
      if (attributes.textTokens.length > 0) {
        for (const token of attributes.textTokens) {
          // Exact matches
          if (item.normalizedName === token) {
            score += 150;
            isMatch = true;
          }
          if (
            item.normalizedDesignCode === token ||
            item.normalizedPatternCode === token
          ) {
            score += 200;
            isMatch = true;
          }

          // Prefix, Suffix, Contains matches
          if (item.normalizedName.startsWith(token)) {
            score += 70;
            isMatch = true;
          }
          if (item.normalizedName.endsWith(token)) {
            score += 40;
            isMatch = true;
          }
          if (item.normalizedName.includes(token)) {
            score += 50;
            isMatch = true;
          }
          if (
            item.normalizedDesignCode &&
            item.normalizedDesignCode.includes(token)
          ) {
            score += 90;
            isMatch = true;
          }

          // Fuzzy search (Levenshtein)
          const nameTokens = item.normalizedName.split(/\s+/);
          for (const nt of nameTokens) {
            if (Math.abs(nt.length - token.length) <= 2) {
              const dist = getLevenshteinDistance(token, nt);
              if (dist <= 1) {
                score += 80;
                isMatch = true;
              } else if (dist === 2) {
                score += 40;
                isMatch = true;
              }
            }
          }

          if (item.normalizedDesignCode) {
            const distCode = getLevenshteinDistance(
              token,
              item.normalizedDesignCode,
            );
            if (distCode <= 1) {
              score += 100;
              isMatch = true;
            }
          }

          // Trigram similarity matching
          const trigramSim = getTrigramSimilarity(token, item.normalizedName);
          if (trigramSim > 0.25) {
            score += Math.round(trigramSim * 60);
            isMatch = true;
          }
        }
      }

      // If query was completely empty, match all (allows catalog listing with filters)
      if (query.trim() === '') {
        isMatch = true;
        score = 1;
      }

      if (isMatch) {
        scoredResults.push({ carpet: item, score });
      }
    }

    // Step 3: Apply post-filters
    let filtered = scoredResults;

    if (options.categoryId) {
      filtered = filtered.filter(
        (r) => r.carpet.categoryId === options.categoryId,
      );
    }
    if (options.shape) {
      filtered = filtered.filter((r) => r.carpet.shape === options.shape);
    }
    if (options.size) {
      filtered = filtered.filter((r) =>
        r.carpet.sizes.some((s) => s.sizeStr === options.size),
      );
    }
    if (options.minPrice !== undefined) {
      filtered = filtered.filter((r) => r.carpet.price >= options.minPrice!);
    }
    if (options.maxPrice !== undefined) {
      filtered = filtered.filter((r) => r.carpet.price <= options.maxPrice!);
    }
    if (options.material) {
      const normMat = normalizeText(options.material);
      filtered = filtered.filter((r) =>
        r.carpet.normalizedMaterial.includes(normMat),
      );
    }
    if (options.onlyAvailable) {
      filtered = filtered.filter((r) =>
        r.carpet.sizes.some((s) => s.stock > 0),
      );
    }
    if (options.onlyPromo) {
      filtered = filtered.filter((r) => r.carpet.discountPercent > 0);
    }
    if (options.onlyNew) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      filtered = filtered.filter((r) => r.carpet.createdAt >= thirtyDaysAgo);
    }

    // Sort by relevance score descending (and secondary sorting by price/likes/createdAt)
    filtered.sort(
      (a, b) =>
        b.score - a.score ||
        b.carpet.likes - a.carpet.likes ||
        b.carpet.createdAt.getTime() - a.carpet.createdAt.getTime(),
    );

    const totalCount = filtered.length;

    // Apply pagination
    const page = options.page || 1;
    const limit = options.limit || 5;
    const startIndex = (page - 1) * limit;
    const paginatedResults = filtered
      .slice(startIndex, startIndex + limit)
      .map((r) => r.carpet);

    return {
      results: paginatedResults,
      totalCount,
    };
  }
}
