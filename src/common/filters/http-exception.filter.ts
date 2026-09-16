import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Serverda kutilmagan xatolik yuz berdi.';
    let errors: string[] | undefined;

    let customExtraProps: Record<string, any> = {};

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = this.mapPrismaKnownError(exception.code, exception.meta);
      status = mapped.status;
      message = mapped.message;
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = "So'rov ma'lumotlari formatida xatolik bor.";
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = "Ma'lumotlar bazasiga ulanishda xatolik yuz berdi.";
    } else if (exception instanceof MulterError) {
      status = HttpStatus.BAD_REQUEST;
      message = this.mapMulterError(exception.code);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = this.translateMessage(res);
      } else if (typeof res === 'object' && res !== null) {
        const responseObj = res as Record<string, any>;

        if (Array.isArray(responseObj.message)) {
          errors = responseObj.message.map((m) => this.translateMessage(m));
          message = errors[0] ?? "So'rovda xatolik mavjud.";
        } else if (typeof responseObj.message === 'string') {
          message = this.translateMessage(responseObj.message);
        }

        if (Array.isArray(responseObj.errors)) {
          errors = responseObj.errors.map((m) => this.translateMessage(m));
        }

        const {
          message: _m,
          statusCode: _s,
          error: _e,
          errors: _errs,
          ...extra
        } = responseObj;
        customExtraProps = extra;
      }
    } else if (exception instanceof Error) {
      message = this.translateMessage(exception.message);
      this.logger.error(`Error: ${exception.message}`, exception.stack);
    } else {
      this.logger.error('Kutilmagan xatolik:', String(exception));
    }

    if (host.getType() !== 'http') {
      this.logger.error(
        `Exception in non-HTTP context (${host.getType()}): ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      return;
    }

    const ctx = host.switchToHttp();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response = ctx.getResponse();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const request = ctx.getRequest();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      errors: errors || [],
      timestamp: new Date().toISOString(),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      path: request.url,
      ...customExtraProps,
    });
  }

  private mapPrismaKnownError(
    code: string,
    meta?: Record<string, any>,
  ): {
    status: number;
    message: string;
  } {
    if (code === 'P2002') {
      const targetStr = String(meta?.target || '').toLowerCase();
      if (targetStr.includes('phone')) {
        return {
          status: HttpStatus.CONFLICT,
          message:
            'Ushbu telefon raqami bazada allaqachon mavjud. Iltimos, boshqa telefon raqami kiriting.',
        };
      }
      if (targetStr.includes('email')) {
        return {
          status: HttpStatus.CONFLICT,
          message:
            'Ushbu email manzili bazada allaqachon mavjud. Iltimos, boshqa email kiriting.',
        };
      }
      if (
        targetStr.includes('barcode') ||
        targetStr.includes('sku') ||
        targetStr.includes('code')
      ) {
        return {
          status: HttpStatus.CONFLICT,
          message:
            'Bunday shtrix-kod yoki noyob kod bazada allaqachon mavjud. Iltimos, boshqa kod kiriting.',
        };
      }
      return {
        status: HttpStatus.CONFLICT,
        message:
          "Bunday ma'lumot bazada allaqachon mavjud. Iltimos, boshqa qiymat kiriting.",
      };
    }

    if (code === 'P2025') {
      return {
        status: HttpStatus.NOT_FOUND,
        message: "Tahrirlanmoqchi bo'lgan ma'lumot tizimda topilmadi.",
      };
    }

    if (code === 'P2003') {
      return {
        status: HttpStatus.BAD_REQUEST,
        message:
          "Tizimda mos keluvchi bog'liq ma'lumot topilmadi (masalan, noto'g'ri kategoriya ID).",
      };
    }

    if (code === 'P2014') {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Relation chekloviga zid amal bajarildi.',
      };
    }

    return {
      status: HttpStatus.BAD_REQUEST,
      message: "Ma'lumotlar bazasida xatolik yuz berdi.",
    };
  }

  private mapMulterError(code: string): string {
    if (code === 'LIMIT_FILE_SIZE') {
      return 'Fayl hajmi juda katta.';
    }

    if (code === 'LIMIT_UNEXPECTED_FILE') {
      return "Fayl maydoni noto'g'ri yuborildi.";
    }

    return 'Fayl yuklashda xatolik yuz berdi.';
  }

  private translateMessage(message: any): string {
    if (!message) return "So'rovda xatolik yuz berdi.";
    if (typeof message !== 'string') {
      if (typeof message === 'object') {
        if (typeof message.message === 'string') {
          return this.translateMessage(message.message);
        }
        if (message.constraints && typeof message.constraints === 'object') {
          const firstConstraint = Object.values(message.constraints)[0];
          if (typeof firstConstraint === 'string') {
            return this.translateMessage(firstConstraint);
          }
        }
        return "So'rovda xatolik yuz berdi.";
      }
      message = String(message);
    }

    const normalized = message.toLowerCase();

    if (normalized.includes('unauthorized'))
      return 'Avtorizatsiya talab qilinadi.';
    if (normalized.includes('forbidden')) return 'Bu amal uchun ruxsat yo`q.';
    if (normalized.includes('validation failed'))
      return "So'rov ma'lumotlari noto'g'ri.";
    if (normalized.includes('cannot get'))
      return "So'ralgan endpoint topilmadi.";
    if (normalized.includes('not found'))
      return "So'ralgan ma'lumot topilmadi.";
    if (normalized.includes('route not found'))
      return "So'ralgan endpoint topilmadi.";
    if (normalized.includes('invalid credentials'))
      return "Email yoki parol noto'g'ri.";
    if (normalized.includes('invalid token'))
      return "Token noto'g'ri yoki muddati tugagan.";
    if (normalized.includes('jwt expired')) return 'Token muddati tugagan.';
    if (normalized.includes('jwt malformed')) return "Token formati noto'g'ri.";
    if (normalized.includes('invalid signature'))
      return "Token imzosi noto'g'ri.";
    if (normalized.includes('no auth token')) return 'Token topilmadi.';
    if (normalized.includes('file too large')) return 'Fayl hajmi juda katta.';
    if (normalized.includes('unexpected field'))
      return "So'rov maydonlari noto'g'ri yuborildi.";
    if (normalized.includes('request entity too large'))
      return 'Yuborilgan ma`lumot hajmi juda katta.';
    if (normalized.includes('should not exist'))
      return 'Ruxsat etilmagan maydon yuborildi.';
    if (normalized.includes('must be'))
      return "Maydon qiymati noto'g'ri formatda yuborildi.";
    if (normalized.includes('required'))
      return "Majburiy maydon to'ldirilmagan.";
    if (normalized.includes('failed to parse'))
      return "Yuborilgan ma'lumotni o'qib bo'lmadi.";
    if (normalized.includes('jwt'))
      return "Token noto'g'ri yoki muddati tugagan.";

    return message;
  }

  private isLikelyUzbek(message: string): boolean {
    const normalized = message.toLowerCase();
    const uzbekHints = [
      "bo'l",
      "yo'q",
      'noto',
      'xatolik',
      'topilmadi',
      'mavjud',
      'ruxsat',
      'so`rov',
      "so'rov",
      'token',
      'parol',
      'email',
      'maydon',
      'foydalanuvchi',
      'buyurtma',
      'gilam',
      'kategoriya',
      'profil',
    ];

    return uzbekHints.some((hint) => normalized.includes(hint));
  }
}
