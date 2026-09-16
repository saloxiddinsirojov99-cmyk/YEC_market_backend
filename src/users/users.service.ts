import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { User, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { generateTelegramUserJoinToken } from '../common/utils/telegram-link-token';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async findByPhone(phone: string): Promise<User | null> {
    const clean9Digits = phone.replace(/\D/g, '').slice(-9);
    if (!clean9Digits || clean9Digits.length < 9) {
      return this.prisma.user.findFirst({ where: { phone } });
    }

    const candidateUsers = await this.prisma.user.findMany({
      where: { phone: { contains: clean9Digits } },
    });

    if (candidateUsers.length > 0) {
      candidateUsers.sort((a, b) => {
        const aHasPass = a.password ? 1 : 0;
        const bHasPass = b.password ? 1 : 0;
        if (aHasPass !== bHasPass) return bHasPass - aHasPass;

        const aIsAdmin =
          a.role === UserRole.SUPERADMIN || a.role === UserRole.ADMIN ? 1 : 0;
        const bIsAdmin =
          b.role === UserRole.SUPERADMIN || b.role === UserRole.ADMIN ? 1 : 0;
        if (aIsAdmin !== bIsAdmin) return bIsAdmin - aIsAdmin;

        return b.createdAt.getTime() - a.createdAt.getTime();
      });
      return candidateUsers[0];
    }

    const allUsers = await this.prisma.user.findMany();

    const matches = allUsers.filter(
      (u) => u.phone && u.phone.replace(/\D/g, '').endsWith(clean9Digits),
    );

    if (matches.length > 0) {
      matches.sort((a, b) => {
        const aHasPass = a.password ? 1 : 0;
        const bHasPass = b.password ? 1 : 0;
        if (aHasPass !== bHasPass) return bHasPass - aHasPass;

        const aIsAdmin =
          a.role === UserRole.SUPERADMIN || a.role === UserRole.ADMIN ? 1 : 0;
        const bIsAdmin =
          b.role === UserRole.SUPERADMIN || b.role === UserRole.ADMIN ? 1 : 0;
        if (aIsAdmin !== bIsAdmin) return bIsAdmin - aIsAdmin;

        return b.createdAt.getTime() - a.createdAt.getTime();
      });
      return matches[0];
    }

    return null;
  }

  async findByCredential(credential: string): Promise<User | null> {
    const normalized = credential.trim();
    if (!normalized) return null;

    // 1. Try to find by email
    const byEmail = await this.prisma.user.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
    });
    if (byEmail) return byEmail;

    // 2. Try to find by phone using robust findByPhone
    const byPhone = await this.findByPhone(normalized);
    if (byPhone) return byPhone;

    // 3. Fallback direct match with digits
    const digitsOnly = normalized.replace(/\D/g, '');
    if (digitsOnly.length >= 7) {
      const match = await this.prisma.user.findFirst({
        where: { phone: { contains: digitsOnly } },
      });
      if (match) return match;
    }

    return null;
  }

  async findById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('Foydalanuvchi topilmadi.');
    }
    return user;
  }

  async createCustomer(
    name: string,
    email: string,
    phone: string,
    hashedPassword: string,
  ): Promise<User> {
    // If an offline user with this phone number already exists, update them to ONLINE instead of creating a new user
    const existingByPhone = await this.findByPhone(phone);
    if (existingByPhone) {
      if (existingByPhone.registrationType === 'ONLINE') {
        throw new ConflictException(
          "Bu telefon raqami bilan foydalanuvchi allaqachon ro'yxatdan o'tgan.",
        );
      }
      return this.prisma.user.update({
        where: { id: existingByPhone.id },
        data: {
          name,
          email: email.toLowerCase(),
          password: hashedPassword,
          registrationType: 'ONLINE',
        },
      });
    }

    const existingByEmail = await this.findByEmail(email);
    if (existingByEmail) {
      throw new ConflictException(
        "Bu email bilan foydalanuvchi allaqachon ro'yxatdan o'tgan.",
      );
    }

    return this.prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        phone,
        password: hashedPassword,
        role: UserRole.CUSTOMER,
        registrationType: 'ONLINE',
      },
    });
  }

  async createAdmin(
    name: string,
    email: string,
    phone: string,
    hashedPassword: string,
  ): Promise<User> {
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new ConflictException(
        "Bu email bilan foydalanuvchi allaqachon ro'yxatdan o'tgan.",
      );
    }

    return this.prisma.user.create({
      data: {
        name,
        email,
        phone,
        password: hashedPassword,
        role: UserRole.ADMIN,
      },
    });
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        role: true,
        address: true,
        lat: true,
        lng: true,
        createdAt: true,
        updatedAt: true,
        telegramChatId: true,
        orders: {
          orderBy: { createdAt: 'desc' },
          include: {
            items: {
              include: {
                carpet: {
                  select: {
                    id: true,
                    name: true,
                    images: true,
                    material: true,
                    price: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Profil topilmadi.');
    }

    // Auto-link by phone number matching clean 9 digits if not yet linked
    if (!user.telegramChatId && user.phone) {
      const clean9 = user.phone.replace(/\D/g, '').slice(-9);
      if (clean9.length === 9) {
        const candidate = await this.prisma.user.findFirst({
          where: {
            id: { not: user.id },
            telegramChatId: { not: null },
            phone: { contains: clean9 },
          },
        });

        let targetChatId = candidate?.telegramChatId;
        let targetUsername = candidate?.telegramUsername;

        if (!targetChatId) {
          const allLinked = await this.prisma.user.findMany({
            where: {
              id: { not: user.id },
              telegramChatId: { not: null },
            },
            select: {
              telegramChatId: true,
              telegramUsername: true,
              phone: true,
            },
          });
          const match = allLinked.find(
            (u) => u.phone && u.phone.replace(/\D/g, '').endsWith(clean9),
          );
          if (match) {
            targetChatId = match.telegramChatId;
            targetUsername = match.telegramUsername;
          }
        }

        if (targetChatId) {
          const updated = await this.prisma.user.update({
            where: { id: user.id },
            data: {
              telegramChatId: targetChatId,
              telegramUsername: targetUsername || null,
            },
            select: { telegramChatId: true },
          });
          user.telegramChatId = updated.telegramChatId;
        }
      }
    }

    const tokenSecret =
      process.env.TELEGRAM_LINK_SECRET?.trim() ||
      process.env.JWT_SECRET?.trim() ||
      'fallback-telegram-link-secret';
    const telegramJoinToken = generateTelegramUserJoinToken(
      user.id,
      tokenSecret,
    );

    return {
      ...user,
      isTelegramLinked: Boolean(user.telegramChatId),
      telegramJoinToken,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.findById(userId);

    let finalPhone = dto.phone;
    if (dto.phone) {
      const cleanDigits = dto.phone.replace(/\D/g, '');
      finalPhone =
        cleanDigits.length >= 9 ? `+998${cleanDigits.slice(-9)}` : dto.phone;

      const existingUser = await this.prisma.user.findFirst({
        where: {
          id: { not: userId },
          OR: [
            { phone: dto.phone },
            { phone: finalPhone },
            { phone: cleanDigits },
          ],
        },
      });

      if (existingUser) {
        throw new ConflictException(
          'Ushbu telefon raqami bazada allaqachon mavjud. Iltimos, boshqa telefon raqami kiriting.',
        );
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        phone: finalPhone,
        avatar: dto.avatar,
        address: dto.address,
        lat: dto.lat,
        lng: dto.lng,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        role: true,
        address: true,
        lat: true,
        lng: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findAll() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findCouriers() {
    return this.prisma.user.findMany({
      where: { role: 'COURIER' },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        telegramChatId: true,
      },
    });
  }

  async remove(currentUserId: string, userId: string) {
    if (currentUserId === userId) {
      throw new BadRequestException("O'zingizni o'chira olmaysiz.");
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Foydalanuvchi topilmadi.');
    }

    const ordersCount = await this.prisma.order.count({
      where: { customerId: userId },
    });

    if (ordersCount > 0) {
      throw new BadRequestException(
        "Bu foydalanuvchini o'chirib bo'lmaydi, chunki unda buyurtmalar mavjud.",
      );
    }

    return this.prisma.user.delete({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
      },
    });
  }

  async updateRole(currentUserId: string, userId: string, role: UserRole) {
    if (currentUserId === userId) {
      throw new BadRequestException("O'z rolingizni o'zgartira olmaysiz.");
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Foydalanuvchi topilmadi.');
    }

    if (user.role === UserRole.SUPERADMIN) {
      throw new BadRequestException("SUPERADMIN rolini o'zgartira olmaysiz.");
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, name: true, email: true, phone: true, role: true },
    });
  }

  async getAdminStats() {
    const [
      usersCount,
      carpetsCount,
      pendingCount,
      acceptedCount,
      deliveredCount,
      cancelledCount,
      onWayCount,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.carpet.count(),
      this.prisma.order.count({ where: { status: 'PENDING' } }),
      this.prisma.order.count({ where: { status: 'ACCEPTED' } }),
      this.prisma.order.count({ where: { status: 'DELIVERED' } }),
      this.prisma.order.count({ where: { status: 'CANCELLED' } }),
      this.prisma.order.count({ where: { status: 'ON_WAY' } }),
    ]);

    return {
      usersCount,
      carpetsCount,
      orders: {
        total:
          pendingCount +
          acceptedCount +
          deliveredCount +
          cancelledCount +
          onWayCount,
        pending: pendingCount,
        accepted: acceptedCount,
        delivered: deliveredCount,
        cancelled: cancelledCount,
        onWay: onWayCount,
      },
    };
  }
}
