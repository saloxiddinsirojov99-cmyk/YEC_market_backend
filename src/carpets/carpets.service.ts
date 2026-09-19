import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  ForbiddenException,
} from '@nestjs/common';
import { CacheService } from '../common/cache.service';
import { normalizeSearchValue } from '../common/utils/search.util';
import { PrismaService } from '../prisma/prisma.service';
import { CarpetsRepository } from './carpets.repository';
import { CatalogDesignService } from './catalog-design.service';
import { CreateCarpetDto } from './dto/create-carpet.dto';
import { CarpetQueryDto } from './dto/carpet-query.dto';
import { UpdateCarpetDto } from './dto/update-carpet.dto';
import { CarpetInventoryStatus, CarpetType } from '@prisma/client';
import { UpdateCarpetDiscountDto } from './dto/update-carpet-discount.dto';
import { UpdateCarpetM2PriceDto } from './dto/update-carpet-m2-price.dto';
import { normalizeCarpetName } from '../common/utils/carpet-name.util';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  buildCreateDto,
  parseProductName,
  parseDimensions,
  normalizeEnums,
  normalizeHeader,
  getRowValueByAliases,
} from './carpet.mapper';

// Each group: the first element is the canonical/stored name,
// the rest are common typos, transliterations, and abbreviations users might type.
const MATERIAL_SYNONYMS: string[][] = [
  [
    'acrylic',
    'akril',
    'akriyil',
    'acril',
    'acrili',
    'akrilik',
    'akrilic',
    'akrilk',
    'akrylic',
    'acryl',
  ],
  [
    'micro-polister',
    'micro polister',
    'micro-polyester',
    'micropolyester',
    'micropolister',
    'mikropolister',
    'mikro-polister',
    'mikro polister',
    'polister',
    'polistir',
    'poliester',
    'polyester',
    'poliestr',
    'polistr',
    'pollister',
    'polyestr',
    'polistyr',
  ],
  [
    'polypropylene',
    'polipropyline',
    'polipropylen',
    'polipropilen',
    'polipropilin',
    'poliproplin',
    'poliprofin',
    'poliprofel',
    'polipropin',
    'polipropil',
    'poliprop',
    'polypropilen',
    'polipropelin',
    'polipropiyen',
    'propilen',
    'proplin',
  ],
  [
    'ipak',
    'silk',
    'ipek',
    'ipk',
    'ipag',
    'ipakk',
    'shilk',
    'shelk',
    'shoyi',
    "sho'yi",
  ],
  ['jun', 'wool', 'jung', "jun'", 'junn', 'vul', 'vool', 'yun', 'yung'],
  ['bambuk', 'bamboo', 'bambuc', 'bambk', 'bambu', 'banbuk'],
  ['viscose', 'viskoz', 'viskoza', 'viscoza', 'viskos', 'viscos', 'viskose'],
  ['nylon', 'naylon', 'nilon', 'neylon', 'nailon'],
  ['cotton', 'koton', 'paxta', 'pahta', 'pakhta', 'cottton'],
  ['chenille', 'shenil', 'shenill', 'chenil', 'chenile', 'sheniyl'],
  ['jute', 'jut', 'djut', 'dyut', 'dzhut'],
];

const METRAJ_TAG = '[METRAJ]';
const PRAYER_KEYWORD = 'joynamoz';
const OVAL_KEYWORD = 'oval';

const normalizeSizeDims = (raw: string): number[] => {
  const normalized = String(raw || '')
    .toLowerCase()
    .replace(/,/g, '.');
  const matches = normalized.match(/\d+(\.\d+)?/g);
  if (!matches || matches.length === 0) return [];

  const numbers = matches
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (numbers.length === 0) return [];

  const sorted = [...numbers].sort((a, b) => a - b);
  const hasCm =
    normalized.includes('cm') || normalized.includes('\u0441\u043c');
  const useCm = hasCm || sorted.some((value) => value > 20);

  return sorted
    .map((value) => (useCm ? value : value * 100))
    .map((value) => Math.round(value));
};

const buildSizePatterns = (a: number, b: number): string[] => {
  const separators = ['x', '×', '*'];
  const patterns = new Set<string>();

  for (const sep of separators) {
    patterns.add(`${a}${sep}${b}`);
    patterns.add(`${b}${sep}${a}`);
    patterns.add(`${a} ${sep} ${b}`);
    patterns.add(`${b} ${sep} ${a}`);
  }

  return Array.from(patterns);
};

@Injectable()
export class CarpetsService implements OnModuleInit {
  private collectionPriceOverrideMap = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    private readonly carpetsRepository: CarpetsRepository,
    private readonly catalogDesignService: CatalogDesignService,
  ) {}

  normalizeDesignCode(code?: string | null): string {
    if (!code) return '';
    return String(code)
      .trim()
      .toUpperCase()
      .replace(/[\s\-_''`'"]/g, '');
  }

  getCatalogType(type?: string, productType?: string): 'READY' | 'ROLL' {
    if (type === 'ROLL' || productType === 'METRAJ') {
      return 'ROLL';
    }
    return 'READY';
  }

  async findCatalogDesignImage(
    designCode: string,
    type: 'READY' | 'ROLL',
  ): Promise<{ id: string; image: string } | null> {
    const norm = this.normalizeDesignCode(designCode);
    if (!norm) return null;
    const match = await this.prisma.catalogDesign.findFirst({
      where: {
        designCode: { equals: norm, mode: 'insensitive' },
        productType: type,
        isActive: true,
      },
      select: {
        id: true,
        image: true,
      },
    });
    return match;
  }

  private normalizeCollectionSlug(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async findCollectionImage(
    collectionName: string,
    designCode: string,
  ): Promise<string | null> {
    if (!collectionName || !designCode) return null;
    const slug = this.normalizeCollectionSlug(collectionName);
    const code = designCode.trim().toUpperCase();

    // 1. Try manifest.json first
    const manifestPath = join(
      process.cwd(),
      '../front/public/images/collections/manifest.json',
    );
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

        const mappedPath = manifest.images?.[slug]?.[code];
        if (mappedPath) {
          const fullPath = join(process.cwd(), '../front/public', mappedPath);
          if (existsSync(fullPath)) return mappedPath;
        }

        for (const [s, codesMap] of Object.entries(manifest.images)) {
          if (codesMap && typeof codesMap === 'object') {
            for (const [c, path] of Object.entries(codesMap)) {
              if (c.trim().toUpperCase() === code) {
                const fullPath = join(
                  process.cwd(),
                  '../front/public',
                  path as string,
                );
                if (existsSync(fullPath)) return path as string;
              }
            }
          }
        }
      } catch (err) {
        // manifest corruption fallback
      }
    }

    // 2. Failsafe: directory scanning
    const collectionsDir = join(
      process.cwd(),
      '../front/public/images/collections',
    );
    if (existsSync(collectionsDir)) {
      const extensions = ['.jpg', '.jpeg', '.png', '.webp'];

      const slugDir = join(collectionsDir, slug);
      if (existsSync(slugDir)) {
        try {
          const files = readdirSync(slugDir);
          for (const ext of extensions) {
            const expectedFile = `${code}${ext}`.toLowerCase();
            const foundFile = files.find(
              (f) => f.toLowerCase() === expectedFile,
            );
            if (foundFile) {
              return `/images/collections/${slug}/${foundFile}`;
            }
          }
        } catch {}
      }

      try {
        const dirs = readdirSync(collectionsDir);
        for (const d of dirs) {
          const subDir = join(collectionsDir, d);
          if (existsSync(subDir)) {
            const files = readdirSync(subDir);
            for (const ext of extensions) {
              const expectedFile = `${code}${ext}`.toLowerCase();
              const foundFile = files.find(
                (f) => f.toLowerCase() === expectedFile,
              );
              if (foundFile) {
                return `/images/collections/${d}/${foundFile}`;
              }
            }
          }
        }
      } catch {}
    }

    return null;
  }

  private async generateUniqueBarcode(): Promise<string> {
    let attempts = 0;
    while (attempts < 100) {
      attempts++;
      const num = Math.floor(10000000 + Math.random() * 90000000);
      const barcodeStr = String(num);
      const existing = await this.prisma.inventoryItem.findUnique({
        where: { barcode: barcodeStr },
      });
      if (!existing) {
        return barcodeStr;
      }
    }
    throw new BadRequestException(
      'Barcode generatsiya qilish urinishlari soni oshib ketdi (100 marta).',
    );
  }

  async generateUniqueSku(
    designCode: string,
    widthCm: number,
    lengthCm: number,
  ): Promise<string> {
    const cleanDesign = (designCode || 'UNKNOWN')
      .trim()
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase();
    let counter = 1;
    let attempts = 0;
    while (attempts < 100) {
      attempts++;
      const paddedCounter = String(counter).padStart(4, '0');
      const skuStr = `RET-${cleanDesign}-${widthCm}-${lengthCm}-${paddedCounter}`;
      const existing = await this.prisma.inventoryItem.findUnique({
        where: { sku: skuStr },
      });
      if (!existing) {
        return skuStr;
      }
      counter++;
    }
    throw new BadRequestException(
      'SKU generatsiya qilish urinishlari soni oshib ketdi.',
    );
  }

  async onModuleInit() {
    setImmediate(async () => {
      try {
        const isDbUp = await this.prisma.verifyConnection();
        if (!isDbUp) {
          return;
        }
        await this.prisma.$executeRaw`
          UPDATE "carpets" c
          SET "likes" = (
            SELECT COUNT(*)::integer FROM "carpet_likes" cl WHERE cl."carpetId" = c.id
          );
        `;
      } catch (error) {
        console.warn(
          'CarpetsService.onModuleInit ogohlantirish:',
          error instanceof Error ? error.message : error,
        );
      }
    });
  }

  /**
   * Given a user's material query, find all synonym keywords that should be searched.
   * Returns an array of keywords to OR-search against.
   */
  private resolveMaterialKeywords(input: string): string[] {
    const q = input.trim().toLowerCase();
    if (!q) return [];

    const queryVariants = this.buildMaterialQueryVariants(q);

    const matchedGroups: string[][] = [];
    for (const group of MATERIAL_SYNONYMS) {
      if (this.matchesMaterialGroup(queryVariants, group)) {
        matchedGroups.push(group);
      }
    }

    const keywords = new Set<string>();

    if (matchedGroups.length === 0) {
      // No synonym group matched - fall back to query variants
      queryVariants.forEach((variant) => keywords.add(variant));
      return Array.from(keywords);
    }

    // Collect all unique keywords from matched groups + query variants
    for (const group of matchedGroups) {
      for (const word of group) {
        keywords.add(word);
      }
    }
    queryVariants.forEach((variant) => keywords.add(variant));

    return Array.from(keywords);
  }

  /**
   * Simple fuzzy comparison: true if edit distance is within a small threshold
   * based on the string length, or if one string starts with the other.
   */
  private fuzzyMatch(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a.startsWith(b) || b.startsWith(a)) return true;

    const len1 = a.length;
    const len2 = b.length;
    const maxLen = Math.max(len1, len2);
    if (maxLen < 3) return false;

    const threshold = maxLen <= 5 ? 1 : maxLen <= 8 ? 2 : maxLen <= 12 ? 3 : 4;
    if (Math.abs(len1 - len2) > threshold) return false;

    // Levenshtein distance <= threshold
    if (len1 === 0 || len2 === 0) return false;
    const matrix: number[][] = [];
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }
    return matrix[len1][len2] <= threshold;
  }

  private normalizeMaterialToken(value: string): string {
    return value
      .toLowerCase()
      .replace(/[']/g, '')
      .replace(/[^a-z0-9]+/g, '');
  }

  private buildMaterialQueryVariants(value: string): string[] {
    const base = value.trim().toLowerCase();
    if (!base) return [];

    const variants = new Set<string>();
    const add = (v: string) => {
      const trimmed = v.trim();
      if (trimmed.length >= 2) variants.add(trimmed);
    };

    add(base);
    add(base.replace(/\s+/g, ' '));
    add(base.replace(/\s+/g, '-'));
    add(base.replace(/[\s-]+/g, ''));

    const tokens = base
      .split(/[\s+/_-]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    tokens.forEach((token) => add(token));

    return Array.from(variants);
  }

  private matchesMaterialGroup(
    queryVariants: string[],
    group: string[],
  ): boolean {
    const normalizedQueries = queryVariants
      .map((q) => this.normalizeMaterialToken(q))
      .filter(Boolean);

    for (const synonym of group) {
      const rawSyn = synonym.toLowerCase();
      const normSyn = this.normalizeMaterialToken(rawSyn);

      for (const q of queryVariants) {
        if (!q) continue;
        if (rawSyn.includes(q) || q.includes(rawSyn)) return true;
      }

      for (const q of normalizedQueries) {
        if (!q) continue;
        if (normSyn.includes(q) || q.includes(normSyn)) return true;
        if (this.fuzzyMatch(q, normSyn)) return true;
      }
    }

    return false;
  }
  async create(dto: CreateCarpetDto, actorId = 'SYSTEM') {
    if (!dto.barcode) {
      dto.barcode = await this.generateUniqueBarcode();
    }
    if (!dto.name) {
      throw new BadRequestException("Mahsulot nomi bo'sh bo'lmasligi kerak.");
    }
    if (!dto.patternCode) {
      throw new BadRequestException(
        "Dizayn kodi (patternCode) bo'sh bo'lmasligi kerak.",
      );
    }
    if (dto.widthMm <= 0) {
      throw new BadRequestException("Eni 0 dan katta bo'lishi kerak.");
    }
    if (dto.lengthMm <= 0) {
      throw new BadRequestException("Bo'yi 0 dan katta bo'lishi kerak.");
    }

    const existingBarcode = await this.prisma.inventoryItem.findUnique({
      where: { barcode: dto.barcode },
    });
    if (existingBarcode) {
      throw new ConflictException(
        `Barcode "${dto.barcode}" allaqachon mavjud. Boshqa barcode kiriting.`,
      );
    }

    // Clean name
    const cleanedName = normalizeCarpetName(dto.name);
    dto.name = cleanedName;

    // Check category
    const category = dto.categoryId
      ? await this.prisma.category.findUnique({ where: { id: dto.categoryId } })
      : null;
    const categoryName = category?.name ?? '';
    const isJoynamoz = categoryName.toLowerCase().includes('joynamoz');
    const isOval =
      categoryName.toLowerCase().includes('oval') || dto.shape === 'OVAL';

    let finalImages = dto.images && dto.images.length > 0 ? dto.images : [];

    const code = dto.designCode || dto.patternCode;
    if (code) {
      try {
        const carpetType =
          dto.type === 'ROLL' || dto.productType === 'METRAJ'
            ? 'ROLL'
            : 'READY';
        const catalogMatch = await this.catalogDesignService.validateDesignCode(
          code,
          carpetType,
        );
        if (catalogMatch) {
          if (catalogMatch.image && finalImages.length === 0) {
            finalImages = [catalogMatch.image];
          }
          if (catalogMatch.id) {
            (dto as any)._catalogDesignId = catalogMatch.id;
          }
        }
      } catch (err) {
        // Fallback to provided images if not found in catalogDesign
      }
    }

    dto.images = finalImages;
    if (!dto.designCode && dto.patternCode) {
      dto.designCode = dto.patternCode;
    }

    return this.prisma.$transaction(async (tx) => {
      const lastNum = await this.carpetsRepository.getLastCarpetNumber(tx);
      const uniqueCode = `CARPET-${String(lastNum + 1).padStart(6, '0')}`;

      const carpet = await this.carpetsRepository.create(
        {
          uniqueCode,
          name: dto.name,
          patternCode:
            dto.patternCode || (dto as any).designCode || dto.name || 'DEFAULT',
          productType: dto.productType,
          shape: dto.shape,
          price: dto.price !== undefined ? dto.price : 0,
          material: dto.material || '',
          description: dto.description || null,
          images: dto.images,
          category: dto.categoryId
            ? { connect: { id: dto.categoryId } }
            : undefined,
          qo_shimchaKod:
            dto.qo_shimchaKod !== undefined && dto.qo_shimchaKod !== null
              ? BigInt(dto.qo_shimchaKod)
              : null,
          brand: 'YEC',
          type: dto.type || 'READY',
          designCode: dto.designCode,
          weightKg: dto.weightKg !== undefined ? dto.weightKg : null,
          pileHeight: dto.pileHeight !== undefined ? dto.pileHeight : null,
          ...((dto as any)._catalogDesignId
            ? {
                catalogDesign: {
                  connect: { id: (dto as any)._catalogDesignId },
                },
                imageSnapshot: dto.images?.[0] ?? null,
              }
            : {}),
        },
        tx,
      );

      // Populate physical WMS inventory items for READY carpets
      const stockCount = dto.stock !== undefined ? dto.stock : 1;
      if (dto.type === 'READY' || !dto.type) {
        for (let i = 0; i < stockCount; i++) {
          const barcode =
            i === 0 && dto.barcode
              ? dto.barcode
              : await this.generateUniqueBarcode();
          const sku = `SKU-${barcode}`;
          await tx.inventoryItem.create({
            data: {
              carpetId: carpet.id,
              barcode,
              sku,
              widthMm: dto.widthMm,
              lengthMm: dto.lengthMm,
              size: dto.size || `${dto.widthMm / 1000}x${dto.lengthMm / 1000}`,
              piecePrice: dto.price !== undefined ? dto.price : 0,
              selectedArea: (dto.widthMm * dto.lengthMm) / 1000000,
              inventoryStatus: CarpetInventoryStatus.ACTIVE,
            },
          });
        }

        // Add to InventoryLedger
        await tx.inventoryLedger.create({
          data: {
            carpetId: carpet.id,
            quantity: stockCount,
            action: 'MANUAL_CREATE',
            reason: 'Initial ready stock creation',
            actor: actorId,
          },
        });
      } else if (dto.type === 'ROLL') {
        // Create RollInventory record
        await tx.rollInventory.create({
          data: {
            carpetId: carpet.id,
            widthCm: Math.round(dto.widthMm / 10),
            originalLengthCm: Math.round(dto.lengthMm / 10),
            currentLengthCm: Math.round(dto.lengthMm / 10),
            pricePerM2: dto.price !== undefined ? dto.price : 0,
          },
        });

        // Add to InventoryLedger
        await tx.inventoryLedger.create({
          data: {
            carpetId: carpet.id,
            quantity: 1,
            action: 'MANUAL_CREATE',
            reason: 'Initial roll stock creation',
            actor: actorId,
          },
        });
      }

      this.invalidateFilterCache();
      return carpet;
    });
  }

  async findAll(query: CarpetQueryDto, userId?: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;
    const kind = query.kind?.toLowerCase();

    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw new BadRequestException(
        "Minimal narx maksimal narxdan katta bo'lmasligi kerak.",
      );
    }

    const searchStr = (query.search || '').toLowerCase().trim();
    const eronVariants = [
      'eron',
      'iran',
      'eron-soft',
      'eron soft',
      'iran-soft',
      'iran soft',
      'soft',
    ];
    const isEronSearch = eronVariants.some((v) => searchStr.includes(v));

    // Build search query with improved dimensions matching
    let searchConditions: any[] = [];
    if (query.search) {
      const searchText = isEronSearch ? 'iran-soft' : query.search;
      const syns = this.resolveMaterialKeywords(query.search);

      // Dynamic name variants search to support dashes/underscores/spaces mapping
      const searchVariants = [searchText];
      if (searchText.includes(' ')) {
        searchVariants.push(searchText.replace(/ /g, '-'));
        searchVariants.push(searchText.replace(/ /g, '_'));
        searchVariants.push(searchText.replace(/ /g, ''));
      } else if (searchText.includes('-')) {
        searchVariants.push(searchText.replace(/-/g, ' '));
        searchVariants.push(searchText.replace(/-/g, '_'));
        searchVariants.push(searchText.replace(/-/g, ''));
      } else if (searchText.includes('_')) {
        searchVariants.push(searchText.replace(/_/g, ' '));
        searchVariants.push(searchText.replace(/_/g, '-'));
        searchVariants.push(searchText.replace(/_/g, ''));
      }

      const nameConditions = searchVariants.map((variant) => ({
        name: { contains: variant, mode: 'insensitive' as const },
      }));

      // Basic text search in Name, Size, Description
      searchConditions = [
        ...nameConditions,
        {
          description: { contains: query.search, mode: 'insensitive' as const },
        },
        {
          designCode: { contains: query.search, mode: 'insensitive' as const },
        },
        {
          patternCode: { contains: query.search, mode: 'insensitive' as const },
        },
        {
          inventoryItems: {
            some: {
              OR: [
                {
                  size: {
                    contains: query.search,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  barcode: {
                    contains: query.search,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  sku: { contains: query.search, mode: 'insensitive' as const },
                },
                {
                  returnRequestId: {
                    contains: query.search,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  sourceOrderId: {
                    contains: query.search,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  inventorySource: {
                    contains: query.search,
                    mode: 'insensitive' as const,
                  },
                },
              ],
            },
          },
        },
        ...syns.map((s) => ({
          description: { contains: s, mode: 'insensitive' as const },
        })),
      ];

      // Smart Dimension Matching: if user types "0.75", also match "75" in Size
      const numbersInSearch =
        query.search.match(/(\d+(\.\d+)?)/g)?.map(Number) || [];
      numbersInSearch.forEach((n) => {
        if (n < 15) {
          const normalized = Math.round(n * 100);
          searchConditions.push({
            inventoryItems: {
              some: {
                size: {
                  contains: String(normalized),
                  mode: 'insensitive' as const,
                },
              },
            },
          });
        }
      });
    }

    const where: any = {
      categoryId: query.categoryId,
    };

    const isHeroSearch = (query.search ?? '').includes('[HERO]');

    const andConditions: any[] = [];

    // Skip the [METRAJ] exclusion filter when specifically searching for hero carpets,
    // because hero ROLL carpets may also carry [METRAJ] in their description.
    if (!isHeroSearch) {
      andConditions.push({
        OR: [
          { description: null },
          { NOT: { description: { contains: METRAJ_TAG } } },
        ],
      });
    }

    if (!query.showAll) {
      andConditions.push({
        isArchived: false,
        OR: [
          {
            type: { in: ['ROLL', 'RETURN_ROLL'] },
          },
          {
            type: { in: ['READY', 'RETURN_READY'] },
            OR: [
              {
                inventoryItems: {
                  some: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
                },
              },
              {
                inventoryItems: {
                  none: {},
                },
              },
            ],
          },
        ],
      });
    } else {
      andConditions.push({
        isArchived: false,
      });
    }

    if (searchConditions.length > 0) {
      andConditions.push({
        OR: searchConditions,
      });
    }

    if (query.collection) {
      const coll = query.collection.trim();
      const carpetFields = (this.prisma.carpet as any).fields || {};
      if ('collectionName' in carpetFields) {
        andConditions.push({
          collectionName: { equals: coll, mode: 'insensitive' as const },
        });
      } else {
        andConditions.push({
          name: { equals: coll, mode: 'insensitive' as const },
        });
      }
    }

    if (query.excludeId) {
      andConditions.push({
        id: { not: query.excludeId },
      });
    }

    if (isEronSearch) {
      andConditions.push({
        NOT: { name: { contains: 'verona', mode: 'insensitive' as const } },
      });
    }

    if (kind === 'prayer') {
      andConditions.push({
        category: {
          name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'oval') {
      andConditions.push({
        category: {
          name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'roll') {
      andConditions.push({ type: 'ROLL' });
    } else if (kind === 'returned') {
      andConditions.push({ isReturned: true });
    } else if (kind === 'returned_roll') {
      andConditions.push({ type: 'RETURN_ROLL' });
    } else if (kind === 'returned_ready') {
      andConditions.push({ type: 'RETURN_READY' });
    } else if (kind === 'normal_roll') {
      andConditions.push({ type: 'ROLL' });
    } else if (kind === 'normal_ready') {
      andConditions.push({ type: 'READY', isReturned: false });
    } else if (kind === 'normal') {
      andConditions.push({ isReturned: false });
    } else if (kind === 'carpet') {
      andConditions.push(
        {
          NOT: {
            category: {
              name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
            },
          },
        },
        {
          NOT: {
            category: {
              name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
            },
          },
        },
        { NOT: { type: 'ROLL' } },
      );
    }

    // If multiple material keywords, use OR to match any of them
    if (query.material) {
      const materialsList = query.material.split(',').filter(Boolean);
      const allKeywords = new Set<string>();
      for (const mat of materialsList) {
        const normalizedMat = normalizeSearchValue(mat);
        const keywords = this.resolveMaterialKeywords(normalizedMat);
        keywords.forEach((k) => allKeywords.add(k.toLowerCase()));
        allKeywords.add(normalizedMat.toLowerCase());
      }
      const finalKeywords = Array.from(allKeywords);
      if (finalKeywords.length > 0) {
        andConditions.push({
          OR: finalKeywords.map((kw) => ({
            material: { contains: kw, mode: 'insensitive' as const },
          })),
        });
      }
    }

    if (query.size) {
      const dims = normalizeSizeDims(query.size);

      if (dims.length >= 2) {
        const [a, b] = dims;
        const patterns = buildSizePatterns(a, b);
        andConditions.push({
          OR: [
            ...patterns.map((pattern) => ({
              inventoryItems: {
                some: {
                  size: { contains: pattern, mode: 'insensitive' as const },
                },
              },
            })),
            {
              rollInventories: {
                some: {
                  widthCm: { in: [a, b] },
                },
              },
            },
          ],
        });
      } else if (dims.length === 1) {
        const val = dims[0];
        andConditions.push({
          OR: [
            {
              inventoryItems: {
                some: {
                  size: { contains: String(val), mode: 'insensitive' as const },
                },
              },
            },
            {
              rollInventories: {
                some: {
                  widthCm: val,
                },
              },
            },
          ],
        });
      }
    }

    if (andConditions.length > 0) {
      where.AND = [...(where.AND ?? []), ...andConditions];
    }

    let orderBy: any = { createdAt: 'desc' };
    if (query.sortBy === 'popular') {
      orderBy = { likes: 'desc' };
    } else if (query.sortBy === 'price_asc') {
      orderBy = { price: 'asc' };
    } else if (query.sortBy === 'price_desc') {
      orderBy = { price: 'desc' };
    } else if (query.sortBy === 'oldest') {
      orderBy = { createdAt: 'asc' };
    }

    let items: any[] = [];
    let total = 0;

    const includeRollInventories = kind === 'roll';

    if (kind === 'roll' && !query.raw) {
      const dbItems = await this.prisma.carpet.findMany({
        where,
        include: {
          category: true,
          rollInventories: true,
          inventoryItems: {
            where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const groups = new Map<
        string,
        {
          id: string;
          name: string;
          price: number;
          material: string;
          images: string[];
          slug?: string;
          category: any;
          stock: number;
          designCodes: string[];
          rollInventories: any[];
          brand?: string;
        }
      >();

      for (const item of dbItems) {
        const key = item.name.trim().toLowerCase();
        const design = item.designCode || '';
        const m2Price = Number(item.price);
        const itemStock = item.inventoryItems.length;

        if (!groups.has(key)) {
          groups.set(key, {
            id: item.id,
            name: item.name,
            price: m2Price,
            material: item.material,
            images: item.images || [],
            slug: (item as any).slug || item.id,
            category: item.category,
            stock: itemStock,
            designCodes: design ? [design] : [],
            rollInventories: item.rollInventories || [],
            brand: item.brand || undefined,
          });
        } else {
          const g = groups.get(key)!;
          if (design && !g.designCodes.includes(design)) {
            g.designCodes.push(design);
          }
          if (m2Price < g.price) {
            g.price = m2Price;
          }
          g.stock += itemStock;
          if (item.images && item.images.length > 0) {
            g.images = Array.from(new Set([...g.images, ...item.images]));
          }
          g.rollInventories = [
            ...g.rollInventories,
            ...(item.rollInventories || []),
          ];
        }
      }

      const groupedList = Array.from(groups.values());
      total = groupedList.length;
      items = groupedList.slice(skip, skip + limit);
    } else {
      const hasPriceFilter =
        query.minPrice !== undefined || query.maxPrice !== undefined;

      if (hasPriceFilter) {
        const allItems = await this.prisma.carpet.findMany({
          where,
          include: {
            category: true,
            ...(includeRollInventories ? { rollInventories: true } : {}),
            inventoryItems: {
              where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
            },
          },
          orderBy,
        });

        const filtered = allItems.filter((item) => {
          const sizeStr = item.inventoryItems[0]?.size || '0x0';
          const area = this.parseAreaFromSize(sizeStr);
          if (!area || area <= 0) return false;

          const m2Price = Number(item.price) / area;
          const minOk =
            query.minPrice !== undefined ? m2Price >= query.minPrice : true;
          const maxOk =
            query.maxPrice !== undefined ? m2Price <= query.maxPrice : true;
          return minOk && maxOk;
        });

        total = filtered.length;
        items = filtered.slice(skip, skip + limit);
      } else {
        const [dbItems, dbCount] = await this.prisma.$transaction([
          this.prisma.carpet.findMany({
            where,
            include: {
              category: true,
              ...(includeRollInventories ? { rollInventories: true } : {}),
              inventoryItems: {
                where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
              },
            },
            orderBy,
            skip,
            take: limit,
          }),
          this.prisma.carpet.count({ where }),
        ]);
        items = dbItems;
        total = dbCount;
      }
    }

    if (query.raw && query.collection) {
      const seenCodes = new Set<string>();
      const uniqueItems: any[] = [];
      for (const item of items) {
        const code = (item.designCode || '').trim().toLowerCase();
        if (!code || !seenCodes.has(code)) {
          uniqueItems.push(item);
          if (code) seenCodes.add(code);
        }
      }
      items = uniqueItems;
      total = uniqueItems.length;
    }

    let likedIds = new Set<string>();
    if (userId) {
      const likes = await this.prisma.carpetLike.findMany({
        where: { userId, carpetId: { in: items.map((i) => i.id) } },
      });
      likedIds = new Set(likes.map((l) => l.carpetId));
    }

    const itemsWithLikes = items.map((item) => {
      const transformed = this.transformCarpetResponse(item);
      return {
        ...transformed,
        isLiked: likedIds.has(item.id),
      };
    });

    return {
      items: itemsWithLikes,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string, userId?: string) {
    const carpet = await this.prisma.carpet.findUnique({
      where: { id },
      include: {
        category: true,
        rollInventories: true,
        inventoryItems: {
          where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
        },
      },
    });

    if (
      !carpet ||
      ((carpet.description ?? '').includes(METRAJ_TAG) &&
        carpet.type !== 'ROLL')
    ) {
      throw new NotFoundException('Gilam topilmadi.');
    }

    let isLiked = false;
    if (userId) {
      const like = await this.prisma.carpetLike.findUnique({
        where: { userId_carpetId: { userId, carpetId: id } },
      });
      isLiked = !!like;
    }

    let variants: any[] = [];
    if (carpet.type === 'ROLL') {
      variants = await this.prisma.carpet.findMany({
        where: {
          name: carpet.name,
          type: 'ROLL',
          isArchived: false,
        },
        include: {
          category: true,
          rollInventories: true,
        },
      });
    }

    const transformed = this.transformCarpetResponse(carpet);
    const transformedVariants = variants.map((v) =>
      this.transformCarpetResponse(v),
    );
    return { ...transformed, isLiked, variants: transformedVariants };
  }

  async toggleLike(carpetId: string, userId: string) {
    const carpet = await this.prisma.carpet.findUnique({
      where: { id: carpetId },
    });
    if (!carpet) {
      throw new NotFoundException('Gilam topilmadi.');
    }

    const existingLike = await this.prisma.carpetLike.findUnique({
      where: { userId_carpetId: { userId, carpetId } },
    });

    if (existingLike) {
      // Unlike
      await this.prisma.carpetLike.delete({ where: { id: existingLike.id } });
      const updated = await this.prisma.carpet.update({
        where: { id: carpetId },
        data: { likes: { decrement: 1 } },
      });
      return { liked: false, likes: updated.likes };
    } else {
      // Like
      await this.prisma.carpetLike.create({
        data: { userId, carpetId },
      });
      const updated = await this.prisma.carpet.update({
        where: { id: carpetId },
        data: { likes: { increment: 1 } },
      });
      return { liked: true, likes: updated.likes };
    }
  }

  async findLikedCarpets(userId: string) {
    const likes = await this.prisma.carpetLike.findMany({
      where: { userId },
      include: {
        carpet: {
          include: {
            category: true,
            inventoryItems: {
              where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return likes.map((like) => {
      const transformed = this.transformCarpetResponse(like.carpet);
      return {
        ...transformed,
        isLiked: true,
      };
    });
  }

  private transformCarpetResponse(carpet: any) {
    if (!carpet) return null;
    const activeItems = carpet.inventoryItems || [];
    const firstItem = activeItems[0];
    const size = firstItem?.size || (carpet as any).size || '200x300';
    const stock = activeItems.length || carpet.stock || 1;

    return {
      ...carpet,
      size,
      stock,
    };
  }

  async update(
    id: string,
    dto: UpdateCarpetDto,
    role?: string,
    actorId = 'SYSTEM',
  ) {
    const existing = await this.prisma.carpet.findUnique({
      where: { id },
      include: { category: true },
    });

    if (
      !existing ||
      ((existing.description ?? '').includes(METRAJ_TAG) &&
        existing.type !== 'ROLL')
    ) {
      throw new NotFoundException('Gilam topilmadi.');
    }

    const isReturnedCarpet =
      existing.type === 'RETURN_ROLL' || existing.type === 'RETURN_READY';

    if (isReturnedCarpet) {
      const dtoAny = dto as any;
      if (
        dto.price !== undefined ||
        dtoAny.pricePerM2 !== undefined ||
        dtoAny.piecePrice !== undefined ||
        dtoAny.selectedArea !== undefined
      ) {
        throw new ForbiddenException(
          "Qaytarilgan gilam narxlari o'zgarmas hisoblanadi.",
        );
      }
    }

    const firstItem = await this.prisma.inventoryItem.findFirst({
      where: { carpetId: existing.id },
    });

    const dtoAny = dto as any;
    const isEditingSuperadminFields =
      (dto.barcode !== undefined && dto.barcode !== firstItem?.barcode) ||
      (dtoAny.sku !== undefined && dtoAny.sku !== firstItem?.sku) ||
      (dtoAny.inventorySource !== undefined &&
        dtoAny.inventorySource !== firstItem?.inventorySource) ||
      (dtoAny.sourceOrderId !== undefined &&
        dtoAny.sourceOrderId !== firstItem?.sourceOrderId) ||
      (dtoAny.sourceOrderItemId !== undefined &&
        dtoAny.sourceOrderItemId !== firstItem?.sourceOrderItemId);

    if (isEditingSuperadminFields && role !== 'SUPERADMIN') {
      throw new ForbiddenException(
        "Bu maydonlarni faqat SUPERADMIN o'zgartira oladi.",
      );
    }

    if (dto.name) {
      dto.name = normalizeCarpetName(dto.name);
    }

    const validatingName = dto.name ?? existing.name;
    const nextCategoryId = dto.categoryId ?? existing.categoryId;
    const category = nextCategoryId
      ? await this.prisma.category.findUnique({ where: { id: nextCategoryId } })
      : null;
    const categoryName = category?.name ?? existing.category?.name ?? '';
    const isJoynamoz = categoryName.toLowerCase().includes('joynamoz');
    const isOval =
      categoryName.toLowerCase().includes('oval') || existing.shape === 'OVAL';

    let finalImages = dto.images || existing.images || [];

    const nextType = dto.type ?? existing.type;
    const carpetType = nextType === 'ROLL' ? 'ROLL' : 'READY';

    const isDesignUpdated =
      dto.designCode !== undefined && dto.designCode !== existing.designCode;
    const isTypeChanged = dto.type !== undefined && dto.type !== existing.type;

    if (isDesignUpdated || isTypeChanged) {
      const code =
        dto.designCode || existing.designCode || existing.patternCode;
      if (code) {
        try {
          const catalogMatch =
            await this.catalogDesignService.validateDesignCode(
              code,
              carpetType,
            );
          if (catalogMatch) {
            if (
              catalogMatch.image &&
              (!dto.images || dto.images.length === 0)
            ) {
              finalImages = [catalogMatch.image];
            }
            if (catalogMatch.id) {
              (dto as any)._catalogDesignId = catalogMatch.id;
            }
          }
        } catch (err) {
          // Fallback cleanly
        }
      }
    }

    dto.images = finalImages;

    if (dto.price !== undefined && Number(dto.price) <= 0) {
      throw new BadRequestException("Narx 0 dan katta bo'lishi kerak.");
    }
    if (dto.stock !== undefined && Number(dto.stock) < 0) {
      throw new BadRequestException("Miqdor manfiy bo'lishi mumkin emas.");
    }

    const normalizedData = this.normalizeCarpetData(dto);
    const hasDesignCodeField = Object.prototype.hasOwnProperty.call(
      dto,
      'designCode',
    );
    const nextName = normalizedData.name ?? dto.name ?? existing.name;
    const designCodeSeed = hasDesignCodeField
      ? dto.designCode
      : existing.designCode || existing.patternCode;
    const normalizedDesignCode =
      this.resolveDesignCode(designCodeSeed, nextName) ||
      existing.designCode ||
      existing.patternCode ||
      dto.designCode ||
      dto.patternCode ||
      null;

    const isOvalCategory = this.isOvalCategoryName(categoryName);

    const updateData: any = {
      ...dto,
      ...normalizedData,
      brand: 'YEC',
    };
    if (hasDesignCodeField || isOvalCategory || dto.name !== undefined) {
      updateData.designCode = normalizedDesignCode;
    }
    if (dto.qo_shimchaKod !== undefined) {
      updateData.qo_shimchaKod =
        dto.qo_shimchaKod !== null ? BigInt(dto.qo_shimchaKod) : null;
    }
    if (dto.price !== undefined) {
      updateData.price = dto.price;
    }

    const rollDtoWidthCm: number | undefined = (dto as any).widthCm;
    const rollDtoOriginalLengthCm: number | undefined = (dto as any)
      .originalLengthCm;
    const rollDtoPricePerM2: number | undefined = (dto as any).pricePerM2;

    delete updateData.stock;
    delete updateData.barcode;
    delete updateData.sku;
    delete updateData.widthMm;
    delete updateData.lengthMm;
    delete updateData.isReturned;
    delete updateData.returnRequestId;
    delete updateData.returnGeneration;
    delete updateData.inventorySource;
    delete updateData.sourceOrderId;
    delete updateData.sourceOrderItemId;
    delete updateData.widthCm;
    delete updateData.originalLengthCm;
    delete updateData.pricePerM2;
    delete updateData.size;

    const updated = await this.prisma.$transaction(async (tx) => {
      let updatedCarpet: any;
      let stockDiff = 0;

      if (dto.stock !== undefined) {
        const targetStock = Number(dto.stock);
        const currentActiveCount = await tx.inventoryItem.count({
          where: {
            carpetId: id,
            inventoryStatus: CarpetInventoryStatus.ACTIVE,
          },
        });
        stockDiff = targetStock - currentActiveCount;

        if (targetStock === 0) {
          await tx.inventoryItem.updateMany({
            where: {
              carpetId: id,
              inventoryStatus: CarpetInventoryStatus.ACTIVE,
            },
            data: { inventoryStatus: CarpetInventoryStatus.ARCHIVED },
          });
          updatedCarpet = await tx.carpet.delete({
            where: { id },
            include: { category: true },
          });
        } else {
          updatedCarpet = await tx.carpet.update({
            where: { id },
            data: updateData,
            include: { category: true },
          });

          if (targetStock > currentActiveCount) {
            const diff = targetStock - currentActiveCount;
            for (let i = 0; i < diff; i++) {
              const barcode = await this.generateUniqueBarcode();
              const sku = `SKU-${barcode}`;
              const sizeStr = firstItem?.size || '2x3';
              const wMm = firstItem?.widthMm || 2000;
              const lMm = firstItem?.lengthMm || 3000;
              const piecePrice =
                dto.price !== undefined
                  ? Number(dto.price)
                  : Number(updatedCarpet.price);

              await tx.inventoryItem.create({
                data: {
                  carpetId: id,
                  barcode,
                  sku,
                  widthMm: wMm,
                  lengthMm: lMm,
                  size: sizeStr,
                  piecePrice,
                  selectedArea: (wMm * lMm) / 1000000,
                  inventoryStatus: CarpetInventoryStatus.ACTIVE,
                },
              });
            }
          } else if (targetStock < currentActiveCount) {
            const diff = currentActiveCount - targetStock;
            const itemsToArchive = await tx.inventoryItem.findMany({
              where: {
                carpetId: id,
                inventoryStatus: CarpetInventoryStatus.ACTIVE,
              },
              take: diff,
            });
            const archiveIds = itemsToArchive.map((itm) => itm.id);
            await tx.inventoryItem.updateMany({
              where: { id: { in: archiveIds } },
              data: { inventoryStatus: CarpetInventoryStatus.ARCHIVED },
            });
          }
        }
      } else {
        updatedCarpet = await tx.carpet.update({
          where: { id },
          data: updateData,
          include: { category: true },
        });
      }

      const nextSize = normalizedData.size || dto.size;
      if (nextSize && existing.type !== 'ROLL' && updatedCarpet) {
        const nums =
          String(nextSize)
            .match(/(\d+(\.\d+)?)/g)
            ?.map(Number) || [];
        if (nums.length >= 2) {
          const widthMm = Math.round(nums[0] * 10);
          const lengthMm = Math.round(nums[1] * 10);
          await tx.inventoryItem.updateMany({
            where: {
              carpetId: id,
              inventoryStatus: CarpetInventoryStatus.ACTIVE,
            },
            data: {
              widthMm,
              lengthMm,
              size: nextSize,
              selectedArea: (widthMm * lengthMm) / 1000000,
            },
          });
        }
      }

      if (updatedCarpet) {
        await tx.inventoryLedger.create({
          data: {
            carpetId: id,
            quantity: stockDiff,
            action: 'MANUAL_UPDATE',
            reason:
              stockDiff !== 0
                ? `Stock adjusted by ${stockDiff} active pieces`
                : 'Carpet metadata properties updated',
            actor: actorId,
          },
        });
      }

      if (
        existing.type === 'ROLL' &&
        (rollDtoWidthCm !== undefined ||
          rollDtoOriginalLengthCm !== undefined ||
          rollDtoPricePerM2 !== undefined)
      ) {
        const primaryRoll = await tx.rollInventory.findFirst({
          where: { carpetId: id },
          orderBy: { createdAt: 'asc' },
        });
        if (primaryRoll) {
          await tx.rollInventory.update({
            where: { id: primaryRoll.id },
            data: {
              ...(rollDtoWidthCm !== undefined && { widthCm: rollDtoWidthCm }),
              ...(rollDtoOriginalLengthCm !== undefined && {
                originalLengthCm: rollDtoOriginalLengthCm,
                currentLengthCm: rollDtoOriginalLengthCm,
              }),
              ...(rollDtoPricePerM2 !== undefined && {
                pricePerM2: rollDtoPricePerM2,
              }),
            },
          });
        }
      }

      return updatedCarpet;
    });

    if (updated) {
      const isPrayer = updated.category?.name
        .toLowerCase()
        .includes(PRAYER_KEYWORD);
      if (!isPrayer && dto.price !== undefined && dto.stock !== 0) {
        await this.propagateCollectionM2Price({
          id: updated.id,
          name: updated.name,
          size: firstItem?.size || '0x0',
          price: updated.price,
        });
      }
    }

    this.invalidateFilterCache();
    return updated;
  }

  async remove(id: string) {
    await this.findOne(id);

    // Check if there are any RESERVED inventories (which are tied to active orders)
    const reservedCount = await this.prisma.inventoryItem.count({
      where: {
        carpetId: id,
        inventoryStatus: CarpetInventoryStatus.RESERVED,
      },
    });
    if (reservedCount > 0) {
      throw new BadRequestException(
        `Ushbu gilamda ${reservedCount} ta faol buyurtma qilingan (RESERVED) ombor yozuvi bor. Oldin ushbu buyurtmalarni hal qiling.`,
      );
    }

    // Automatically archive all ACTIVE inventory items for this carpet
    await this.prisma.inventoryItem.updateMany({
      where: {
        carpetId: id,
        inventoryStatus: CarpetInventoryStatus.ACTIVE,
      },
      data: {
        inventoryStatus: CarpetInventoryStatus.ARCHIVED,
      },
    });

    const result = await this.prisma.carpet.update({
      where: { id },
      data: { isArchived: true },
    });
    this.invalidateFilterCache();
    return result;
  }

  async getDistinctNames(kind?: string) {
    const andConditions: any[] = [
      {
        OR: [
          { description: null },
          { NOT: { description: { contains: METRAJ_TAG } } },
        ],
      },
    ];

    if (kind === 'prayer') {
      andConditions.push({
        category: {
          name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'oval') {
      andConditions.push({
        category: {
          name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'carpet') {
      andConditions.push({
        NOT: {
          category: {
            name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
          },
        },
      });
      andConditions.push({
        NOT: {
          category: {
            name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
          },
        },
      });
    }

    const rows = await this.prisma.carpet.findMany({
      where: { AND: andConditions },
      select: { name: true },
      orderBy: { name: 'asc' },
    });

    const grouped = new Map<string, string>();
    for (const row of rows) {
      const collectionName = this.extractCollectionName(row.name);
      const key = this.normalizeCollectionKey(collectionName);
      if (!key) continue;

      let displayName = collectionName;
      if (key === 'touch') {
        displayName = 'Touch';
      }

      if (grouped.has(key)) continue;
      grouped.set(key, displayName);
    }

    return Array.from(grouped.values()).sort((a, b) =>
      a.localeCompare(b, 'uz', { sensitivity: 'base' }),
    );
  }

  async getCollectionM2Price(name: string) {
    const sourceName = String(name ?? '').trim();
    if (!sourceName) {
      throw new BadRequestException('Gilam nomini kiriting.');
    }

    const collectionName = this.extractCollectionName(sourceName);
    const key = this.normalizeCollectionKey(collectionName);

    // 1. Check persistent DB CarpetName model
    const dbCarpetName = await this.prisma.carpetName.findFirst({
      where: {
        name: { mode: 'insensitive', equals: collectionName },
      },
    });

    if (dbCarpetName?.pricePerM2 && Number(dbCarpetName.pricePerM2) > 0) {
      const priceNum = Number(dbCarpetName.pricePerM2);
      this.collectionPriceOverrideMap.set(key, priceNum);
      return {
        found: true,
        collectionName: dbCarpetName.name,
        m2Price: priceNum,
        count: 1,
      };
    }

    // 2. Check in-memory map fallback
    if (this.collectionPriceOverrideMap.has(key)) {
      return {
        found: true,
        collectionName,
        m2Price: this.collectionPriceOverrideMap.get(key)!,
        count: 0,
      };
    }

    // 3. Calculate from existing carpets of that collection
    const carpets = await this.findCarpetsByCollectionKeys([key]);
    if (carpets.length > 0) {
      let sumM2 = 0;
      let validCount = 0;
      for (const carpet of carpets) {
        const area = this.parseAreaFromSize(carpet.size);
        const totalPrice = Number(carpet.price);
        if (
          !area ||
          area <= 0 ||
          !Number.isFinite(totalPrice) ||
          totalPrice <= 0
        ) {
          continue;
        }
        sumM2 += totalPrice / area;
        validCount += 1;
      }

      if (validCount > 0) {
        const calculatedPrice = Math.round((sumM2 / validCount) * 100) / 100;
        this.collectionPriceOverrideMap.set(key, calculatedPrice);
        return {
          found: true,
          collectionName,
          m2Price: calculatedPrice,
          count: validCount,
        };
      }
    }

    return {
      found: false,
      collectionName,
      m2Price: null,
      count: 0,
    };
  }

  async updateDiscountByNames(dto: UpdateCarpetDiscountDto) {
    const uniqueNames = Array.from(
      new Set(
        (dto.names ?? [])
          .map((value) => String(value ?? '').trim())
          .filter(Boolean)
          .map((value) => this.extractCollectionName(value)),
      ),
    );

    if (uniqueNames.length === 0) {
      throw new BadRequestException('Kamida bitta gilam nomini tanlang.');
    }

    const percent = Math.round(Number(dto.discountPercent));
    if (!Number.isFinite(percent)) {
      throw new BadRequestException("Skidka foizi noto'g'ri kiritildi.");
    }

    const discountPercent = Math.min(99, Math.max(0, percent));

    const keys = Array.from(
      new Set(
        uniqueNames
          .map((name) => this.normalizeCollectionKey(name))
          .filter(Boolean),
      ),
    );

    if (keys.length === 0) {
      throw new BadRequestException('Kamida bitta gilam nomini tanlang.');
    }

    const targetCarpets = await this.findCarpetsByCollectionKeys(keys);
    const standardizedCount =
      targetCarpets.length > 0
        ? await this.standardizeCollectionPricesByAverage(targetCarpets)
        : 0;

    const ids = targetCarpets.map((item) => item.id);
    const result =
      ids.length === 0
        ? { count: 0 }
        : await this.prisma.carpet.updateMany({
            where: { id: { in: ids } },
            data: { discountPercent },
          });

    return {
      discountPercent,
      updatedCount: result.count,
      names: uniqueNames,
      standardizedCount,
    };
  }

  async updateM2PriceByNames(dto: UpdateCarpetM2PriceDto) {
    const uniqueNames = Array.from(
      new Set(
        (dto.names ?? [])
          .map((value) => String(value ?? '').trim())
          .filter(Boolean)
          .map((value) => this.extractCollectionName(value)),
      ),
    );

    if (uniqueNames.length === 0) {
      throw new BadRequestException('Kamida bitta gilam nomini tanlang.');
    }

    const m2Price = Number(dto.m2Price);
    if (!Number.isFinite(m2Price) || m2Price <= 0) {
      throw new BadRequestException("m2 narxi noto'g'ri kiritildi.");
    }

    const keys = Array.from(
      new Set(
        uniqueNames
          .map((name) => this.normalizeCollectionKey(name))
          .filter(Boolean),
      ),
    );

    if (keys.length === 0) {
      throw new BadRequestException('Kamida bitta gilam nomini tanlang.');
    }

    for (const k of keys) {
      this.collectionPriceOverrideMap.set(k, m2Price);
    }

    // Persist to CarpetName DB table
    for (const colName of uniqueNames) {
      await this.prisma.carpetName.updateMany({
        where: { name: { mode: 'insensitive', equals: colName } },
        data: { pricePerM2: m2Price },
      });
    }

    const allCarpets = await this.prisma.carpet.findMany({
      where: { isArchived: false },
      include: {
        category: true,
        inventoryItems: {
          select: { size: true, widthMm: true, lengthMm: true },
        },
      },
    });

    const targetCarpets = allCarpets
      .map((c) => {
        let sizeStr = c.inventoryItems?.[0]?.size || (c as any).size || '';
        if (!sizeStr || sizeStr === '0x0') {
          const match = c.name.match(/\b\d+(\.\d+)?\s*[x×*]\s*\d+(\.\d+)?\b/i);
          if (match) sizeStr = match[0];
        }
        const widthMm =
          c.inventoryItems?.[0]?.widthMm || (c as any).widthMm || undefined;
        const lengthMm =
          c.inventoryItems?.[0]?.lengthMm || (c as any).lengthMm || undefined;
        return {
          ...c,
          size: sizeStr,
          widthMm,
          lengthMm,
        };
      })
      .filter((c) => {
        const colKey = this.normalizeCollectionKey(
          this.extractCollectionName(c.name),
        );
        return keys.includes(colKey);
      });

    const updates: any[] = [];

    for (const carpet of targetCarpets) {
      if (carpet.type === 'ROLL') {
        updates.push(
          this.prisma.carpet.update({
            where: { id: carpet.id },
            data: { price: m2Price },
          }),
        );
        updates.push(
          this.prisma.rollInventory.updateMany({
            where: { carpetId: carpet.id },
            data: { pricePerM2: m2Price },
          }),
        );
      } else {
        const area = this.parseAreaFromSize(
          carpet.size,
          carpet.widthMm,
          carpet.lengthMm,
        );
        if (!area || area <= 0) continue;

        const nextPrice = Math.round(m2Price * area);
        if (!Number.isFinite(nextPrice) || nextPrice <= 0) continue;

        updates.push(
          this.prisma.carpet.update({
            where: { id: carpet.id },
            data: { price: nextPrice },
          }),
        );

        updates.push(
          this.prisma.inventoryItem.updateMany({
            where: { carpetId: carpet.id },
            data: { piecePrice: nextPrice, pricePerM2: m2Price },
          }),
        );
      }
    }

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }

    return {
      m2Price: Math.round(m2Price * 100) / 100,
      updatedCount: updates.length,
      names: uniqueNames,
    };
  }

  private extractCollectionName(rawName: string): string {
    let source = String(rawName ?? '').trim();
    if (!source) return '';

    // Ignore 'oval' prefix/suffix so oval carpets map to the same collection
    source = source
      .replace(/\boval\b/gi, '')
      .trim()
      .replace(/\s+/g, ' ');

    const parts = source.split(' ');
    while (
      parts.length > 1 &&
      this.isLikelyDesignCodeToken(parts[parts.length - 1])
    ) {
      parts.pop();
    }

    return parts.join(' ').trim();
  }

  private isLikelyDesignCodeToken(rawToken: string): boolean {
    const token = String(rawToken ?? '').trim();
    if (!token) return false;

    const normalized = token.replace(/[^a-z0-9]/gi, '');
    if (!normalized || !/\d/.test(normalized)) return false;

    return /^[a-z]{0,4}\d{1,6}[a-z0-9]{0,4}$/i.test(normalized);
  }

  private normalizeCollectionKey(rawName: string): string {
    const name = String(rawName ?? '').trim();
    if (!name) return '';

    let words = name.split(/\s+/).filter(Boolean);
    if (
      words.length > 1 &&
      words[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === 'new'
    ) {
      words = words.slice(1);
    }

    const targetWord = words[0] || '';
    const key = targetWord
      .toLowerCase()
      .replace(/[\u2019'`"]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '')
      .trim();

    if (key === 'touch' || key.startsWith('touch')) {
      return 'touch';
    }
    return key;
  }

  private isOvalCategoryName(rawName?: string): boolean {
    return String(rawName ?? '')
      .toLowerCase()
      .includes(OVAL_KEYWORD);
  }

  private normalizeDesignCodeInternal(
    rawCode?: string | null,
  ): string | undefined {
    const trimmed = String(rawCode ?? '').trim();
    if (!trimmed) return undefined;
    return trimmed.toUpperCase();
  }

  private extractDesignCodeFromName(rawName?: string): string | undefined {
    const source = String(rawName ?? '').trim();
    if (!source) return undefined;

    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return undefined;

    const tail = parts[parts.length - 1].replace(/^#/, '');
    if (!this.isLikelyDesignCodeToken(tail)) return undefined;

    return this.normalizeDesignCodeInternal(tail);
  }

  private resolveDesignCode(
    rawCode?: string | null,
    rawName?: string | null,
  ): string | undefined {
    return (
      this.normalizeDesignCodeInternal(rawCode) ??
      this.extractDesignCodeFromName(rawName ?? undefined)
    );
  }

  private async findCarpetsByCollectionKeys(
    collectionKeys: string[],
    options?: { includePrayer?: boolean },
  ) {
    if (collectionKeys.length === 0) return [];

    const keySet = new Set(collectionKeys);
    const includePrayer = options?.includePrayer ?? false;
    const andConditions: any[] = [
      {
        OR: [
          { description: null },
          { NOT: { description: { contains: METRAJ_TAG } } },
        ],
      },
    ];

    if (!includePrayer) {
      andConditions.push({
        NOT: {
          category: {
            name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
          },
        },
      });
    }

    const rows = await this.prisma.carpet.findMany({
      where: { AND: andConditions },
      include: {
        inventoryItems: {
          select: { size: true },
        },
      },
    });

    const mapped = rows.map((row) => ({
      ...row,
      size: row.inventoryItems[0]?.size || '0x0',
    }));

    return mapped.filter((row) =>
      keySet.has(this.normalizeCollectionKey(row.name)),
    );
  }

  private async propagateCollectionM2Price(reference: {
    id: string;
    name: string;
    size: string;
    price: unknown;
  }): Promise<void> {
    const key = this.normalizeCollectionKey(reference.name);
    if (!key) return;

    const area = this.parseAreaFromSize(reference.size);
    const referencePrice = Number(reference.price);
    if (
      !area ||
      area <= 0 ||
      !Number.isFinite(referencePrice) ||
      referencePrice <= 0
    ) {
      return;
    }

    const m2Price = referencePrice / area;
    if (!Number.isFinite(m2Price) || m2Price <= 0) return;

    const allCarpets = await this.prisma.carpet.findMany({
      where: {
        isArchived: false,
        id: { not: reference.id },
      },
      include: {
        inventoryItems: { select: { size: true } },
      },
    });

    const targetCarpets = allCarpets
      .filter((c) => this.normalizeCollectionKey(c.name) === key)
      .map((c) => ({
        ...c,
        size: c.inventoryItems[0]?.size || '0x0',
      }));

    const updates: any[] = [];
    for (const c of targetCarpets) {
      if (c.type === 'ROLL') {
        updates.push(
          this.prisma.carpet.update({
            where: { id: c.id },
            data: { price: m2Price },
          }),
        );
        updates.push(
          this.prisma.rollInventory.updateMany({
            where: { carpetId: c.id },
            data: { pricePerM2: m2Price },
          }),
        );
      } else {
        const areaValue = this.parseAreaFromSize(c.size);
        if (!areaValue || areaValue <= 0) continue;

        const nextPrice = Math.round(m2Price * areaValue);
        const currentPrice = Math.round(Number(c.price));
        if (
          !Number.isFinite(nextPrice) ||
          nextPrice <= 0 ||
          nextPrice === currentPrice
        ) {
          continue;
        }

        updates.push(
          this.prisma.carpet.update({
            where: { id: c.id },
            data: { price: nextPrice },
          }),
        );
      }
    }

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }
  }

  private async standardizeCollectionPricesByAverage(
    carpets: Array<{ id: string; name: string; size: string; price: unknown }>,
  ): Promise<number> {
    if (carpets.length === 0) return 0;

    const grouped = new Map<
      string,
      Array<{ id: string; size: string; price: unknown }>
    >();

    for (const carpet of carpets) {
      const key = this.normalizeCollectionKey(carpet.name);
      if (!key) continue;
      const current = grouped.get(key) ?? [];
      current.push({ id: carpet.id, size: carpet.size, price: carpet.price });
      grouped.set(key, current);
    }

    const updates: any[] = [];

    for (const [, group] of grouped) {
      let sumM2Price = 0;
      let validCount = 0;

      for (const carpet of group) {
        const area = this.parseAreaFromSize(carpet.size);
        const currentPrice = Number(carpet.price);
        if (
          !area ||
          area <= 0 ||
          !Number.isFinite(currentPrice) ||
          currentPrice <= 0
        ) {
          continue;
        }
        sumM2Price += currentPrice / area;
        validCount += 1;
      }

      if (validCount === 0) continue;
      const avgM2Price = sumM2Price / validCount;

      for (const carpet of group) {
        const area = this.parseAreaFromSize(carpet.size);
        if (!area || area <= 0) continue;

        const nextPrice = Math.round(avgM2Price * area);
        const currentPrice = Math.round(Number(carpet.price));
        if (
          !Number.isFinite(nextPrice) ||
          nextPrice <= 0 ||
          nextPrice === currentPrice
        ) {
          continue;
        }

        updates.push(
          this.prisma.carpet.update({
            where: { id: carpet.id },
            data: { price: nextPrice },
          }),
        );
      }
    }

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }

    return updates.length;
  }

  private parseAreaFromSize(
    size?: string | null,
    widthMm?: number | null,
    lengthMm?: number | null,
  ): number | null {
    if (widthMm && lengthMm && widthMm > 0 && lengthMm > 0) {
      return (widthMm / 1000) * (lengthMm / 1000);
    }
    if (!size) return null;
    const normalized = size.toLowerCase().replace(/,/g, '.');
    const matches = normalized.match(/\d+(\.\d+)?/g);
    if (!matches || matches.length === 0) return null;

    const numbers = matches
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (numbers.length === 0) return null;

    if (numbers.length === 1) {
      const value = numbers[0];
      return value > 0 ? value : null;
    }

    let [rawA, rawB] = numbers;
    if (rawA >= 500) rawA = rawA / 1000;
    else if (rawA >= 20) rawA = rawA / 100;

    if (rawB >= 500) rawB = rawB / 1000;
    else if (rawB >= 20) rawB = rawB / 100;

    return rawA * rawB;
  }

  private normalizeCarpetData(dto: CreateCarpetDto | UpdateCarpetDto) {
    const updates: any = {};

    if (dto.name) {
      updates.name = dto.name.charAt(0).toUpperCase() + dto.name.slice(1);
    }

    const sizeVal = (dto as any).size;
    if (sizeVal) {
      const nums =
        String(sizeVal)
          .match(/(\d+(\.\d+)?)/g)
          ?.map(Number) || [];
      if (nums.length >= 2) {
        // Sort to ensure smaller dimension comes first
        nums.sort((a, b) => a - b);
        // Convert to cm if < 15 (assuming meters)
        const normalized = nums.map((n) => (n < 15 ? n * 100 : n));
        updates.size = `${normalized[0]}x${normalized[1]}`;
      }
    }

    return updates;
  }

  private async ensureCategoryExists(categoryId: string): Promise<{
    id: string;
    name: string;
  }> {
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true, name: true },
    });

    if (!category) {
      throw new NotFoundException('Kategoriya topilmadi.');
    }

    return category;
  }

  async getDiscountGroups() {
    const carpets = await this.prisma.carpet.findMany({
      where: {
        discountPercent: { gt: 0 },
        inventoryItems: {
          some: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
        },
      },
      select: {
        name: true,
        discountPercent: true,
      },
    });

    const groups = new Map<string, number>();
    for (const c of carpets) {
      groups.set(c.name, c.discountPercent);
    }

    return Array.from(groups.entries()).map(([name, discountPercent]) => ({
      name,
      discount: discountPercent,
    }));
  }

  async getMaterialByName(name: string) {
    const carpet = await this.prisma.carpet.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
      },
      select: {
        material: true,
      },
    });
    return { material: carpet?.material || '' };
  }

  async getUserById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async saveImportLog(dto: {
    fileName: string;
    fileHash?: string;
    userId?: string;
    userName: string;
    userEmail: string;
    importType: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    totalRows: number;
    successCount: number;
    duplicateCount: number;
    noImageCount: number;
    validationErrorCount: number;
    failedCount: number;
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
    errorFilePath?: string;
  }) {
    return this.prisma.importLog.create({
      data: {
        fileName: dto.fileName,
        fileHash: dto.fileHash || null,
        userId: dto.userId || null,
        userName: dto.userName,
        userEmail: dto.userEmail,
        importType: dto.importType || 'EXCEL',
        startedAt: new Date(dto.startedAt),
        finishedAt: new Date(dto.finishedAt),
        durationMs: dto.durationMs,
        totalRows: dto.totalRows,
        successCount: dto.successCount,
        duplicateCount: dto.duplicateCount,
        noImageCount: dto.noImageCount,
        validationErrorCount: dto.validationErrorCount,
        failedCount: dto.failedCount,
        status: dto.status,
        errorFilePath: dto.errorFilePath || null,
      },
    });
  }

  private parseDimensionToMm(val: any): number {
    if (val === undefined || val === null) return NaN;
    let clean = String(val)
      .trim()
      .toLowerCase()
      .replace(/\s/g, '')
      .replace(/,/g, '.');
    if (!clean) return NaN;

    const match = clean.match(/^([\d.]+)(mm|cm|m)?$/);
    if (!match) {
      const numVal = parseFloat(clean);
      if (isNaN(numVal)) return NaN;
      clean = String(numVal);
    }

    const parsedNum = parseFloat(clean);
    if (isNaN(parsedNum)) return NaN;

    if (clean.endsWith('mm')) {
      return Math.round(parsedNum);
    }
    if (clean.endsWith('cm')) {
      return Math.round(parsedNum * 10);
    }
    if (clean.endsWith('m') && !clean.endsWith('mm')) {
      return Math.round(parsedNum * 1000);
    }

    if (parsedNum < 15) {
      return Math.round(parsedNum * 1000);
    }
    if (parsedNum < 1000) {
      return Math.round(parsedNum * 10);
    }
    return Math.round(parsedNum);
  }

  async importBatch(
    dto: { type: string; items: any[]; mode?: 'skip' | 'update' },
    actorId = 'SYSTEM',
  ) {
    const { items, mode = 'update' } = dto;

    const validItems: any[] = [];
    const errors: { row: number; reason: string }[] = [];
    const seenBarcodes = new Set<string>();

    let duplicateCount = 0;
    let missingImageCount = 0;
    let validationErrorCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;

    const dbCategories = await this.prisma.category.findMany();
    const modernCategory =
      dbCategories.find((c) => c.name === 'Modern') || dbCategories[0];

    const categoryPrefixMap: any = {
      gold: 'Modern',
      steffano: 'Premium',
      trio: 'Modern',
      verona: 'Premium',
      mardin: 'Classic',
      zeugma: 'Oriental',
      eron: 'Modern',
      iran: 'Modern',
      silver: 'Minimal',
      diamond: 'Premium',
      antique: 'Classic',
      luna: 'Modern',
      touch: 'Premium',
      terra: 'Modern',
      orlando: 'Modern',
      fendi: 'Premium',
    };

    for (const item of items) {
      const rowNum = Number(item.__rowNum__) || 0;

      try {
        // Use the shared mapper to construct the DTO
        const createDto = buildCreateDto(item);

        // Check duplicates in the Excel file itself
        if (seenBarcodes.has(createDto.barcode!)) {
          errors.push({
            row: rowNum,
            reason: `Row ${rowNum} | Column: Коди | Original: "${createDto.barcode}" | Reason: Excel faylida takrorlangan code`,
          });
          duplicateCount++;
          continue;
        }
        seenBarcodes.add(createDto.barcode!);

        // Image Validation check from catalogDesign
        const catalogTypeForImport =
          createDto.type === CarpetType.ROLL ? 'ROLL' : 'READY';

        let catalogHit;
        try {
          catalogHit = await this.catalogDesignService.validateDesignCode(
            createDto.patternCode ||
              (createDto as any).designCode ||
              createDto.name ||
              'DEFAULT',
            catalogTypeForImport,
          );
        } catch (err) {
          const errMsg = err.message || '';
          const isMismatch = errMsg.includes('gilamga tegishli emas');
          const isMissing = errMsg.includes('rasm topilmadi');

          errors.push({
            row: rowNum,
            reason: `Row ${rowNum} | Column: Dizayn kodi | Original: "${createDto.patternCode}" | Reason: ${errMsg}`,
          });

          if (isMissing) {
            missingImageCount++;
          } else if (isMismatch) {
            validationErrorCount++;
          } else {
            skippedCount++;
          }
          continue;
        }

        createDto.images = [catalogHit.image];
        (createDto as any)._catalogDesignId = catalogHit.id;

        // Resolve category
        const slug = this.normalizeCollectionSlug(createDto.name);
        const categoryName = categoryPrefixMap[slug] || 'Modern';
        const dbCategory =
          dbCategories.find(
            (c) => c.name.toLowerCase() === categoryName.toLowerCase(),
          ) || modernCategory;
        createDto.categoryId = dbCategory?.id;

        // Resolve price if missing or invalid (e.g. from boolean column 'донабай' -> 'Да'/'Нет')
        const parsedPrice = Number(createDto.price);
        if (isNaN(parsedPrice) || parsedPrice <= 0) {
          if (createDto.productType === 'METRAJ') {
            createDto.price = 0;
          } else {
            const priceLookup = await this.getCollectionM2Price(createDto.name);
            if (priceLookup && priceLookup.found && priceLookup.m2Price) {
              const area = (createDto.widthMm * createDto.lengthMm) / 1000000;
              createDto.price = Math.round(area * priceLookup.m2Price);
            } else {
              // Fallback to default m2Price of 150,000 UZS
              const area = (createDto.widthMm * createDto.lengthMm) / 1000000;
              createDto.price = Math.round(area * 150000);
            }
          }
        }

        validItems.push({
          rowNum,
          dto: createDto,
        });
      } catch (err) {
        errors.push({
          row: rowNum,
          reason: `Row ${rowNum} | Reason: ${err.message || 'Validation failed'}`,
        });
        validationErrorCount++;
      }
    }

    let successCount = 0;

    if (validItems.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        let lastNum = await this.carpetsRepository.getLastCarpetNumber(tx);

        for (const validItem of validItems) {
          const { dto: itemDto, rowNum } = validItem;

          // Check duplicate code (barcode) in database
          const existingItem = await tx.inventoryItem.findUnique({
            where: { barcode: itemDto.barcode! },
            include: { carpet: true },
          });

          if (existingItem) {
            if (mode === 'skip') {
              errors.push({
                row: rowNum,
                reason: `Row ${rowNum} | Column: Коди | Original: "${itemDto.barcode!}" | Reason: code bazada allaqachon mavjud`,
              });
              skippedCount++;
              continue;
            } else {
              // mode is 'update' -> update existing records
              const carpet = existingItem.carpet;
              const updateData = {
                name: itemDto.name,
                patternCode: itemDto.patternCode,
                designCode: itemDto.patternCode,
                images: itemDto.images,
                productType: itemDto.productType,
                shape: itemDto.shape,
                categoryId: itemDto.categoryId || undefined,
                price: itemDto.price,
                weightKg: itemDto.weightKg,
                pileHeight: itemDto.pileHeight,
                catalogDesignId: itemDto._catalogDesignId,
                imageSnapshot: itemDto.images?.[0] ?? undefined,
              };

              await tx.carpet.update({
                where: { id: carpet.id },
                data: updateData,
              });

              if (carpet.type === 'ROLL') {
                const primaryRoll = await tx.rollInventory.findFirst({
                  where: { carpetId: carpet.id },
                  orderBy: { createdAt: 'asc' },
                });
                if (primaryRoll) {
                  await tx.rollInventory.update({
                    where: { id: primaryRoll.id },
                    data: {
                      widthCm: Math.round(itemDto.widthMm / 10),
                      originalLengthCm: Math.round(itemDto.lengthMm / 10),
                      currentLengthCm: Math.round(itemDto.lengthMm / 10),
                      pricePerM2: itemDto.price,
                    },
                  });
                }
              } else {
                await tx.inventoryItem.update({
                  where: { id: existingItem.id },
                  data: {
                    widthMm: itemDto.widthMm,
                    lengthMm: itemDto.lengthMm,
                    size: itemDto.size,
                    piecePrice: itemDto.price,
                    selectedArea:
                      (itemDto.widthMm * itemDto.lengthMm) / 1000000,
                  },
                });
              }

              // Create Ledger record
              await tx.inventoryLedger.create({
                data: {
                  carpetId: carpet.id,
                  quantity: 0,
                  action: 'EXCEL_IMPORT',
                  reason: 'Import update properties',
                  actor: actorId,
                },
              });

              successCount++;
              updatedCount++;
            }
          } else {
            // Check if there is an existing carpet with name + designCode
            let carpet = await tx.carpet.findFirst({
              where: {
                name: itemDto.name,
                designCode: itemDto.patternCode,
              },
            });

            if (!carpet) {
              lastNum++;
              const uniqueCode = `CARPET-${String(lastNum).padStart(6, '0')}`;
              carpet = await tx.carpet.create({
                data: {
                  uniqueCode,
                  name: itemDto.name,
                  patternCode: itemDto.patternCode,
                  designCode: itemDto.patternCode,
                  images: itemDto.images,
                  productType: itemDto.productType,
                  shape: itemDto.shape,
                  categoryId: itemDto.categoryId || null,
                  price: itemDto.price,
                  material: 'Acrylic + Polypropylene',
                  description: 'Yuqori sifatli va zamonaviy gilam.',
                  weightKg: itemDto.weightKg,
                  pileHeight: itemDto.pileHeight,
                  catalogDesignId: itemDto._catalogDesignId,
                  imageSnapshot: itemDto.images?.[0] ?? null,
                },
              });
            } else {
              // Update existing carpet fields
              await tx.carpet.update({
                where: { id: carpet.id },
                data: {
                  price: itemDto.price,
                  weightKg: itemDto.weightKg,
                  pileHeight: itemDto.pileHeight,
                  images: itemDto.images,
                  catalogDesignId: itemDto._catalogDesignId,
                  imageSnapshot: itemDto.images?.[0] ?? null,
                },
              });
            }

            if (itemDto.type === CarpetType.ROLL) {
              const widthCm = Math.round(itemDto.widthMm / 10);
              const existingRoll = await tx.rollInventory.findUnique({
                where: {
                  carpetId_widthCm: {
                    carpetId: carpet.id,
                    widthCm,
                  },
                },
              });

              if (existingRoll) {
                await tx.rollInventory.update({
                  where: { id: existingRoll.id },
                  data: {
                    originalLengthCm:
                      existingRoll.originalLengthCm +
                      Math.round(itemDto.lengthMm / 10),
                    currentLengthCm:
                      existingRoll.currentLengthCm +
                      Math.round(itemDto.lengthMm / 10),
                    pricePerM2: itemDto.price,
                  },
                });
              } else {
                await tx.rollInventory.create({
                  data: {
                    carpetId: carpet.id,
                    widthCm,
                    originalLengthCm: Math.round(itemDto.lengthMm / 10),
                    currentLengthCm: Math.round(itemDto.lengthMm / 10),
                    pricePerM2: itemDto.price,
                  },
                });
              }
            } else {
              await tx.inventoryItem.create({
                data: {
                  carpetId: carpet.id,
                  barcode: itemDto.barcode!,
                  sku: `SKU-${itemDto.barcode!}`,
                  widthMm: itemDto.widthMm,
                  lengthMm: itemDto.lengthMm,
                  size: itemDto.size!,
                  piecePrice: itemDto.price,
                  selectedArea: (itemDto.widthMm * itemDto.lengthMm) / 1000000,
                  inventoryStatus: 'ACTIVE',
                },
              });
            }

            // Create Ledger record
            await tx.inventoryLedger.create({
              data: {
                carpetId: carpet.id,
                quantity: 1,
                action: 'EXCEL_IMPORT',
                reason: 'Import creation stock',
                actor: actorId,
              },
            });

            successCount++;
          }
        }
      });
    }

    this.invalidateFilterCache();

    return {
      successCount,
      failedCount: errors.length,
      imported: successCount - updatedCount,
      updated: updatedCount,
      skipped: skippedCount + missingImageCount + validationErrorCount,
      duplicate: duplicateCount,
      missingImage: missingImageCount,
      validationErrors: validationErrorCount,
      errors: errors.sort((a, b) => a.row - b.row),
    };
  }

  async checkBarcodeExists(barcode: string): Promise<boolean> {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { barcode },
    });
    return !!item;
  }

  private cleanNameForFilter(name: string): string {
    if (!name) return '';
    let cleaned = name.trim();

    // Replace underscores and dashes with spaces
    cleaned = cleaned.replace(/[_-]+/g, ' ');
    // Remove duplicate spaces
    cleaned = cleaned.replace(/\s+/g, ' ');
    // Capitalize each word (Title Case)
    cleaned = cleaned
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    const lower = cleaned.toLowerCase();
    if (
      lower === 'iran soft' ||
      lower === 'eron soft' ||
      lower === 'iransoft' ||
      lower === 'eronsoft'
    ) {
      return 'Iran Soft';
    }
    return cleaned;
  }

  async getFilterNames(kind?: string): Promise<string[]> {
    const cacheKey = `filter:names:${kind || 'all'}`;
    const cached = this.cacheService.get<string[]>(cacheKey);
    if (cached) return cached;

    const andConditions: any[] = [
      {
        OR: [
          { description: null },
          { NOT: { description: { contains: METRAJ_TAG } } },
        ],
      },
    ];

    if (kind === 'prayer') {
      andConditions.push({
        category: {
          name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'oval') {
      andConditions.push({
        category: {
          name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'carpet') {
      andConditions.push(
        {
          NOT: {
            category: {
              name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
            },
          },
        },
        {
          NOT: {
            category: {
              name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
            },
          },
        },
      );
    }

    const carpets = await this.prisma.carpet.findMany({
      where: {
        isArchived: false,
        OR: [
          { type: { in: ['ROLL', 'RETURN_ROLL'] } },
          {
            type: { in: ['READY', 'RETURN_READY'] },
            OR: [
              {
                inventoryItems: {
                  some: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
                },
              },
              {
                inventoryItems: {
                  none: {},
                },
              },
            ],
          },
        ],
        AND: andConditions,
      },
      select: {
        name: true,
      },
      distinct: ['name'],
    });

    const uniqueNames = new Set<string>();
    for (const c of carpets) {
      const cleaned = this.cleanNameForFilter(c.name);
      if (cleaned) {
        uniqueNames.add(cleaned);
      }
    }

    const result = Array.from(uniqueNames).sort((a, b) => a.localeCompare(b));
    this.cacheService.set(cacheKey, result, 300);
    return result;
  }

  async getFilterMaterials(kind?: string): Promise<string[]> {
    const cacheKey = `filter:materials:${kind || 'all'}`;
    const cached = this.cacheService.get<string[]>(cacheKey);
    if (cached) return cached;

    const andConditions: any[] = [
      {
        OR: [
          { description: null },
          { NOT: { description: { contains: METRAJ_TAG } } },
        ],
      },
    ];

    if (kind === 'prayer') {
      andConditions.push({
        category: {
          name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'oval') {
      andConditions.push({
        category: {
          name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'carpet') {
      andConditions.push(
        {
          NOT: {
            category: {
              name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
            },
          },
        },
        {
          NOT: {
            category: {
              name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
            },
          },
        },
      );
    }

    const carpets = await this.prisma.carpet.findMany({
      where: {
        isArchived: false,
        OR: [
          { type: { in: ['ROLL', 'RETURN_ROLL'] } },
          {
            type: { in: ['READY', 'RETURN_READY'] },
            OR: [
              {
                inventoryItems: {
                  some: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
                },
              },
              {
                inventoryItems: {
                  none: {},
                },
              },
            ],
          },
        ],
        AND: andConditions,
      },
      select: {
        material: true,
      },
      distinct: ['material'],
    });

    const BASE_MATERIALS = [
      'akril',
      'polyester',
      'bahmal',
      'jun',
      'paxta',
      'ipak',
      'soft',
      'bambuk',
      'bamboo',
      'viskoza',
      'mikrofiber',
      "sun'iy",
      'polipropilen',
      'polypropylene',
    ];

    const uniqueBase = new Set<string>();
    for (const c of carpets) {
      if (!c.material) continue;
      const matLower = c.material.toLowerCase();
      for (const base of BASE_MATERIALS) {
        if (matLower.includes(base)) {
          const cap = base.charAt(0).toUpperCase() + base.slice(1);
          uniqueBase.add(cap);
        }
      }
    }

    const result = Array.from(uniqueBase).sort((a, b) => a.localeCompare(b));
    this.cacheService.set(cacheKey, result, 300);
    return result;
  }

  async getFilterSizes(kind?: string): Promise<string[]> {
    const cacheKey = `filter:sizes:${kind || 'all'}`;
    const cached = this.cacheService.get<string[]>(cacheKey);
    if (cached) return cached;

    const andConditions: any[] = [
      {
        OR: [
          { description: null },
          { NOT: { description: { contains: METRAJ_TAG } } },
        ],
      },
    ];

    if (kind === 'prayer') {
      andConditions.push({
        category: {
          name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'oval') {
      andConditions.push({
        category: {
          name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
        },
      });
    } else if (kind === 'carpet') {
      andConditions.push(
        {
          NOT: {
            category: {
              name: { contains: PRAYER_KEYWORD, mode: 'insensitive' as const },
            },
          },
        },
        {
          NOT: {
            category: {
              name: { contains: OVAL_KEYWORD, mode: 'insensitive' as const },
            },
          },
        },
      );
    }

    const activeItems = await this.prisma.inventoryItem.findMany({
      where: {
        inventoryStatus: CarpetInventoryStatus.ACTIVE,
        carpet: {
          isArchived: false,
          AND: andConditions,
        },
      },
      select: {
        size: true,
      },
      distinct: ['size'],
    });

    const STANDARD_SIZES = [
      '80x150',
      '100x200',
      '120x170',
      '160x230',
      '200x300',
      '240x340',
      '300x400',
    ];

    const sizeSet = new Set<string>();
    for (const item of activeItems) {
      if (item.size) sizeSet.add(item.size.trim());
    }
    if (sizeSet.size <= 1) {
      STANDARD_SIZES.forEach((s) => sizeSet.add(s));
    }

    const result = Array.from(sizeSet).sort((a, b) => a.localeCompare(b));
    this.cacheService.set(cacheKey, result, 300);
    return result;
  }

  private invalidateFilterCache() {
    const kinds = ['carpet', 'oval', 'prayer', 'all'];
    for (const k of kinds) {
      this.cacheService.delete(`filter:names:${k}`);
      this.cacheService.delete(`filter:materials:${k}`);
      this.cacheService.delete(`filter:sizes:${k}`);
    }
  }

  private getColumnValue(row: any, keys: string[]): any {
    if (!row || typeof row !== 'object') return undefined;
    const norm = (k: string) =>
      String(k)
        .trim()
        .toLowerCase()
        .replace(/[\s\-_''`'"]/g, '');
    const normalizedKeys = keys.map(norm);
    for (const k of Object.keys(row)) {
      if (normalizedKeys.includes(norm(k))) return row[k];
    }
    return undefined;
  }

  async getPredefinedNames() {
    const dbPredefined = await this.prisma.carpetName.findMany({
      orderBy: { name: 'asc' },
    });

    const carpets = await this.prisma.carpet.findMany({
      select: {
        name: true,
        designCode: true,
        images: true,
        categoryId: true,
        material: true,
        brand: true,
      },
    });

    const uniquePairs = new Map<
      string,
      {
        name: string;
        designCode: string;
        images: string[];
        categoryId: string | null;
        material: string;
        brand: string | null;
      }
    >();

    for (const c of carpets) {
      if (!c.name) continue;
      const collName = this.extractCollectionName(c.name);
      if (!collName) continue;

      let code = (c.designCode || '').trim();

      if (!code && c.images && c.images.length > 0) {
        for (const img of c.images) {
          if (typeof img !== 'string') continue;
          const basename = img.split('/').pop() || '';
          const nameWithoutExt = basename.split('.').shift() || '';
          const cleanCode = nameWithoutExt.trim();
          if (
            cleanCode &&
            cleanCode.toLowerCase() !== 'placeholder' &&
            cleanCode.toLowerCase() !== 'default' &&
            cleanCode.toLowerCase() !== 'carpet' &&
            cleanCode.toLowerCase() !== collName.toLowerCase() &&
            /^[a-zA-Z0-9]{2,15}$/.test(cleanCode)
          ) {
            code = cleanCode;
            break;
          }
        }
      }

      if (!code) continue;

      const key = `${collName.toLowerCase()}::${code.toLowerCase()}`;
      if (!uniquePairs.has(key)) {
        uniquePairs.set(key, {
          name: collName,
          designCode: code,
          images: c.images || [],
          categoryId: c.categoryId,
          material: c.material || '',
          brand: c.brand,
        });
      }
    }

    const result: any[] = [];

    const namesWithConcreteCodes = new Set<string>();
    for (const pair of uniquePairs.values()) {
      namesWithConcreteCodes.add(pair.name.toLowerCase());
    }

    for (const p of dbPredefined) {
      const isGeneric = p.designCode.toLowerCase() === p.name.toLowerCase();
      if (isGeneric && namesWithConcreteCodes.has(p.name.toLowerCase())) {
        continue;
      }
      result.push(p);
    }

    for (const pair of uniquePairs.values()) {
      result.push({
        id: `dynamic-${pair.name}-${pair.designCode}`,
        name: pair.name,
        designCode: pair.designCode,
        images: pair.images,
        categoryId: pair.categoryId,
        material: pair.material,
        brand: pair.brand,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const finalResult = result.map((item) => {
      const collectionKey = this.normalizeCollectionKey(item.name);
      const capitalized = collectionKey
        ? collectionKey.charAt(0).toUpperCase() + collectionKey.slice(1)
        : item.name;
      return {
        ...item,
        name: capitalized,
      };
    });

    return finalResult.sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name);
      if (nameCompare !== 0) return nameCompare;
      return a.designCode.localeCompare(b.designCode);
    });
  }

  async createPredefinedName(dto: {
    name: string;
    designCode: string;
    images: string[];
    categoryId?: string;
    material?: string;
    brand?: string;
    pricePerM2?: number;
  }) {
    const existing = await this.prisma.carpetName.findUnique({
      where: { name: dto.name },
    });
    if (existing) {
      throw new BadRequestException(
        'Ushbu gilam nomi tizimda allaqachon mavjud.',
      );
    }
    return this.prisma.carpetName.create({
      data: {
        name: dto.name,
        designCode: dto.designCode,
        images: dto.images,
        categoryId: dto.categoryId || null,
        material: dto.material || null,
        brand: 'YEC',
        pricePerM2:
          dto.pricePerM2 !== undefined && dto.pricePerM2 !== null
            ? dto.pricePerM2
            : null,
      },
    });
  }

  async updatePredefinedName(
    id: string,
    dto: {
      name?: string;
      designCode?: string;
      images?: string[];
      categoryId?: string;
      material?: string;
      brand?: string;
      pricePerM2?: number;
    },
  ) {
    if (id.startsWith('dynamic-')) {
      const parts = id.replace('dynamic-', '').split('-');
      const dynamicName = dto.name || parts[0] || 'Shablon';
      return this.prisma.carpetName.upsert({
        where: { name: dynamicName },
        update: {
          ...(dto.name ? { name: dto.name } : {}),
          ...(dto.designCode ? { designCode: dto.designCode } : {}),
          ...(dto.images ? { images: dto.images } : {}),
          ...(dto.categoryId !== undefined
            ? { categoryId: dto.categoryId || null }
            : {}),
          ...(dto.material !== undefined
            ? { material: dto.material || null }
            : {}),
          ...(dto.brand !== undefined ? { brand: dto.brand || null } : {}),
          ...(dto.pricePerM2 !== undefined
            ? { pricePerM2: dto.pricePerM2 }
            : {}),
        },
        create: {
          name: dynamicName,
          designCode: dto.designCode || dynamicName,
          images: dto.images || [],
          categoryId: dto.categoryId || null,
          material: dto.material || null,
          brand: dto.brand || 'YEC',
          pricePerM2: dto.pricePerM2 || null,
        },
      });
    }

    const existing = await this.prisma.carpetName.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Gilam shablon nomi topilmadi.');
    }

    if (dto.name && dto.name !== existing.name) {
      const duplicate = await this.prisma.carpetName.findUnique({
        where: { name: dto.name },
      });
      if (duplicate) {
        throw new BadRequestException(
          'Ushbu gilam nomi tizimda allaqachon mavjud.',
        );
      }
    }

    return this.prisma.carpetName.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.designCode ? { designCode: dto.designCode } : {}),
        ...(dto.images ? { images: dto.images } : {}),
        ...(dto.categoryId !== undefined
          ? { categoryId: dto.categoryId || null }
          : {}),
        ...(dto.material !== undefined
          ? { material: dto.material || null }
          : {}),
        ...(dto.brand !== undefined ? { brand: dto.brand || null } : {}),
        ...(dto.pricePerM2 !== undefined ? { pricePerM2: dto.pricePerM2 } : {}),
      },
    });
  }

  async deletePredefinedName(id: string) {
    if (id.startsWith('dynamic-')) {
      return {
        success: true,
        message: "Shablon nomi ro'yxatdan olib tashlandi.",
      };
    }

    const existing = await this.prisma.carpetName.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Gilam shablon nomi topilmadi.');
    }

    await this.prisma.carpetName.delete({ where: { id } });
    return {
      success: true,
      message: "Shablon nomi muvaffaqiyatli o'chirildi.",
    };
  }
}
