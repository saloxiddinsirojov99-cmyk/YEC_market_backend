import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PushNotificationService implements OnModuleInit {
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const publicKey = this.configService.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.configService.get<string>('VAPID_PRIVATE_KEY');
    let email = this.configService.get<string>('SMTP_USER') || 'admin@yec.uz';
    if (!email.startsWith('mailto:')) {
      email = `mailto:${email}`;
    }

    if (publicKey && privateKey) {
      webpush.setVapidDetails(email, publicKey, privateKey);
      this.logger.log('VAPID details set for Web Push');
    } else {
      this.logger.warn(
        'VAPID keys not found. Web Push notifications will not work.',
      );
    }
  }

  async sendNotification(
    userId: string,
    title: string,
    body: string,
    url?: string,
  ) {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });

    if (subscriptions.length === 0) {
      this.logger.verbose(`No push subscriptions for user ${userId}`);
      return;
    }

    const payload = JSON.stringify({
      notification: {
        title,
        body,
        icon: '/logo.png',
        data: { url },
      },
    });

    const tasks = subscriptions.map(async (sub) => {
      const pushConfig = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };

      try {
        await webpush.sendNotification(pushConfig, payload);
      } catch (error) {
        this.logger.error(
          `Error sending push to ${sub.endpoint}: ${error.message}`,
        );
        if (error.statusCode === 410 || error.statusCode === 404) {
          await this.prisma.pushSubscription.delete({ where: { id: sub.id } });
        }
      }
    });

    await Promise.all(tasks);
  }

  async notifyAdmins(title: string, body: string, url?: string) {
    const admins = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPERADMIN'] } },
      select: { id: true, email: true },
    });

    this.logger.log(
      `Notifying ${admins.length} admins via push: ${admins.map((a) => a.email).join(', ')}`,
    );

    await Promise.all(
      admins.map((admin) => this.sendNotification(admin.id, title, body, url)),
    );
  }
}
