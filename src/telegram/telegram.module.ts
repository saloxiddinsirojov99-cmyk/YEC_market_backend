import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegramUpdate } from './telegram.update';
import { TelegramService } from './telegram.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CarpetsModule } from '../carpets/carpets.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const isProduction =
          configService.get<string>('NODE_ENV') === 'production';
        const token = configService.get<string>('TELEGRAM_BOT_TOKEN');
        const enabled =
          configService.get<string>(
            'TELEGRAM_ENABLED',
            isProduction ? 'true' : 'false',
          ) === 'true';
        const allowLaunch =
          configService.get<string>(
            'TELEGRAM_LAUNCH',
            isProduction ? 'true' : 'false',
          ) === 'true';

        if (!enabled || !token) {
          return {
            token: token || 'NO_TOKEN',
            launchOptions: false,
          };
        }

        return {
          token,
          launchOptions: allowLaunch ? {} : false,
        };
      },
      inject: [ConfigService],
    }),
    PrismaModule,
    CarpetsModule,
    AiModule,
  ],
  providers: [TelegramUpdate, TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
