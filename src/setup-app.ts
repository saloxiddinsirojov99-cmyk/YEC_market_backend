import {
  BadRequestException,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { json, urlencoded } from 'express';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';

type ValidationErrorNode = {
  property: string;
  value?: any;
  constraints?: Record<string, string>;
  children?: ValidationErrorNode[];
};

const FIELD_LABELS: Record<string, string> = {
  email: 'Email',
  password: 'Parol',
  newPassword: 'Yangi parol',
  phone: 'Telefon raqam',
  firstName: 'Ism',
  lastName: 'Familiya',
  otp: 'Tasdiqlash kodi',
  name: 'Nomi',
  description: 'Tavsif',
  title: 'Sarlavha',
  image: 'Rasm',
  images: 'Rasmlar',
  price: 'Narx',
  discount: 'Chegirma',
  quantity: 'Miqdor',
  size: "O'lcham",
  material: 'Material',
  status: 'Holat',
  role: 'Rol',
  address: 'Manzil',
  lat: 'Kenglik',
  lng: 'Uzunlik',
  paymentType: "To'lov turi",
  comment: 'Izoh',
};

function prettifyField(path: string): string {
  const lastKey = path.split('.').pop() ?? path;
  const normalizedKey = lastKey.replace(/\[\d+\]/g, '');
  if (FIELD_LABELS[normalizedKey]) {
    return FIELD_LABELS[normalizedKey];
  }

  return normalizedKey
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function mapValidationMessage(fieldPath: string, constraint: string): string {
  const normalized = constraint.toLowerCase();
  const field = prettifyField(fieldPath);

  if (normalized.includes('should not exist')) {
    return `${field} maydoni ruxsat etilmagan.`;
  }
  if (normalized.includes('must not be empty')) {
    return `${field} maydoni bo'sh bo'lmasligi kerak.`;
  }
  if (normalized.includes('must be an email')) {
    return `${field} formati noto'g'ri.`;
  }
  if (normalized.includes('must be longer than or equal to')) {
    return `${field} maydoni juda qisqa.`;
  }
  if (normalized.includes('must be shorter than or equal to')) {
    return `${field} maydoni juda uzun.`;
  }
  if (normalized.includes('must be a string')) {
    return `${field} maydoni matn bo'lishi kerak.`;
  }
  if (normalized.includes('must be a number')) {
    return `${field} maydoni son bo'lishi kerak.`;
  }
  if (normalized.includes('must be a positive number')) {
    return `${field} maydoni 0 dan katta bo'lishi kerak.`;
  }
  if (normalized.includes('must be an integer number')) {
    return `${field} maydoni butun son bo'lishi kerak.`;
  }
  if (normalized.includes('must be one of')) {
    return `${field} maydoni ruxsat etilgan qiymatlardan biri bo'lishi kerak.`;
  }
  if (normalized.includes('must be a phone number')) {
    return `${field} formati noto'g'ri.`;
  }
  if (normalized.includes('array')) {
    return `${field} maydoni ro'yxat (array) bo'lishi kerak.`;
  }
  if (normalized.includes('date')) {
    return `${field} maydoni sana formatida bo'lishi kerak.`;
  }
  if (normalized.includes('boolean')) {
    return `${field} maydoni true/false qiymatda bo'lishi kerak.`;
  }
  if (normalized.includes('uuid')) {
    return `${field} maydoni UUID formatida bo'lishi kerak.`;
  }
  if (normalized.includes('nested property')) {
    return `${field} maydonida ichki ma'lumot xato yuborilgan.`;
  }

  const looksLikeDefaultConstraint =
    normalized.includes('must ') ||
    normalized.includes('should ') ||
    normalized.includes('is ') ||
    normalized.includes('each value in');

  if (!looksLikeDefaultConstraint) {
    return constraint;
  }

  return `${field} maydoni noto'g'ri to'ldirilgan.`;
}

function collectStructuredValidationErrors(
  errors: ValidationErrorNode[],
  parentPath = '',
): Array<{ field: string; message: string }> {
  const result: Array<{ field: string; message: string }> = [];

  for (const error of errors) {
    const fieldPath = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;

    if (error.constraints) {
      for (const rawMessage of Object.values(error.constraints)) {
        result.push({
          field: fieldPath,
          message: mapValidationMessage(fieldPath, rawMessage),
        });
      }
    }

    if (error.children && error.children.length > 0) {
      result.push(
        ...collectStructuredValidationErrors(error.children, fieldPath),
      );
    }
  }

  return result;
}

/**
 * Shared application setup for HTTP server, middleware, security, and Swagger.
 */
export function setupApp(app: INestApplication): void {
  // BigInt JSON serialization
  (BigInt.prototype as any).toJSON = function () {
    return Number(this);
  };

  app.use(cookieParser());
  app.use(json({ limit: '20mb' }));
  app.use(urlencoded({ limit: '20mb', extended: true }));
  app.enableShutdownHooks();

  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: '', method: RequestMethod.GET },
      { path: 'api/v1', method: RequestMethod.GET },
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'api/health', method: RequestMethod.GET },
    ],
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const allowedOrigins = frontendUrl
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Native mobile apps and server-to-server requests have no Origin header
      if (!origin) {
        return callback(null, true);
      }

      // Allowed origins from FRONTEND_URL env
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // In development, allow Expo Metro bundler and localhost
      if (!isProduction) {
        const isLocalDevOrigin =
          origin.startsWith('http://localhost:') ||
          origin.startsWith('http://127.0.0.1:') ||
          origin.startsWith('exp://');
        if (isLocalDevOrigin) {
          return callback(null, true);
        }
      }

      return callback(new Error('CORS tomonidan ruxsat etilmagan domen.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-skip-refresh',
      'x-csrf-token',
      'x-client-platform',
      'x-platform',
    ],
    exposedHeaders: ['Content-Disposition'],
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  app.use(compression());
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Global rate limit: 1000 req / 15 min
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 1000,
      message:
        "Juda ko'p so'rov yuborildi. Iltimos, birozdan so'ng qayta urinib ko'ring.",
    }),
  );

  // Stricter rate limits on auth endpoints
  app.use(
    '/api/v1/auth/login',
    rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      message:
        "Kirish urinishlari soni cheklangan. Iltimos, 1 daqiqadan so'ng qayta urinib ko'ring.",
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api/v1/auth/google/mobile',
    rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      message:
        "Google orqali kirish urinishlari soni cheklangan. Iltimos, 1 daqiqadan so'ng qayta urinib ko'ring.",
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api/v1/auth/refresh',
    rateLimit({
      windowMs: 60 * 1000,
      max: 20,
      message: "Refresh so'rovlari soni cheklangan.",
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api/v1/auth/register',
    rateLimit({
      windowMs: 60 * 1000,
      max: 5,
      message:
        "Ro'yxatdan o'tish urinishlari soni cheklangan. Iltimos, 1 daqiqadan so'ng qayta urinib ko'ring.",
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api/v1/auth/register/verify-otp',
    rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      message: 'Tasdiqlash kodini tekshirish soni cheklangan.',
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api/v1/auth/forgot-password',
    rateLimit({
      windowMs: 60 * 1000,
      max: 5,
      message: "Parolni tiklash so'rovlari soni cheklangan.",
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    '/api/v1/auth/forgot-password/reset',
    rateLimit({
      windowMs: 60 * 1000,
      max: 5,
      message: "Parolni o'zgartirish urinishlari soni cheklangan.",
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
  app.useGlobalInterceptors(new TimeoutInterceptor(requestTimeoutMs));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) => {
        const structuredErrors = collectStructuredValidationErrors(
          errors as ValidationErrorNode[],
        );

        return new BadRequestException({
          success: false,
          message:
            structuredErrors[0]?.message ??
            "So'rov ma'lumotlarida xatolik mavjud.",
          errors: structuredErrors,
        });
      },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('YEC Market API')
    .setDescription('Gilam savdosi uchun backend API hujjatlari')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}
