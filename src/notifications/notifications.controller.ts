import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @ApiOperation({ summary: 'Subscribe to push notifications' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  async subscribe(@CurrentUser() user: any, @Body() subscription: any) {
    const userId = user.sub;
    const { endpoint, keys } = subscription;

    // Check if subscription already exists
    const existing = await this.prisma.pushSubscription.findUnique({
      where: { endpoint },
    });

    if (existing) {
      if (existing.userId !== userId) {
        await this.prisma.pushSubscription.update({
          where: { id: existing.id },
          data: { userId },
        });
      }
      return { success: true, message: 'Updated subscription' };
    }

    await this.prisma.pushSubscription.create({
      data: {
        userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
    });

    return { success: true };
  }
}
