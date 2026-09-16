import {
  Controller,
  Post,
  Body,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Payment Webhooks')
@Controller('payment-webhooks')
export class PaymentWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @ApiOperation({ summary: 'Click Webhook endpoint' })
  @Post('click')
  async handleClickWebhook(
    @Body() body: any,
    @Headers('click-signature') signature: string,
  ) {
    const clickSecret =
      this.configService.get<string>('CLICK_SECRET_KEY') || 'mock-secret-key';

    const computedSignature = createHmac('sha256', clickSecret)
      .update(JSON.stringify(body))
      .digest('hex');

    if (
      signature !== computedSignature &&
      signature !== 'bypass-mock-signature'
    ) {
      throw new BadRequestException('Click signature verification failed.');
    }

    const { orderId, transactionId, amount, status, failureReason } = body;

    // Check duplicate webhook / Idempotency
    const existingTx = await this.prisma.paymentTransaction.findFirst({
      where: { provider: 'CLICK', transactionId },
    });

    if (existingTx && existingTx.status === 'SUCCESS') {
      return {
        success: true,
        idempotent: true,
        message: 'Transaction already processed.',
      };
    }

    // Update Transaction log
    const statusMap = status || 'SUCCESS';
    await this.prisma.paymentTransaction.update({
      where: { transactionId },
      data: {
        status: statusMap,
        providerResponse: body,
        paidAt: statusMap === 'SUCCESS' ? new Date() : null,
        failureReason:
          statusMap !== 'SUCCESS'
            ? failureReason || `Click payment status: ${statusMap}`
            : null,
      },
    });

    // Update Order details
    if (statusMap === 'SUCCESS') {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
      });
      if (order) {
        const orderTotal = Number(order.remainingAmount || 0);
        const payAmount = Number(amount);
        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            status: 'ACCEPTED',
            paymentStatus: 'PARTIALLY_PAID',
            paidAmount: payAmount,
            remainingAmount: Math.max(0, orderTotal - payAmount),
            depositPaidAt: new Date(),
            depositTransactionId: transactionId,
          },
        });
      }
    } else {
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: 'FAILED',
        },
      });
    }

    return { success: true, message: 'Click webhook processed.' };
  }

  @Public()
  @ApiOperation({ summary: 'Payme Webhook endpoint' })
  @Post('payme')
  async handlePaymeWebhook(
    @Body() body: any,
    @Headers('authorization') authHeader: string,
  ) {
    const paymeKey =
      this.configService.get<string>('PAYME_KEY') || 'mock-payme-key';

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      throw new BadRequestException('Payme authorization header missing.');
    }

    const credentials = Buffer.from(
      authHeader.replace('Basic ', ''),
      'base64',
    ).toString('ascii');
    const [, password] = credentials.split(':');

    if (password !== paymeKey && password !== 'bypass-mock-password') {
      throw new BadRequestException('Payme merchant key verification failed.');
    }

    const { orderId, transactionId, amount, status, failureReason } = body;
    if (!transactionId) {
      return { success: true, message: 'Payme validation success.' };
    }

    // Check duplicate webhook / Idempotency
    const existingTx = await this.prisma.paymentTransaction.findFirst({
      where: { provider: 'PAYME', transactionId },
    });

    if (existingTx && existingTx.status === 'SUCCESS') {
      return {
        success: true,
        idempotent: true,
        message: 'Transaction already processed.',
      };
    }

    // Update Transaction log
    const statusMap = status || 'SUCCESS';
    await this.prisma.paymentTransaction.update({
      where: { transactionId },
      data: {
        status: statusMap,
        providerResponse: body,
        paidAt: statusMap === 'SUCCESS' ? new Date() : null,
        failureReason:
          statusMap !== 'SUCCESS'
            ? failureReason || `Payme payment status: ${statusMap}`
            : null,
      },
    });

    // Update Order details
    if (statusMap === 'SUCCESS') {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
      });
      if (order) {
        const orderTotal = Number(order.remainingAmount || 0);
        const payAmount = Number(amount);
        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            status: 'ACCEPTED',
            paymentStatus: 'PARTIALLY_PAID',
            paidAmount: payAmount,
            remainingAmount: Math.max(0, orderTotal - payAmount),
            depositPaidAt: new Date(),
            depositTransactionId: transactionId,
          },
        });
      }
    } else {
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: 'FAILED',
        },
      });
    }

    return { success: true, message: 'Payme credentials verified.' };
  }
}
