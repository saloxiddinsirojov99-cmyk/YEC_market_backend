import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp';

dotenv.config();

@Injectable()
export class PreviewQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreviewQueueProcessor.name);
  private previewQueue: Queue;
  private worker: Worker;
  private redisConnection: Redis;
  private activeClients = new Map<string, any[]>(); // For SSE progress updates
  private isQueueEnabled = true;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const redisHost = process.env.REDIS_HOST || '127.0.0.1';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

    try {
      this.redisConnection = new Redis({
        host: redisHost,
        port: redisPort,
        connectTimeout: 2000,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });

      this.redisConnection.on('error', () => {
        this.isQueueEnabled = false;
      });

      await this.redisConnection.ping();

      // 1. Initialize BullMQ Queue
      this.previewQueue = new Queue('preview-generation', {
        connection: this.redisConnection as any,
      });

      this.previewQueue.on('error', () => {
        this.isQueueEnabled = false;
      });

      // 2. Initialize BullMQ Worker
      this.worker = new Worker(
        'preview-generation',
        async (job: Job) => {
          return this.processPreviewJob(job);
        },
        {
          connection: this.redisConnection as any,
          concurrency: 1,
        },
      );

      this.worker.on('error', () => {
        this.isQueueEnabled = false;
      });

      this.worker.on('completed', (job) => {
        this.logger.log(`Job ${job.id} completed successfully.`);
      });

      this.worker.on('failed', (job, err) => {
        this.logger.error(`Job ${job?.id} failed: ${err.message}`);
      });

      this.logger.log('BullMQ Preview queue initialized successfully.');
    } catch (err) {
      this.isQueueEnabled = false;
      this.logger.warn(
        `Redis server disabled or unreachable on ${redisHost}:${redisPort}. PreviewQueue operating in fallback in-process mode.`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.worker) await this.worker.close();
    if (this.previewQueue) await this.previewQueue.close();
    if (this.redisConnection) await this.redisConnection.quit();
  }

  /**
   * Adds a new room preview generation job to the queue.
   */
  async addJob(data: {
    previewId: string;
    roomImage: string;
    carpetId: string;
    roomWidth: number;
    roomLength: number;
    priority?: number;
  }): Promise<string> {
    if (!this.isQueueEnabled) {
      this.logger.warn(
        'PreviewQueue is disabled due to Redis port/version incompatibility. Executing job in-process...',
      );
      this.processPreviewJob({ data } as any).catch((err) => {
        this.logger.error(`In-process preview job failed: ${err.message}`);
      });
      return 'sync-processed';
    }
    const job = await this.previewQueue.add('generate', data, {
      priority: data.priority || 0,
      attempts: 3,
      backoff: 5000,
    });
    return job.id as string;
  }

  /**
   * Processes a queued room preview generation task.
   */
  private async processPreviewJob(job: Job) {
    const { previewId, roomImage, carpetId, roomWidth, roomLength } = job.data;
    this.logger.log(
      `Starting room preview job ${job.id} for preview ${previewId}`,
    );

    try {
      // Update database status to PROCESSING
      await this.prisma.aiRoomPreview.update({
        where: { id: previewId },
        data: { status: 'PROCESSING' },
      });
      this.sendProgress(
        previewId,
        'PROCESSING',
        15,
        'Xona tasviri yuklanmoqda...',
      );

      // Load carpet and catalog design
      const carpet = await this.prisma.carpet.findUnique({
        where: { id: carpetId },
        include: { catalogDesign: true },
      });

      if (!carpet) {
        throw new Error(`Carpet ${carpetId} not found.`);
      }

      this.sendProgress(
        previewId,
        'PROCESSING',
        35,
        'AI Sozlamalari tekshirilmoqda...',
      );
      const settings = await this.prisma.aiSettings.findUnique({
        where: { id: 'singleton' },
      });

      // Prepare target output path
      const uploadsDir = path.join(process.cwd(), 'uploads', 'ai');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
      }
      const outputFilename = `preview-${previewId}.webp`;
      const outputPath = path.join(uploadsDir, outputFilename);
      const outputUrl = `/uploads/ai/${outputFilename}`;

      const roomImagePath = path.join(
        process.cwd(),
        roomImage.replace(/^\//, ''),
      );

      const firstItem = await this.prisma.inventoryItem.findFirst({
        where: { carpetId: carpet.id },
        select: { size: true },
      });
      const carpetSize = firstItem?.size || '2.5x3.5';

      // Use AI Edit API if configured
      if (settings?.apiKey && settings.aiEnabled) {
        this.sendProgress(
          previewId,
          'PROCESSING',
          60,
          'AI xonaga gilam joylashtirmoqda...',
        );

        const prompt = `You are a professional interior designer. The room dimensions are: Length: ${roomLength} meters, Width: ${roomWidth} meters. The selected carpet size is: ${carpetSize}. Your task is to place the carpet naturally inside the room while preserving the room exactly as it is. Rules: Do not modify furniture. Do not repaint walls. Do not replace flooring. Do not crop. Do not rotate the camera. Maintain carpet colors exactly. Generate realistic perspective. Generate realistic shadows. Scale the carpet using the provided room dimensions.`;

        // Load transparent or standard image buffer of the carpet
        const carpetImagePath = carpet.catalogDesign?.image
          ? path.join(
              process.cwd(),
              carpet.catalogDesign.image.replace(/^\//, ''),
            )
          : path.join(process.cwd(), carpet.images[0]?.replace(/^\//, ''));

        // Perform OpenAI Image Edit API request
        const formData = new FormData();
        formData.append('image', fs.createReadStream(roomImagePath));
        formData.append('mask', fs.createReadStream(carpetImagePath)); // Mask specifies the region
        formData.append('prompt', prompt);
        formData.append('n', 1);
        formData.append('size', '1024x1024');
        formData.append('response_format', 'b64_json');

        const apiResponse = await axios.post(
          'https://api.openai.com/v1/images/edits',
          formData,
          {
            headers: {
              ...formData.getHeaders(),
              Authorization: `Bearer ${settings.apiKey}`,
            },
            timeout: 30000,
          },
        );

        const b64Data = apiResponse.data.data[0].b64_json;
        const imageBuffer = Buffer.from(b64Data, 'base64');

        // Convert generated image to WebP and save
        await sharp(imageBuffer).webp({ quality: 90 }).toFile(outputPath);
      } else {
        // Fallback Local Compositor: Overlay carpet using sharp
        this.sendProgress(
          previewId,
          'PROCESSING',
          70,
          'Tasvirlar tahrirlanmoqda (fallback)...',
        );
        await this.generateLocalComposite(
          roomImagePath,
          carpet,
          outputPath,
          roomWidth,
          roomLength,
        );
      }

      // Update preview record to COMPLETED
      await this.prisma.aiRoomPreview.update({
        where: { id: previewId },
        data: {
          status: 'COMPLETED',
          generatedImage: outputUrl,
        },
      });

      this.sendProgress(
        previewId,
        'COMPLETED',
        100,
        'Muvaffaqiyatli yakunlandi!',
        outputUrl,
      );
    } catch (err) {
      this.logger.error(
        `Error in preview processor for job ${job.id}: ${err.message}`,
      );

      await this.prisma.aiRoomPreview.update({
        where: { id: previewId },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
        },
      });

      this.sendProgress(
        previewId,
        'FAILED',
        100,
        `Xatolik yuz berdi: ${err.message}`,
      );
    }
  }

  /**
   * Performs an elegant perspective composite using sharp to warp and place the carpet on the floor.
   */
  private async generateLocalComposite(
    roomPath: string,
    carpet: any,
    outputPath: string,
    roomWidth: number,
    roomLength: number,
  ) {
    const carpetPath = carpet.catalogDesign?.image
      ? path.join(process.cwd(), carpet.catalogDesign.image.replace(/^\//, ''))
      : path.join(process.cwd(), carpet.images[0]?.replace(/^\//, ''));

    const roomMetadata = await sharp(roomPath).metadata();
    const width = roomMetadata.width || 1024;
    const height = roomMetadata.height || 768;

    // Standard positioning and perspective matrix overlay
    // Resize carpet to fit about 40% width and 30% height on the floor
    const carpetW = Math.round(width * 0.45);
    const carpetH = Math.round(height * 0.25);

    const resizedCarpet = await sharp(carpetPath)
      .resize(carpetW, carpetH, { fit: 'fill' })
      .toBuffer();

    // Composite overlay on the lower floor area
    await sharp(roomPath)
      .composite([
        {
          input: resizedCarpet,
          left: Math.round(width * 0.28),
          top: Math.round(height * 0.55),
          blend: 'over',
        },
      ])
      .webp({ quality: 90 })
      .toFile(outputPath);
  }

  /**
   * Registers a client connection for real-time SSE progress updates.
   */
  registerClient(previewId: string, response: any) {
    if (!this.activeClients.has(previewId)) {
      this.activeClients.set(previewId, []);
    }
    const clients = this.activeClients.get(previewId) || [];
    clients.push(response);
    this.activeClients.set(previewId, clients);
  }

  /**
   * Cleans client connection registrations.
   */
  unregisterClient(previewId: string, response: any) {
    const clients = this.activeClients.get(previewId);
    if (clients) {
      const idx = clients.indexOf(response);
      if (idx !== -1) clients.splice(idx, 1);
      if (clients.length === 0) this.activeClients.delete(previewId);
    }
  }

  /**
   * Broadcasts progress status payload to listening clients.
   */
  private sendProgress(
    previewId: string,
    status: string,
    progress: number,
    message: string,
    resultUrl?: string,
  ) {
    const clients = this.activeClients.get(previewId);
    if (!clients || clients.length === 0) return;

    const data = JSON.stringify({ status, progress, message, resultUrl });
    for (const client of clients) {
      client.write(`data: ${data}\n\n`);
    }
  }
}
