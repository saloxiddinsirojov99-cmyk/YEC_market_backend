import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../cache/cache.service';
import sharp from 'sharp';

export interface VisualFootprint {
  hash: string;
  histogram: number[];
  edges: number[];
  clipEmbedding?: number[] | null;
}

interface CachedDesignFootprint {
  id: string;
  collectionName: string;
  designCode: string;
  productType: string;
  image: string;
  footprint: {
    hash: string;
    histogram: number[];
    edges: number[];
    clipEmbedding: number[] | null;
  };
  metadata: any;
}

@Injectable()
export class SimilarityService {
  private readonly logger = new Logger(SimilarityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Generates a visual footprint signature for a given image buffer or path.
   */
  async generateFootprint(
    imageInput: string | Buffer,
  ): Promise<VisualFootprint> {
    const rawImage = sharp(imageInput);

    // 1. Compute Perceptual/Average Hash (Grayscale 16x16)
    const grayscaleBuffer = await rawImage
      .clone()
      .resize(16, 16, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    let total = 0;
    for (let i = 0; i < grayscaleBuffer.length; i++) {
      total += grayscaleBuffer[i];
    }
    const average = total / grayscaleBuffer.length;

    let hashBits = '';
    for (let i = 0; i < grayscaleBuffer.length; i++) {
      hashBits += grayscaleBuffer[i] >= average ? '1' : '0';
    }

    // Convert bits to hex string
    let hashHex = '';
    for (let i = 0; i < hashBits.length; i += 4) {
      const chunk = hashBits.substring(i, i + 4);
      hashHex += parseInt(chunk, 2).toString(16);
    }

    // 2. Compute Color Histogram (RGBA downsampled, 4 bins per RGB channel = 64 bins total)
    const colorBuffer = await rawImage
      .clone()
      .resize(64, 64, { fit: 'fill' })
      .raw()
      .toBuffer();

    const histogram = new Array(64).fill(0);
    const totalPixels = colorBuffer.length / 4;

    for (let i = 0; i < colorBuffer.length; i += 4) {
      const r = colorBuffer[i];
      const g = colorBuffer[i + 1];
      const b = colorBuffer[i + 2];

      const binR = Math.min(Math.floor(r / 64), 3);
      const binG = Math.min(Math.floor(g / 64), 3);
      const binB = Math.min(Math.floor(b / 64), 3);

      const binIndex = binR * 16 + binG * 4 + binB;
      histogram[binIndex]++;
    }

    // Normalize histogram values
    const normalizedHistogram = histogram.map((count) => count / totalPixels);

    // 3. Compute Edge Distribution (Vertical & Horizontal Gradients on 16x16 grayscale)
    const edges = new Array(16).fill(0);
    for (let y = 1; y < 15; y++) {
      for (let x = 1; x < 15; x++) {
        const idx = y * 16 + x;

        // Sobel gradients
        const gx =
          -grayscaleBuffer[idx - 17] +
          grayscaleBuffer[idx - 15] -
          2 * grayscaleBuffer[idx - 1] +
          2 * grayscaleBuffer[idx + 1] -
          grayscaleBuffer[idx + 15] +
          grayscaleBuffer[idx + 17];

        const gy =
          -grayscaleBuffer[idx - 17] -
          2 * grayscaleBuffer[idx - 16] -
          grayscaleBuffer[idx - 15] +
          grayscaleBuffer[idx + 15] +
          2 * grayscaleBuffer[idx + 16] +
          grayscaleBuffer[idx + 17];

        const magnitude = Math.sqrt(gx * gx + gy * gy);
        const binIndex = Math.min(Math.floor(magnitude / 32), 15);
        edges[binIndex]++;
      }
    }

    // Normalize edge distribution values
    const totalEdges = edges.reduce((a, b) => a + b, 0) || 1;
    const normalizedEdges = edges.map((val) => val / totalEdges);

    return {
      hash: hashHex,
      histogram: normalizedHistogram,
      edges: normalizedEdges,
      clipEmbedding: null,
    };
  }

  /**
   * Computes Hamming Distance between two hex strings.
   * Returns a score between 0.0 (totally different) and 1.0 (identical).
   */
  computeHashSimilarity(hash1: string, hash2: string): number {
    if (hash1.length !== hash2.length) return 0;
    let matches = 0;
    const bits1 = this.hexToBits(hash1);
    const bits2 = this.hexToBits(hash2);

    for (let i = 0; i < bits1.length; i++) {
      if (bits1[i] === bits2[i]) {
        matches++;
      }
    }
    return matches / bits1.length;
  }

  private hexToBits(hex: string): string {
    let bits = '';
    for (let i = 0; i < hex.length; i++) {
      const val = parseInt(hex[i], 16);
      bits += val.toString(2).padStart(4, '0');
    }
    return bits;
  }

  /**
   * Computes Cosine Similarity between two numeric vectors.
   */
  cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Combines Hamming similarity, color histogram similarity, and edge similarity
   * into a final score (max 99%).
   */
  compareFootprints(
    fpA: VisualFootprint,
    fpB: {
      hash: string;
      histogram: number[];
      edges: number[];
      clipEmbedding: number[] | null;
    },
  ): number {
    const hashSim = this.computeHashSimilarity(fpA.hash, fpB.hash);
    const histSim = this.cosineSimilarity(fpA.histogram, fpB.histogram);
    const edgeSim = this.cosineSimilarity(fpA.edges, fpB.edges);

    let score = 0;
    if (fpB.clipEmbedding && fpA.clipEmbedding) {
      // Enterprise v3 Hybrid Search: 40% CLIP, 30% pHash, 20% Histogram, 10% Edges
      const clipSim = this.cosineSimilarity(
        fpA.clipEmbedding,
        fpB.clipEmbedding,
      );
      score = clipSim * 0.4 + hashSim * 0.3 + histSim * 0.2 + edgeSim * 0.1;
    } else {
      // Fallback weight distribution (50% pHash, 35% color histogram, 15% edges)
      score = hashSim * 0.5 + histSim * 0.35 + edgeSim * 0.15;
    }

    return Math.min(Math.floor(score * 100), 99);
  }

  /**
   * Searches YEC catalog for designs matching the query image with memory cache acceleration.
   * Performance target is <80ms for 6000+ items.
   */
  async searchCatalog(queryImageBuffer: Buffer, limit = 10): Promise<any[]> {
    const startTime = Date.now();

    // 1. Generate query image footprint
    const queryFootprint = await this.generateFootprint(queryImageBuffer);

    // 2. Fetch parsed design footprints from memory cache
    let cachedDesigns = await this.cacheService.get<CachedDesignFootprint[]>(
      'catalog_design_footprints',
    );

    if (!cachedDesigns) {
      this.logger.log('Footprints cache miss, loading from database...');
      const designs = await this.prisma.catalogDesign.findMany({
        where: { isActive: true },
        select: {
          id: true,
          collectionName: true,
          designCode: true,
          productType: true,
          image: true,
          phash: true,
          histogram: true,
          edges: true,
          metadata: true,
        },
      });

      cachedDesigns = designs
        .filter((d) => d.phash && d.histogram && d.edges)
        .map((d) => ({
          id: d.id,
          collectionName: d.collectionName,
          designCode: d.designCode,
          productType: d.productType,
          image: d.image,
          footprint: {
            hash: d.phash as string,
            histogram: d.histogram as number[],
            edges: d.edges as number[],
            clipEmbedding: null, // CLIP mapping placeholder
          },
          metadata: d.metadata,
        }));

      // Cache design footprints for 1 hour
      await this.cacheService.set(
        'catalog_design_footprints',
        cachedDesigns,
        3600,
      );
    }

    const matches: any[] = [];
    const designList = cachedDesigns || [];

    // 3. Compare visual signatures
    for (const design of designList) {
      const matchPercent = this.compareFootprints(
        queryFootprint,
        design.footprint,
      );

      matches.push({
        id: design.id,
        collectionName: design.collectionName,
        designCode: design.designCode,
        productType: design.productType,
        image: design.image,
        matchPercent,
        metadata: design.metadata,
      });
    }

    // 4. Sort matches by confidence descending
    matches.sort((a, b) => b.matchPercent - a.matchPercent);

    this.logger.log(
      `Visual search completed in ${Date.now() - startTime}ms. Checked ${designList.length} cached items.`,
    );

    return matches.slice(0, limit);
  }

  /**
   * Processes all active catalog designs without visual signatures and saves their footprints.
   */
  async bulkGenerateFootprints(force = false): Promise<number> {
    const designs = await this.prisma.catalogDesign.findMany({
      where: force ? {} : { phash: null },
    });

    this.logger.log(
      `Found ${designs.length} designs to compute footprints for.`,
    );
    let count = 0;

    for (const design of designs) {
      try {
        const resolvedPath = design.image.startsWith('/uploads')
          ? `.${design.image}`
          : design.image;

        const footprint = await this.generateFootprint(resolvedPath);

        await this.prisma.catalogDesign.update({
          where: { id: design.id },
          data: {
            phash: footprint.hash,
            histogram: footprint.histogram as any,
            edges: footprint.edges as any,
          },
        });
        count++;
      } catch (err) {
        this.logger.error(
          `Failed to generate footprint for CatalogDesign ${design.id} (image: ${design.image}): ${err.message}`,
        );
      }
    }

    if (count > 0) {
      // Invalidate footprints cache
      await this.cacheService.invalidate('catalog_design_footprints');
    }

    this.logger.log(
      `Successfully generated and stored ${count} visual footprints.`,
    );
    return count;
  }
}
