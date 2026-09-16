import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PushNotificationService } from '../notifications/push-notification.service';

@Injectable()
export class OrderCronService {
  private readonly logger = new Logger(OrderCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushNotificationService,
  ) {}

  // Har kuni soat 17:00 da ishlaydi
  @Cron('0 0 17 * * *')
  async handleDeliveryReminder() {
    this.logger.log('Yetkazib berish eslatmalari tekshirilmoqda...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const overdueOrders = await this.prisma.order.findMany({
      where: {
        status: { in: ['ACCEPTED', 'ON_WAY'] },
        deliveryDate: {
          lte: new Date(), // Bugun yoki undan oldingi sanalar
        },
      },
    });

    if (overdueOrders.length > 0) {
      this.logger.warn(
        `${overdueOrders.length} ta kechikkan buyurtma topildi.`,
      );

      await this.pushService.notifyAdmins(
        'Kechikkan buyurtmalar!',
        `${overdueOrders.length} ta buyurtma bugun soat 17:00 gacha yetkazilmadi. Iltimos, mijozlarga tushuntirish xabari yuboring.`,
        '/admin/orders',
      );
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleReturnDeadlineExpiration() {
    this.logger.log('Qaytarish muddatlari tekshirilmoqda...');

    const now = new Date();
    const expiredOrders = await this.prisma.order.findMany({
      where: {
        status: 'DELIVERED',
        returnDeadline: {
          lt: now,
        },
        returnRequest: null,
      },
    });

    if (expiredOrders.length > 0) {
      this.logger.log(
        `${expiredOrders.length} ta buyurtmaning qaytarish muddati tugadi. COMPLETED statusiga o'tkazilmoqda...`,
      );

      for (const order of expiredOrders) {
        try {
          await this.prisma.$transaction(async (tx) => {
            const fresh = await tx.order.findUnique({
              where: { id: order.id },
            });
            if (!fresh || fresh.status !== 'DELIVERED') return;

            await tx.order.update({
              where: { id: order.id, version: fresh.version },
              data: {
                status: 'COMPLETED',
                version: { increment: 1 },
              },
            });

            await tx.auditLog.create({
              data: {
                action: 'Order Auto Completed',
                who: 'SYSTEM',
                orderId: order.id,
                reason: 'Return deadline (24 hours) expired',
              },
            });
          });
        } catch (err) {
          this.logger.error(
            `Buyurtma #${order.id}ni avtomat yakunlashda xato: ${(err as Error).message}`,
          );
        }
      }
    }
  }
}
