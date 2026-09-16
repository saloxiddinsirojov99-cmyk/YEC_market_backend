import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AuthModule } from './auth/auth.module';
import { CarpetsModule } from './carpets/carpets.module';
import { CartModule } from './cart/cart.module';
import { CategoriesModule } from './categories/categories.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { UploadModule } from './upload/upload.module';
import { UsersModule } from './users/users.module';
import { TelegramModule } from './telegram/telegram.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { PromoCodesModule } from './promo-codes/promo-codes.module';
import { InventoryModule } from './inventory/inventory.module';
import { DeliveryModule } from './delivery/delivery.module';
import { CacheModule } from './cache/cache.module';
import { resolveUploadsDir } from './common/utils/uploads-path';
import { HealthController } from './health/health.controller';
import { AiModule } from './ai/ai.module';

const uploadsDir = resolveUploadsDir();

@Module({
  controllers: [AppController, HealthController],
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        join(process.cwd(), '.env'),
        join(__dirname, '..', '.env'),
        join(__dirname, '..', '..', '.env'),
      ],
    }),
    ServeStaticModule.forRoot({
      rootPath: uploadsDir,
      serveRoot: '/uploads',
    }),
    PrismaModule,
    UsersModule,
    AuthModule,
    CategoriesModule,
    CarpetsModule,
    OrdersModule,
    CartModule,
    UploadModule,
    TelegramModule,
    NotificationsModule,
    PromoCodesModule,
    InventoryModule,
    DeliveryModule,
    CacheModule,
    AiModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
