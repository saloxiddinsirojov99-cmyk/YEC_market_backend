import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProductType } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

@Injectable()
export class CatalogDesignService {
  private readonly logger = new Logger(CatalogDesignService.name);
  private readonly baseUrl = 'https://catalog.yec.uz';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Helper to normalize design code.
   */
  normalizeCode(code?: string | null): string {
    if (!code) return '';
    return String(code)
      .trim()
      .toUpperCase()
      .replace(/[\s\-_''`'"]/g, '');
  }

  /**
   * Determines if design code belongs to READY or ROLL.
   * If starting with 'L' -> ROLL.
   * Otherwise -> READY.
   */
  getDesignProductType(designCode: string): CatalogProductType {
    const code = this.normalizeCode(designCode);
    if (code.startsWith('L')) {
      return CatalogProductType.ROLL;
    }
    return CatalogProductType.READY;
  }

  /**
   * Safe fetch HTML with redirects support.
   */
  private fetchHtml(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const nextUrl = new URL(res.headers.location, url).toString();
            resolve(this.fetchHtml(nextUrl));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            res.resume();
            return;
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
  }

  /**
   * Safe file download.
   */
  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const nextUrl = new URL(res.headers.location, url).toString();
            resolve(this.downloadFile(nextUrl, dest));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            res.resume();
            return;
          }
          const fileStream = fs.createWriteStream(dest);
          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });
          fileStream.on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
          });
        })
        .on('error', reject);
    });
  }

  /**
   * Synchronize Catalog Design Codes.
   * Pulls live from catalog.yec.uz and resolves into local folder / database.
   */
  async syncCatalog(): Promise<{
    crawledCollections: number;
    newDesignsSynced: number;
    cleanedMismatches: number;
  }> {
    const collectionsDir = path.join(
      process.cwd(),
      '../front/public/images/collections',
    );
    const manifestPath = path.join(collectionsDir, 'manifest.json');

    // Create directories if they don't exist
    if (!fs.existsSync(collectionsDir)) {
      fs.mkdirSync(collectionsDir, { recursive: true });
    }

    let manifest: any = { collections: [], images: {}, materials: {} };
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        this.logger.error('Failed to parse manifest.json, starting fresh', err);
      }
    }

    manifest.collections = manifest.collections || [];
    manifest.images = manifest.images || {};
    manifest.materials = manifest.materials || {};

    let koverHtml = '';
    try {
      koverHtml = await this.fetchHtml(`${this.baseUrl}/type/kover/`);
    } catch (err) {
      this.logger.error('Failed to fetch type kover list page', err);
      throw new Error(`Catalog list is unreachable: ${err.message}`);
    }

    // Parse collections
    const collectionRegex =
      /<a href="\/collection\/([^/]+)\/" class="adi">([^<]+)<\/a>\s*<div class="ozellik">Yarn Type:\s*([^<]+)<\/div>/g;
    const crawledCollections: Array<{
      slug: string;
      name: string;
      yarn: string;
    }> = [];
    let match;
    while ((match = collectionRegex.exec(koverHtml))) {
      crawledCollections.push({
        slug: match[1].trim(),
        name: match[2].trim(),
        yarn: match[3].trim(),
      });
    }

    this.logger.log(
      `Found ${crawledCollections.length} collections in catalog.`,
    );

    const mergeRules: Record<string, { slug: string; name: string }> = {
      'touch-blue': { slug: 'touch', name: 'Touch' },
      'touch-gold': { slug: 'touch', name: 'Touch' },
      'new-luna': { slug: 'luna', name: 'Luna' },
      luna: { slug: 'luna', name: 'Luna' },
      trio: { slug: 'trio', name: 'Trio' },
      'trio-white': { slug: 'trio', name: 'Trio' },
    };

    let newDesignsSynced = 0;

    // Crawl each collection
    for (const coll of crawledCollections) {
      const collSlug = coll.slug.toLowerCase();
      const collName = coll.name;
      const target = mergeRules[collSlug] || { slug: collSlug, name: collName };

      const collectionUrl = `${this.baseUrl}/collection/${coll.slug}/?filter=static`;
      let collHtml = '';
      try {
        collHtml = await this.fetchHtml(collectionUrl);
      } catch (err) {
        this.logger.warn(
          `Failed to fetch collection: ${coll.slug}, skipping`,
          err,
        );
        continue;
      }

      // Parse images
      const imgRegex =
        /href="(\/media\/photos\/collections\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
      const imageLinks = new Set<string>();
      let imgMatch;
      while ((imgMatch = imgRegex.exec(collHtml))) {
        imageLinks.add(imgMatch[1]);
      }

      const targetDir = path.join(collectionsDir, target.slug);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      if (!manifest.images[target.slug]) manifest.images[target.slug] = {};
      if (!manifest.materials[target.slug] && coll.yarn) {
        manifest.materials[target.slug] = coll.yarn;
      }
      if (!manifest.collections.find((c: any) => c.slug === target.slug)) {
        manifest.collections.push({ name: target.name, slug: target.slug });
      }

      for (const link of imageLinks) {
        const fullUrl = `${this.baseUrl}${link}`;
        const fileName = path.basename(link);
        const ext = path.extname(fileName).toLowerCase();
        const rawCode = fileName.split('_')[0].replace(ext, '');
        const code = this.normalizeCode(rawCode);
        if (!code) continue;

        const targetType = this.getDesignProductType(code);
        const localFileName = `${code}${ext || '.jpg'}`;
        const localPath = path.join(targetDir, localFileName);
        const imagePath = `/images/collections/${target.slug}/${localFileName}`;

        // Ensure image is downloaded locally
        if (!fs.existsSync(localPath)) {
          try {
            await this.downloadFile(fullUrl, localPath);
            this.logger.log(`Downloaded image for ${code}: ${localFileName}`);
          } catch (err) {
            this.logger.error(`Failed to download: ${fullUrl}`, err);
            continue;
          }
        }

        // Write to manifest
        manifest.images[target.slug][code] = imagePath;

        // Upsert both READY and ROLL to CatalogDesign DB
        for (const targetType of [
          CatalogProductType.READY,
          CatalogProductType.ROLL,
        ]) {
          const existing = await this.prisma.catalogDesign.findUnique({
            where: {
              collectionSlug_designCode_productType: {
                collectionSlug: target.slug,
                designCode: code,
                productType: targetType,
              },
            },
          });

          if (!existing) {
            const stats = fs.statSync(localPath);
            await this.prisma.catalogDesign.create({
              data: {
                collectionName: target.name,
                collectionSlug: target.slug,
                collectionUrl: `${this.baseUrl}/collection/${coll.slug}/`,
                productType: targetType,
                designCode: code,
                patternCode: code,
                image: imagePath,
                originalImageUrl: fullUrl,
                pageUrl: collectionUrl,
                imageHash: 'SHA-256-PLACEHOLDER',
                imageSize: stats.size,
                storageProvider: 'LOCAL',
                isActive: true,
              },
            });
            newDesignsSynced++;
          }
        }
      }
    }

    // Save manifest file
    manifest.generatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return {
      crawledCollections: crawledCollections.length,
      newDesignsSynced,
      cleanedMismatches: 0,
    };
  }

  /**
   * Validation function for manual creation & update.
   */
  async validateDesignCode(
    designCode: string,
    carpetType: 'READY' | 'ROLL',
  ): Promise<any> {
    const code = this.normalizeCode(designCode);
    if (!code) {
      throw new BadRequestException('Gul/dizayn kodi kiritilishi shart.');
    }

    const typeEnum =
      carpetType === 'ROLL'
        ? CatalogProductType.ROLL
        : CatalogProductType.READY;

    const match = await this.prisma.catalogDesign.findFirst({
      where: {
        designCode: { equals: code, mode: 'insensitive' },
        productType: typeEnum,
        isActive: true,
      },
    });

    if (!match) {
      const otherMatch = await this.prisma.catalogDesign.findFirst({
        where: {
          designCode: { equals: code, mode: 'insensitive' },
          isActive: true,
        },
      });

      if (!otherMatch) {
        throw new BadRequestException(
          `Tanlangan dizayn kodi (${designCode}) katalogda topilmadi.`,
        );
      }

      if (carpetType === 'ROLL') {
        throw new BadRequestException(
          'Tanlangan dizayn kodi metraj gilamga tegishli emas.',
        );
      } else {
        throw new BadRequestException(
          'Tanlangan dizayn kodi tayyor gilamga tegishli emas.',
        );
      }
    }

    // Image presence verification
    if (!match.image) {
      throw new BadRequestException('Ushbu dizayn kodi uchun rasm topilmadi.');
    }

    // Verify local image file path exists
    const fullPath = path.join(process.cwd(), '../front/public', match.image);
    if (!fs.existsSync(fullPath)) {
      throw new BadRequestException('Ushbu dizayn kodi uchun rasm topilmadi.');
    }

    return match;
  }

  /**
   * Get design list with search and type filters.
   */
  async getCatalogDesigns(params: {
    type?: 'READY' | 'ROLL';
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = params.page || 1;
    const limit = params.limit || 100;
    const skip = (page - 1) * limit;

    const where: any = { isActive: true };

    if (params.type) {
      where.productType =
        params.type === 'ROLL'
          ? CatalogProductType.ROLL
          : CatalogProductType.READY;
    }

    if (params.search) {
      const q = params.search.trim();
      where.OR = [
        { designCode: { contains: q, mode: 'insensitive' } },
        { collectionName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.catalogDesign.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ collectionName: 'asc' }, { designCode: 'asc' }],
      }),
      this.prisma.catalogDesign.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
