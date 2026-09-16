import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Carpet } from '@prisma/client';

@Injectable()
export class CarpetsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByBarcode(
    barcode: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Carpet | null> {
    const client = tx || this.prisma;
    const item = await client.inventoryItem.findUnique({
      where: { barcode },
      include: { carpet: true },
    });
    return item?.carpet || null;
  }

  async findByUniqueCode(
    uniqueCode: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Carpet | null> {
    const client = tx || this.prisma;
    return client.carpet.findUnique({
      where: { uniqueCode },
    });
  }

  async create(
    data: Prisma.CarpetCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Carpet> {
    const client = tx || this.prisma;
    return client.carpet.create({ data });
  }

  async findMany(
    args?: Prisma.CarpetFindManyArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<Carpet[]> {
    const client = tx || this.prisma;
    return client.carpet.findMany(args);
  }

  async count(
    args?: Prisma.CarpetCountArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx || this.prisma;
    return client.carpet.count(args);
  }

  async findUnique(
    args: Prisma.CarpetFindUniqueArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<Carpet | null> {
    const client = tx || this.prisma;
    return client.carpet.findUnique(args);
  }

  async update(
    args: Prisma.CarpetUpdateArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<Carpet> {
    const client = tx || this.prisma;
    return client.carpet.update(args);
  }

  async delete(
    args: Prisma.CarpetDeleteArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<Carpet> {
    const client = tx || this.prisma;
    return client.carpet.delete(args);
  }

  async getLastCarpetNumber(tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx || this.prisma;
    const lastCarpet = await client.carpet.findFirst({
      where: { uniqueCode: { startsWith: 'CARPET-' } },
      orderBy: { uniqueCode: 'desc' },
    });
    if (!lastCarpet) return 0;
    const match = lastCarpet.uniqueCode.match(/CARPET-(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
}
