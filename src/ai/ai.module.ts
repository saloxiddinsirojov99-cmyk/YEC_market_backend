import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { SimilarityService } from './services/similarity.service';
import { RecommendationService } from './services/recommendation.service';
import { AssistantService } from './services/assistant.service';
import { PreviewQueueProcessor } from './queue/preview-queue.processor';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AiController],
  providers: [
    SimilarityService,
    RecommendationService,
    AssistantService,
    PreviewQueueProcessor,
  ],
  exports: [
    SimilarityService,
    RecommendationService,
    AssistantService,
    PreviewQueueProcessor,
  ],
})
export class AiModule {}
