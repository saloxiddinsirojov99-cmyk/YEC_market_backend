import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderCronService } from './order-cron.service';
import { MailModule } from '../mail/mail.module';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReturnController } from './return.controller';
import { ReturnService } from './return.service';
import { AuditService } from './audit.service';
import { PaymentWebhookController } from './payment-webhook.controller';

import { DeliveryModule } from '../delivery/delivery.module';

@Module({
  imports: [
    MailModule,
    TelegramModule,
    NotificationsModule,
    InventoryModule,
    DeliveryModule,
  ],
  controllers: [OrdersController, ReturnController, PaymentWebhookController],
  providers: [OrdersService, OrderCronService, ReturnService, AuditService],
  exports: [AuditService],
})
export class OrdersModule {}
