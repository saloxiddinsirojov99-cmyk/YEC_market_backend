import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LoyaltyStatus,
  Prisma,
  RegistrationType,
  User,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../notifications/sms.service';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
  ) {}

  async findAll(query: {
    search?: string;
    loyaltyStatus?: string;
    registrationType?: string;
    page?: number;
    limit?: number;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {
      role: UserRole.CUSTOMER,
    };

    if (query.search?.trim()) {
      const search = query.search.trim();
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (query.loyaltyStatus) {
      where.loyaltyStatus = query.loyaltyStatus as LoyaltyStatus;
    }

    if (query.registrationType) {
      where.registrationType = query.registrationType as RegistrationType;
    }

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const customer = await this.prisma.user.findUnique({
      where: { id },
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            createdAt: true,
            status: true,
            paidAmount: true,
            remainingAmount: true,
          },
        },
      },
    });

    if (!customer || customer.role !== UserRole.CUSTOMER) {
      throw new NotFoundException('Mijoz topilmadi.');
    }

    return customer;
  }

  async lookupByPhone(phone: string) {
    if (!phone || !phone.trim()) {
      throw new BadRequestException('Telefon raqami kiritilishi shart.');
    }
    const cleanPhone = phone.trim();
    const customer = await this.prisma.user.findUnique({
      where: { phone: cleanPhone },
      include: {
        orders: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            createdAt: true,
            status: true,
            paidAmount: true,
            remainingAmount: true,
          },
        },
      },
    });

    return {
      exists: !!customer,
      customer: customer || null,
    };
  }

  async register(dto: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
    notes?: string;
    birthDate?: string;
    telegramUsername?: string;
    registrationType?: RegistrationType;
  }) {
    const phone = dto.phone.trim();
    const name = dto.name.trim();

    if (!name || !phone) {
      throw new BadRequestException('Ism va telefon raqami majburiy.');
    }

    const existing = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (existing) {
      throw new ConflictException({
        message: 'Ushbu telefon raqamga ega mijoz allaqachon mavjud.',
        existingCustomer: existing,
      });
    }

    let parsedBirthDate: Date | null = null;
    if (dto.birthDate) {
      parsedBirthDate = new Date(dto.birthDate);
      if (isNaN(parsedBirthDate.getTime())) {
        throw new BadRequestException("Tug'ilgan sana noto'g'ri formatda.");
      }
    }

    return this.prisma.user.create({
      data: {
        name,
        phone,
        email: dto.email?.trim() || null,
        address: dto.address?.trim() || null,
        notes: dto.notes?.trim() || null,
        birthDate: parsedBirthDate,
        telegramUsername: dto.telegramUsername?.trim() || null,
        role: UserRole.CUSTOMER,
        registrationType: dto.registrationType || RegistrationType.OFFLINE,
        loyaltyStatus: LoyaltyStatus.BRONZE,
        loyaltyPoints: 0,
        totalPurchaseAmount: 0,
        isCustomer: true,
      },
    });
  }

  async createOffline(dto: {
    name: string;
    phone: string;
    email?: string;
    address?: string;
    notes?: string;
    birthDate?: string;
    telegramUsername?: string;
  }) {
    return this.register({
      ...dto,
      registrationType: RegistrationType.OFFLINE,
    });
  }

  async update(
    id: string,
    dto: {
      name?: string;
      phone?: string;
      email?: string;
      address?: string;
      notes?: string;
      birthDate?: string;
      telegramUsername?: string;
      loyaltyPoints?: number;
      loyaltyStatus?: string;
    },
  ) {
    const customer = await this.findOne(id);

    const updateData: Prisma.UserUpdateInput = {};

    if (dto.name !== undefined) updateData.name = dto.name.trim();
    if (dto.email !== undefined) updateData.email = dto.email?.trim() || null;
    if (dto.address !== undefined)
      updateData.address = dto.address?.trim() || null;
    if (dto.notes !== undefined) updateData.notes = dto.notes?.trim() || null;

    if (dto.phone) {
      const phone = dto.phone.trim();
      if (phone !== customer.phone) {
        const existing = await this.prisma.user.findUnique({
          where: { phone },
        });
        if (existing) {
          throw new ConflictException({
            message: 'Ushbu telefon raqamga ega mijoz allaqachon mavjud.',
            existingCustomer: existing,
          });
        }
        updateData.phone = phone;
      }
    }

    if (dto.birthDate !== undefined) {
      if (dto.birthDate === '') {
        updateData.birthDate = null;
      } else {
        const date = new Date(dto.birthDate);
        if (isNaN(date.getTime()))
          throw new BadRequestException("Tug'ilgan sana noto'g'ri.");
        updateData.birthDate = date;
      }
    }

    if (dto.telegramUsername !== undefined) {
      updateData.telegramUsername = dto.telegramUsername?.trim() || null;
    }

    if (dto.loyaltyPoints !== undefined) {
      updateData.loyaltyPoints = dto.loyaltyPoints;
    }

    if (dto.loyaltyStatus) {
      updateData.loyaltyStatus = dto.loyaltyStatus as LoyaltyStatus;
    }

    return this.prisma.user.update({
      where: { id },
      data: updateData,
    });
  }

  async sendMarketingSms(dto: {
    target: 'ALL' | 'BRONZE' | 'SILVER' | 'GOLD' | 'SPECIFIC';
    phoneNumbers?: string[];
    message: string;
  }) {
    if (!dto.message?.trim()) {
      throw new BadRequestException("SMS xabari bo'sh bo'lmasligi kerak.");
    }

    let phones: string[] = [];

    if (dto.target === 'SPECIFIC') {
      if (!dto.phoneNumbers || dto.phoneNumbers.length === 0) {
        throw new BadRequestException(
          'Telefon raqamlar ro`yxati kiritilishi shart.',
        );
      }
      phones = dto.phoneNumbers;
    } else {
      const where: Prisma.UserWhereInput = {
        role: UserRole.CUSTOMER,
      };

      if (dto.target !== 'ALL') {
        where.loyaltyStatus = dto.target as LoyaltyStatus;
      }

      const customers = await this.prisma.user.findMany({
        where,
        select: { phone: true },
      });

      phones = customers.map((c) => c.phone);
    }

    // ALWAYS filter out ADMIN and SUPERADMIN users from SMS recipients
    const adminUsers = await this.prisma.user.findMany({
      where: {
        role: { in: [UserRole.ADMIN, UserRole.SUPERADMIN] },
      },
      select: { phone: true },
    });
    const adminPhones = new Set(
      adminUsers.map((a) => a.phone?.replace(/\D/g, '')).filter(Boolean),
    );
    phones = phones.filter((p) => p && !adminPhones.has(p.replace(/\D/g, '')));

    if (phones.length === 0) {
      return {
        success: true,
        sentCount: 0,
        message:
          'Yuborish uchun mijozlar topilmadi (Adminlarga SMS yuborilmaydi).',
      };
    }

    // Send SMS concurrently or sequentially
    let successCount = 0;
    for (const phone of phones) {
      const success = await this.smsService.sendSms(phone, dto.message);
      if (success) successCount++;
    }

    return {
      success: true,
      sentCount: successCount,
      totalCount: phones.length,
      message: `${successCount} ta mijozga SMS yuborildi.`,
    };
  }

  async sendSmsCode(dto: {
    phone: string;
    code?: string;
    customNote?: string;
  }) {
    if (!dto.phone?.trim()) {
      throw new BadRequestException('Telefon raqam kiritilishi shart.');
    }
    const cleanPhone = dto.phone.trim();
    const digitsOnly = cleanPhone.replace(/\D/g, '');

    // Check if phone belongs to an ADMIN or SUPERADMIN
    const targetUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanPhone },
          ...(digitsOnly ? [{ phone: { contains: digitsOnly } }] : []),
        ],
      },
      select: { role: true },
    });

    if (
      targetUser &&
      (targetUser.role === UserRole.ADMIN ||
        targetUser.role === UserRole.SUPERADMIN)
    ) {
      throw new BadRequestException(
        "Admin foydalanuvchilariga SMS yuborib bo'lmaydi.",
      );
    }

    const code =
      dto.code?.trim() ||
      Math.floor(100000 + Math.random() * 900000).toString();
    const note = dto.customNote?.trim() ? ` (${dto.customNote.trim()})` : '';

    const message = `YEC Market tasdiqlash kodi: ${code}${note}. Kodni hech kimga bermang.`;

    const success = await this.smsService.sendSms(cleanPhone, message);

    return {
      success,
      phone: cleanPhone,
      code,
      message: success
        ? `${cleanPhone} raqamiga tasdiqlash SMS kodi (${code}) yuborildi.`
        : `SMS yuborishda xatolik yuz berdi.`,
    };
  }
}
