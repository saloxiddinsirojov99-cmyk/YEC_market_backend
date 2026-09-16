import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { diskStorage, memoryStorage } from 'multer';
import { extname, join } from 'path';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { resolveUploadsDir } from '../common/utils/uploads-path';

const UPLOADS_DIR = resolveUploadsDir();
mkdirSync(UPLOADS_DIR, { recursive: true });

function validateImageMagicBytes(
  buffer: Buffer,
): 'jpg' | 'png' | 'webp' | null {
  if (!buffer || buffer.length < 12) return null;

  // JPEG magic bytes: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }

  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // WEBP magic bytes: RIFF....WEBP
  const isRiff = buffer.toString('ascii', 0, 4) === 'RIFF';
  const isWebp = buffer.toString('ascii', 8, 12) === 'WEBP';
  if (isRiff && isWebp) {
    return 'webp';
  }

  return null;
}

@ApiTags('Upload')
@Controller('upload')
export class UploadController {
  constructor(private readonly prisma: PrismaService) {}

  @ApiOperation({ summary: 'Rasm yuklash (admin)' })
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
      required: ['file'],
    },
  })
  @ApiResponse({ status: 201, description: 'Rasm muvaffaqiyatli yuklandi.' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOADS_DIR,
        filename: (_req, file, cb) => {
          const extension = extname(file.originalname);
          cb(null, `${Date.now()}-${randomUUID()}${extension}`);
        },
      }),
      limits: {
        fileSize: 20 * 1024 * 1024,
      },
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowed.includes(file.mimetype)) {
          cb(
            new BadRequestException(
              'Faqat JPG, PNG va WEBP formatlari ruxsat etiladi.',
            ) as never,
            false,
          );
          return;
        }

        cb(null, true);
      },
    }),
  )
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException(
        'Fayl yuklanmadi. Iltimos, rasm faylini tanlang.',
      );
    }
    return {
      filename: file.filename,
      url: `/uploads/${file.filename}`,
    };
  }

  @ApiOperation({
    summary: 'Xaridor tomonidan buyurtmani qaytarish uchun rasm yuklash',
  })
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
      required: ['file'],
    },
  })
  @ApiResponse({
    status: 201,
    description: "Rasm muvaffaqiyatli yuklandi va buyurtmaga bog'landi.",
  })
  @UseGuards(JwtAuthGuard)
  @Post('return-image/:orderId')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
      },
      fileFilter: (_req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedMimes.includes(file.mimetype)) {
          cb(
            new BadRequestException(
              'Faqat JPG, PNG va WEBP formatlari ruxsat etiladi.',
            ) as never,
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadReturnImage(
    @Param('orderId') orderId: string,
    @CurrentUser() user: { sub: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException(
        'Fayl yuklanmadi. Iltimos, rasm faylini tanlang.',
      );
    }

    // 1. Order ownership and existence check
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Buyurtma topilmadi.');
    }

    if (order.customerId !== user.sub) {
      throw new ForbiddenException('Ushbu buyurtma sizga tegishli emas.');
    }

    // 2. Order status and 24-hour return deadline check
    if (order.status !== 'DELIVERED' && order.status !== 'RETURN_REQUESTED') {
      throw new BadRequestException(
        'Faqat yetkazib berilgan yoki qaytarish jarayonidagi buyurtmalar uchun rasm yuklash mumkin.',
      );
    }

    if (order.status === 'DELIVERED') {
      if (!order.deliveryCompletedAt) {
        throw new BadRequestException(
          'Buyurtmaning yetkazib berish sanasi tasdiqlanmagan.',
        );
      }
      const elapsedMs = Date.now() - order.deliveryCompletedAt.getTime();
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      if (elapsedMs > twentyFourHoursMs) {
        throw new BadRequestException('Qaytarish muddati (24 soat) tugagan.');
      }
    }

    // 3. Binary signature (Magic Bytes) check
    const detectedFormat = validateImageMagicBytes(file.buffer);
    if (!detectedFormat) {
      throw new BadRequestException(
        "Fayl formati noto'g'ri (haqiqiy rasm binary imzosi topilmadi).",
      );
    }

    // 4. Safe filename and path traversal prevention
    const sanitizedOrderId = orderId.replace(/[^a-zA-Z0-9_-]/g, '');
    const safeFilename = `return-${sanitizedOrderId}-${Date.now()}-${randomUUID()}.${detectedFormat}`;
    const targetPath = join(UPLOADS_DIR, safeFilename);

    // 5. Write file with orphan cleanup guard
    try {
      writeFileSync(targetPath, file.buffer);
    } catch {
      if (existsSync(targetPath)) {
        try {
          unlinkSync(targetPath);
        } catch {
          // ignore cleanup error
        }
      }
      throw new BadRequestException('Rasmni saqlashda xatolik yuz berdi.');
    }

    const fileUrl = `/uploads/${safeFilename}`;

    // 6. Link to existing returnRequest if already present
    try {
      const returnReq = await this.prisma.returnRequest.findUnique({
        where: { orderId },
      });
      if (returnReq) {
        await this.prisma.returnRequest.update({
          where: { orderId },
          data: {
            images: {
              push: fileUrl,
            },
          },
        });
      }
    } catch (dbError) {
      // Cleanup file if DB update fails
      if (existsSync(targetPath)) {
        try {
          unlinkSync(targetPath);
        } catch {
          // ignore cleanup error
        }
      }
      throw dbError;
    }

    return {
      filename: safeFilename,
      url: fileUrl,
    };
  }
}
