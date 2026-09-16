import { existsSync } from 'fs';
import { join } from 'path';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendOtpEmail(email: string, code: string): Promise<void> {
    const host = this.configService.get<string>('SMTP_HOST')?.trim();
    const port = Number(this.configService.get<string>('SMTP_PORT') ?? 587);
    const user = this.configService.get<string>('SMTP_USER')?.trim();
    const passRaw = this.configService.get<string>('SMTP_PASS');
    const pass = passRaw ? passRaw.replace(/\s+/g, '') : undefined;
    const from =
      this.configService.get<string>('SMTP_FROM') ?? 'no-reply@yecmarket.uz';

    if (!host || !user || !pass) {
      throw new InternalServerErrorException(
        "SMTP sozlamalari topilmadi. Email yuborib bo'lmadi.",
      );
    }

    const secure = port === 465;
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    const frontUrl = this.configService
      .get<string>('FRONTEND_URL')
      ?.replace(/\/+$/, '');
    const appUrl = this.configService
      .get<string>('APP_URL')
      ?.replace(/\/+$/, '');
    const logoUrl = frontUrl
      ? `${frontUrl}/logo.png`
      : appUrl
        ? `${appUrl}/logo.png`
        : null;

    const logoCandidatePaths = [
      join(process.cwd(), 'public', 'logo.png'),
      join(process.cwd(), 'logo.png'),
      join(process.cwd(), '..', 'front', 'public', 'logo.png'),
    ];
    const logoPath =
      logoCandidatePaths.find((path) => existsSync(path)) ?? null;
    const logoCid = 'yec-logo';

    const logoHtml = logoPath
      ? `<img src="cid:${logoCid}" alt="YEC Logo" style="width:44px;height:44px;object-fit:contain;display:block;border-radius:50%;background:#f1f5f9;padding:6px;" />`
      : logoUrl
        ? `<img src="${logoUrl}" alt="YEC Logo" style="width:44px;height:44px;object-fit:contain;display:block;border-radius:50%;background:#f1f5f9;padding:6px;" />`
        : `<div style="width:44px;height:44px;border-radius:50%;background:#0f172a;color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;letter-spacing:0.5px;">YEC</div>`;

    const html = `
      <div style="background:#f6f7fb;padding:24px;font-family:Arial,Helvetica,sans-serif;">
        <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
            ${logoHtml}
            <div>
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:3px;color:#64748b;">YEC Market</div>
              <div style="font-size:20px;font-weight:700;color:#0f172a;">Tasdiqlash kodi</div>
            </div>
          </div>
          <p style="margin:0 0 12px 0;color:#334155;font-size:14px;line-height:1.6;">
            Assalomu alaykum, ro'yxatdan o'tishni yakunlash uchun tasdiqlash kodini kiriting.
          </p>
          <div style="text-align:center;margin:22px 0;">
            <div style="display:inline-block;background:#0f172a;color:#ffffff;padding:12px 24px;border-radius:10px;font-size:22px;letter-spacing:6px;font-weight:700;">
              ${code}
            </div>
            <div style="margin-top:8px;color:#64748b;font-size:12px;">
              Kod 10 daqiqa amal qiladi.
            </div>
          </div>
          <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
            Agar bu siz bo'lmasangiz, xabarni e'tiborsiz qoldiring.
          </p>
        </div>
      </div>
    `;

    try {
      await transporter.sendMail({
        from,
        to: email,
        subject: 'YEC Market - Tasdiqlash kodi',
        html,
        attachments: logoPath
          ? [
              {
                filename: 'logo.png',
                path: logoPath,
                cid: logoCid,
              },
            ]
          : undefined,
      });
      this.logger.log(`Tasdiqlash kodi email yuborildi: ${email}`);
    } catch (error) {
      this.logger.error(
        `Tasdiqlash kodi email yuborishda xatolik: ${error?.message ?? "noma'lum xatolik"}`,
      );
      throw new InternalServerErrorException(
        'Tasdiqlash kodini emailga yuborishda xatolik yuz berdi.',
      );
    }
  }

  async sendOrderStatusEmail(
    email: string,
    customerName: string,
    orderNumber: string,
    status: string,
    deliveryDate?: string,
    explanation?: string,
  ): Promise<void> {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = Number(this.configService.get<string>('SMTP_PORT') ?? 587);
    const user = this.configService.get<string>('SMTP_USER');
    const passRaw = this.configService.get<string>('SMTP_PASS');
    const pass = passRaw ? passRaw.replace(/\s+/g, '') : undefined;
    const from =
      this.configService.get<string>('SMTP_FROM') ?? 'no-reply@yecmarket.uz';

    if (!host || !user || !pass) return;

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    const statusMap: Record<string, string> = {
      ACCEPTED: 'qabul qilindi',
      ON_WAY: "yo'lga chiqdi",
      DELIVERED: 'yetkazib berildi',
      CANCELLED: 'bekor qilindi',
    };

    const statusText = statusMap[status] || status;
    let detailsHtml = '';

    if (deliveryDate) {
      detailsHtml += `<p style="color:#0f172a;font-size:15px;"><b>Kutilayotgan yetkazib berish sanasi:</b> ${deliveryDate}</p>`;
    }
    if (explanation) {
      detailsHtml += `<p style="color:#d97706;font-size:14px;background:#fffbeb;padding:12px;border-radius:8px;border:1px solid #fef3c7;"><b>Xabar:</b> ${explanation}</p>`;
    }

    const html = `
      <div style="background:#f6f7fb;padding:30px;font-family:Arial,sans-serif;color:#334155;">
        <div style="max-width:550px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:30px;box-shadow:0 4px 12px rgba(0,0,0,0.03);">
          <h2 style="color:#0f172a;margin-top:0;">Buyurtma holati o'zgardi</h2>
          <p>Assalomu alaykum, <b>${customerName}</b>!</p>
          <p>Sizning <b>#${orderNumber}</b> raqamli buyurtmangiz holati <b>${statusText}</b> ga o'zgardi.</p>
          ${detailsHtml}
          <p style="margin-top:25px;font-size:13px;color:#94a3b8;">YEC Market - Sifat va qulaylik maskani.</p>
        </div>
      </div>
    `;

    try {
      await transporter.sendMail({
        from,
        to: email,
        subject: `Buyurtma holati: ${statusText} - YEC Market`,
        html,
      });
    } catch (error) {
      this.logger.error(`Status email error: ${error.message}`);
    }
  }

  async sendNewOrderNotification(
    adminEmail: string,
    orderData: any,
    pricing?: {
      totalOriginalAmount?: number;
      subtotalAfterCarpetDiscount?: number;
      totalAfterPromo?: number;
      productDiscountAmount?: number;
      promoDiscountAmount?: number;
      totalDiscountAmount?: number;
      totalDiscountPercent?: number;
    },
  ): Promise<void> {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = Number(this.configService.get<string>('SMTP_PORT') ?? 587);
    const user = this.configService.get<string>('SMTP_USER');
    const passRaw = this.configService.get<string>('SMTP_PASS');
    const pass = passRaw ? passRaw.replace(/\s+/g, '') : undefined;
    const from =
      this.configService.get<string>('SMTP_FROM') ?? 'no-reply@yecmarket.uz';

    if (!host || !user || !pass) return;

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    const itemsHtml = orderData.items
      .map(
        (item: any) => `
      <li>
        <b>${item.carpet.name}</b> - ${item.quantity} ta (${item.price.toLocaleString()} so'm)
      </li>
    `,
      )
      .join('');

    const html = `
      <h2>Yangi Buyurtma!</h2>
      <p><b>Mijoz:</b> ${orderData.customerName}</p>
      <p><b>Telefon:</b> ${orderData.phone}</p>
      <p><b>Ikkinchi telefon:</b> ${orderData.phone2 || '-'}</p>
      <p><b>Manzil:</b> ${orderData.address}</p>
      <p><b>Izoh:</b> ${orderData.comment || '-'}</p>
      <p><b>Promokod:</b> ${orderData.appliedPromoCode || '-'}</p>
      <p><b>Promo turi:</b> ${orderData.appliedPromoType || '-'}</p>
      ${orderData.appliedPromoType === 'DISCOUNT' ? `<p><b>Promo skidka:</b> -${orderData.appliedPromoPercent || 0}%</p>` : ''}
      ${orderData.appliedPromoType === 'GIFT' ? `<p><b>Sovg'a:</b> ${orderData.appliedPromoGiftName || 'Gilamcha'} (${Number(orderData.appliedPromoGiftPrice || 0).toLocaleString()} so'm)</p>` : ''}
      <p><b>Asl summa:</b> ${Number(pricing?.totalOriginalAmount ?? 0).toLocaleString()} so'm</p>
      <p><b>Mahsulot skidkasi:</b> ${Number(pricing?.productDiscountAmount ?? 0).toLocaleString()} so'm</p>
      <p><b>Promokod skidkasi:</b> ${Number(pricing?.promoDiscountAmount ?? 0).toLocaleString()} so'm</p>
      <p><b>Umumiy skidka:</b> ${Number(pricing?.totalDiscountAmount ?? 0).toLocaleString()} so'm (${Number(pricing?.totalDiscountPercent ?? 0).toFixed(2)}%)</p>
      <hr/>
      <h3>Mahsulotlar:</h3>
      <ul>${itemsHtml}</ul>
      <p><b>Jami:</b> ${Number(pricing?.totalAfterPromo ?? orderData.items.reduce((sum: number, i: any) => sum + Number(i.price) * i.quantity, 0)).toLocaleString()} so'm</p>
    `;

    try {
      await transporter.sendMail({
        from,
        to: adminEmail,
        subject: 'Yangi Buyurtma - YEC Market',
        html,
      });
    } catch (error) {
      this.logger.error(`Admin order email error: ${error.message}`);
    }
  }
}
