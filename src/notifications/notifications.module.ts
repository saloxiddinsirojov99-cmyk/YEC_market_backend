import { Module } from '@nestjs/common';
import { PushNotificationService } from './push-notification.service';
import { SmsService } from './sms.service';
import { NotificationsController } from './notifications.controller';

@Module({
  providers: [PushNotificationService, SmsService],
  controllers: [NotificationsController],
  exports: [PushNotificationService, SmsService],
})
export class NotificationsModule {}
