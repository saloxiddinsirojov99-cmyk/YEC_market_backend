import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private token: string | null = null;
  private tokenExpiresAt: number | null = null;

  constructor(private readonly configService: ConfigService) {}

  private async getEskizToken(): Promise<string | null> {
    const email = this.configService.get<string>('ESKIZ_EMAIL');
    const password = this.configService.get<string>('ESKIZ_PASSWORD');

    if (!email || !password) {
      this.logger.warn(
        'ESKIZ_EMAIL yoki ESKIZ_PASSWORD sozlanmagan. SMSlar konsolga chiqariladi.',
      );
      return null;
    }

    // Check if token is still valid (Eskiz tokens are usually valid for 30 days)
    if (this.token && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    try {
      this.logger.log("Eskiz API tokenini olish uchun so'rov yuborilmoqda...");
      const response = await axios.post(
        'https://notify.eskiz.uz/api/auth/login',
        {
          email,
          password,
        },
      );

      if (response.data?.data?.token) {
        this.token = response.data.data.token as string;
        // Expire in 29 days to be safe
        this.tokenExpiresAt = Date.now() + 29 * 24 * 60 * 60 * 1000;
        return this.token;
      }
    } catch (error: any) {
      this.logger.error(`Eskiz auth xatosi: ${error.message}`, error.stack);
    }

    return null;
  }

  async sendSms(phone: string, message: string): Promise<boolean> {
    const formattedPhone = this.formatPhone(phone);
    this.logger.log(
      `SMS yuborilmoqda: [To: ${formattedPhone}] [Message: ${message}]`,
    );

    const token = await this.getEskizToken();
    if (!token) {
      this.logger.log(
        `[DEV/MOCK SMS] Phone: ${formattedPhone}, Text: ${message}`,
      );
      return true; // Mock send success
    }

    const from = this.configService.get<string>('ESKIZ_FROM') || '4546';

    try {
      const response = await axios.post(
        'https://notify.eskiz.uz/api/message/sms/send',
        {
          mobile_phone: formattedPhone.replace('+', ''),
          message,
          from,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (
        response.data?.status === 'waiting' ||
        response.data?.status === 'success'
      ) {
        this.logger.log(
          `SMS Eskiz orqali muvaffaqiyatli yuborildi. ID: ${response.data.id ?? 'unknown'}`,
        );
        return true;
      } else {
        this.logger.warn(
          `Eskiz javobi kutilmagan holatda: ${JSON.stringify(response.data)}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `SMS yuborishda xatolik (Eskiz API): ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`,
      );
    }

    return false;
  }

  private formatPhone(phone: string): string {
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('998') && cleaned.length === 12) {
      return `+${cleaned}`;
    }
    if (!cleaned.startsWith('+') && cleaned.length === 9) {
      return `+998${cleaned}`;
    }
    return cleaned;
  }
}
