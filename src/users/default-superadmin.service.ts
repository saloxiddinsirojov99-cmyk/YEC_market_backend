import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DefaultSuperAdminService implements OnModuleInit {
  private readonly logger = new Logger(DefaultSuperAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureDefaultSuperAdmin();
  }

  private async ensureDefaultSuperAdmin(): Promise<void> {
    const fullName = 'Saloxiddin Sirojov';
    const email = 'saloxiddinsirojov99@gmail.com';
    const phone = '+998976111330';
    const rawPassword = 'shaftoli';
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    try {
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [{ email }, { phone }, { phone: { contains: '976111330' } }],
        },
      });

      if (existingUser) {
        await this.prisma.user.update({
          where: { id: existingUser.id },
          data: {
            name: fullName,
            email,
            phone,
            password: hashedPassword,
            role: UserRole.SUPERADMIN,
          },
        });
        this.logger.log(`Default superadmin tayyor: ${phone} (${email})`);
      } else {
        await this.prisma.user.create({
          data: {
            name: fullName,
            email,
            phone,
            password: hashedPassword,
            role: UserRole.SUPERADMIN,
          },
        });
        this.logger.log(`Default superadmin yaratildi: ${phone} (${email})`);
      }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2021'
      ) {
        this.logger.warn(
          'Default superadmin yaratilmadi: User jadvali topilmadi. Avval migratsiyani ishga tushiring.',
        );
        return;
      }

      const message =
        error instanceof Error ? error.message : "Noma'lum xatolik";
      this.logger.warn(
        `Default superadmin yaratilmadi, lekin server ishida davom etadi: ${message}`,
      );
    }
  }
}
