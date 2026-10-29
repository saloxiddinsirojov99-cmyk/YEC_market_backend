import {
  Controller,
  Post,
  Req,
  Res,
  Headers,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(private readonly telegramService: TelegramService) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-telegram-bot-api-secret-token') secretToken?: string,
  ) {
    try {
      await this.telegramService.handleWebhookUpdate(req.body, secretToken);
    } catch (err: any) {
      this.logger.error(`Webhook xatosi: ${err?.message || err}`);
    }
    return res.status(200).send('OK');
  }
}
