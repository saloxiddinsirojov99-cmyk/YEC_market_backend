import {
  Controller,
  Post,
  Get,
  Put,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { SimilarityService } from './services/similarity.service';
import { RecommendationService } from './services/recommendation.service';
import { AssistantService } from './services/assistant.service';
import { PreviewQueueProcessor } from './queue/preview-queue.processor';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';

@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly similarityService: SimilarityService,
    private readonly recommendationService: RecommendationService,
    private readonly assistantService: AssistantService,
    private readonly queueProcessor: PreviewQueueProcessor,
  ) {}

  /**
   * Returns ideal sizes and ranked carpets matching sizes.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Post('recommendations')
  async getRecommendations(@Body() body: any, @Req() req: any) {
    const { roomWidth, roomLength, selectedSizeLabel, roomStyle, roomColors } =
      body;
    if (!roomWidth || !roomLength) {
      throw new BadRequestException(
        "Xona o'lchamlari (roomWidth, roomLength) kiritilishi shart.",
      );
    }

    const sizes = this.recommendationService.recommendSizes(
      Number(roomWidth),
      Number(roomLength),
    );
    const activeSize =
      selectedSizeLabel ||
      (sizes.length > 0 ? sizes[0].sizeLabel : '2.5x3.5 sm');

    const role = req.user?.role || 'CUSTOMER';
    const isSeller = role === 'SELLER' || role === 'ADMIN';

    const carpets = await this.recommendationService.recommendCarpets(
      Number(roomWidth),
      Number(roomLength),
      activeSize,
      req.user?.sub,
      isSeller,
      roomStyle,
      roomColors,
    );

    return {
      sizes,
      selectedSizeLabel: activeSize,
      carpets,
    };
  }

  /**
   * Queues a room preview generation task.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Post('room-preview')
  async createRoomPreview(@Body() body: any, @Req() req: any) {
    const { carpetId, roomImage, roomWidth, roomLength, rotation } = body;
    if (!carpetId || !roomImage || !roomWidth || !roomLength) {
      throw new BadRequestException('Barcha maydonlar kiritilishi shart.');
    }

    // 1. Caching Check: hash(roomImage + width + length + carpetId + rotation)
    const normalizedRotation = rotation || 0;
    const cacheString = `${roomImage}-${roomWidth}-${roomLength}-${carpetId}-${normalizedRotation}`;
    const cacheKey = crypto
      .createHash('sha256')
      .update(cacheString)
      .digest('hex');

    const cachedPreview = await this.prisma.aiRoomPreview.findUnique({
      where: { cacheKey },
    });

    if (cachedPreview && cachedPreview.status === 'COMPLETED') {
      return {
        previewId: cachedPreview.id,
        status: 'CACHED',
        resultUrl: cachedPreview.generatedImage,
      };
    }

    // 2. Rate Limits Check (daily limit per role)
    const userId = req.user?.sub || 'anonymous';
    const settings = await this.prisma.aiSettings.findUnique({
      where: { id: 'singleton' },
    });

    const isGuest = userId === 'anonymous';
    const role = req.user?.role || 'GUEST';

    if (settings && settings.aiEnabled) {
      const dailyLimit =
        role === 'ADMIN'
          ? 99999
          : role === 'VIP'
            ? settings.dailyVipLimit
            : isGuest
              ? settings.dailyGuestLimit
              : settings.dailyUserLimit;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const count = await this.prisma.aiRoomPreview.count({
        where: {
          userId,
          createdAt: { gte: today },
          status: { not: 'FAILED' },
        },
      });

      if (count >= dailyLimit) {
        throw new ForbiddenException(
          isGuest
            ? "Mehmonlar uchun AI xizmati cheklangan. Iltimos ro'yxatdan o'ting."
            : `Siz bugungi kunlik limitni (${dailyLimit}) to'liq ishlatdingiz.`,
        );
      }
    }

    // 3. Create preview record
    const preview = await this.prisma.aiRoomPreview.create({
      data: {
        userId,
        carpetId,
        roomImage,
        roomWidth: Number(roomWidth),
        roomLength: Number(roomLength),
        cacheKey,
        status: 'QUEUED',
      },
    });

    // 4. Push job to queue
    await this.queueProcessor.addJob({
      previewId: preview.id,
      roomImage,
      carpetId,
      roomWidth: Number(roomWidth),
      roomLength: Number(roomLength),
    });

    return {
      previewId: preview.id,
      status: 'QUEUED',
    };
  }

  /**
   * Stream room preview generation status via Server-Sent Events (SSE).
   */
  @Get('room-preview/:id/stream')
  streamPreviewStatus(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    this.queueProcessor.registerClient(id, res);

    res.on('close', () => {
      this.queueProcessor.unregisterClient(id, res);
    });
  }

  /**
   * Check room preview generation status manually.
   */
  @Get('room-preview/:id/status')
  async getPreviewStatus(@Param('id') id: string) {
    const preview = await this.prisma.aiRoomPreview.findUnique({
      where: { id },
    });
    if (!preview) {
      throw new BadRequestException('Room preview topilmadi.');
    }
    return {
      id: preview.id,
      status: preview.status,
      resultUrl: preview.generatedImage,
      errorMessage: preview.errorMessage,
    };
  }

  /**
   * AI Visual Similarity search.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Post('visual-search')
  @UseInterceptors(FileInterceptor('file'))
  async visualSearch(
    @UploadedFile() file: Express.Multer.File,
    @Body('imageUrl') imageUrl: string,
    @Req() req: any,
  ) {
    let imageBuffer: Buffer;

    if (file) {
      imageBuffer = file.buffer;
    } else if (imageUrl) {
      try {
        const downloadRes = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
        });
        imageBuffer = Buffer.from(downloadRes.data);
      } catch (err) {
        throw new BadRequestException('Rasm URL manzilidan yuklanmadi.');
      }
    } else {
      throw new BadRequestException(
        'Rasm fayli yoki URL manzili taqdim etilishi shart.',
      );
    }

    const role = req.user?.role || 'CUSTOMER';
    const isSeller = role === 'SELLER' || role === 'ADMIN';

    const startTime = Date.now();
    // Perform visual similarity matching
    const matches = await this.similarityService.searchCatalog(imageBuffer, 15);
    const duration = Date.now() - startTime;

    // Enrich matching results with active database stock & WMS detail info
    const enrichedResults: any[] = [];
    for (const match of matches) {
      const dbCarpet = await this.prisma.carpet.findFirst({
        where: {
          name: match.collectionName,
          designCode: match.designCode,
          isArchived: false,
        },
        include: { rollInventories: true },
      });

      if (!dbCarpet) continue;

      const activeStock = await this.prisma.inventoryItem.count({
        where: { carpetId: dbCarpet.id, inventoryStatus: 'ACTIVE' },
      });

      let sellerWms: any = undefined;
      if (isSeller) {
        const position = await this.prisma.inventoryItem.findFirst({
          where: { carpetId: dbCarpet.id, inventoryStatus: 'ACTIVE' },
        });

        const reservedCount = await this.prisma.inventoryItem.count({
          where: { carpetId: dbCarpet.id, inventoryStatus: 'RESERVED' },
        });

        const rolls = await this.prisma.rollInventory.findMany({
          where: { carpetId: dbCarpet.id },
          select: { currentLengthCm: true },
        });
        const totalRollLength = rolls.reduce(
          (sum, r) => sum + r.currentLengthCm,
          0,
        );

        const marginValue = Math.round(Number(dbCarpet.price) * 0.35);
        const supplierName = dbCarpet.brand || 'Samarkand Carpet Factory';

        sellerWms = {
          warehouse: 'Asosiy Ombor',
          shelf: 'A-03-B-04',
          stock: activeStock,
          createdAt: dbCarpet.createdAt,
          margin: marginValue,
          purchaseDate: dbCarpet.createdAt,
          reserved: reservedCount,
          rollLength: totalRollLength,
          supplier: supplierName,
        };
      }

      enrichedResults.push({
        id: match.id,
        collectionName: match.collectionName,
        designCode: match.designCode,
        image: match.image,
        matchPercent: match.matchPercent,
        price: dbCarpet.price,
        stock: activeStock,
        wms: sellerWms,
      });
    }

    // Log to AiSearchLog asynchronously
    const userId = req.user?.sub || 'anonymous';
    this.prisma.aiSearchLog
      .create({
        data: {
          image:
            imageUrl ||
            (file ? 'file_upload:' + file.originalname : 'raw_buffer'),
          results: enrichedResults.slice(0, 10).map((r) => ({
            designCode: r.designCode,
            matchPercent: r.matchPercent,
          })),
          time: duration,
          user: role + ' (' + userId + ')',
        },
      })
      .catch((err) => {
        this.logger.error(`Failed to create AiSearchLog: ${err.message}`);
      });

    return {
      success: true,
      matches: enrichedResults,
    };
  }

  /**
   * AI assistant chatbot widget.
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Post('assistant')
  async chatAssistant(@Body('message') message: string, @Req() req: any) {
    if (!message) {
      throw new BadRequestException("Xabar bo'sh bo'lishi mumkin emas.");
    }
    return this.assistantService.processQuery(message, req.user?.sub);
  }

  /**
   * Global AI Settings singleton retrieval.
   */
  @Get('settings')
  async getSettings() {
    let settings = await this.prisma.aiSettings.findUnique({
      where: { id: 'singleton' },
    });
    if (!settings) {
      settings = await this.prisma.aiSettings.create({
        data: {
          id: 'singleton',
          provider: 'OPENAI',
          dailyGuestLimit: 0,
          dailyUserLimit: 5,
          dailyVipLimit: 20,
          aiEnabled: true,
        },
      });
    }
    return settings;
  }

  /**
   * Global AI Settings singleton update.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Put('settings')
  async updateSettings(@Body() body: any) {
    return this.prisma.aiSettings.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        ...body,
      },
      update: body,
    });
  }

  /**
   * Trigger bulk creation of missing visual signatures (Admin only).
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('bulk-footprints')
  async triggerBulkFootprints(@Body('force') force: boolean) {
    const count = await this.similarityService.bulkGenerateFootprints(force);
    return {
      success: true,
      processedCount: count,
    };
  }

  /**
   * Get recommendation settings (weights).
   */
  @Get('settings/recommendation')
  async getRecommendationSettings() {
    let settings = await this.prisma.recommendationSettings.findUnique({
      where: { id: 'singleton' },
    });
    if (!settings) {
      settings = await this.prisma.recommendationSettings.create({
        data: {
          id: 'singleton',
          roomWeight: 0.35,
          clearanceWeight: 0.25,
          colorWeight: 0.15,
          styleWeight: 0.1,
          fifoWeight: 0.1,
          popularityWeight: 0.05,
        },
      });
    }
    return settings;
  }

  /**
   * Update recommendation settings (weights) (Admin only).
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Put('settings/recommendation')
  async updateRecommendationSettings(@Body() body: any) {
    return this.prisma.recommendationSettings.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        ...body,
      },
      update: body,
    });
  }
}
