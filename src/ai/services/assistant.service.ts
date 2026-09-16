import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RecommendationService } from './recommendation.service';
import axios from 'axios';

export interface AssistantChatResponse {
  reply: string;
  parsedDimensions?: { width: number; length: number; label: string };
  recommendedCarpets: any[];
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recommendationService: RecommendationService,
  ) {}

  /**
   * Processes a natural language interior query and recommends carpets.
   */
  async processQuery(
    message: string,
    userId?: string,
  ): Promise<AssistantChatResponse> {
    const settings = await this.prisma.aiSettings.findUnique({
      where: { id: 'singleton' },
    });

    let width = 0;
    let length = 0;
    let extractedStyle = '';
    let extractedColors: string[] = [];

    // Fallback local regex parsing
    // Example: "5x4 metr zal" or "5 * 4" or "5ga 4"
    const dimMatch = message.match(
      /(\d+([\.,]\d+)?)\s*(?:x|\*|ga|x|x|lar|-|d)\s*(\d+([\.,]\d+)?)/i,
    );
    if (dimMatch) {
      const val1 = parseFloat(dimMatch[1].replace(',', '.'));
      const val2 = parseFloat(dimMatch[3].replace(',', '.'));
      width = Math.min(val1, val2);
      length = Math.max(val1, val2);
    }

    if (message.toLowerCase().includes('minimal'))
      extractedStyle = 'minimalist';
    if (message.toLowerCase().includes('skand'))
      extractedStyle = 'scandinavian';
    if (message.toLowerCase().includes('klassik')) extractedStyle = 'classic';
    if (message.toLowerCase().includes('loft')) extractedStyle = 'loft';
    if (message.toLowerCase().includes('modern')) extractedStyle = 'modern';

    if (message.toLowerCase().includes('oq')) extractedColors.push('oq');
    if (
      message.toLowerCase().includes('kulrang') ||
      message.toLowerCase().includes('seriy')
    )
      extractedColors.push('kulrang');
    if (
      message.toLowerCase().includes('jigarrang') ||
      message.toLowerCase().includes('korich')
    )
      extractedColors.push('jigarrang');

    let aiReplyText = '';

    // LLM call if apiKey is set
    if (settings?.apiKey && settings.aiEnabled) {
      try {
        const systemPrompt = `
You are a professional Uzbek interior designer assistant for YEC Market.
Analyze the user query in Uzbek and reply with a friendly interior advice (max 3 sentences).
Also extract the following details in a JSON format at the end of your response, wrapped inside a <JSON> tag.
Format:
<JSON>
{
  "reply": "friendly interior suggestion and styling advice in Uzbek",
  "width": 4.0,
  "length": 5.0,
  "style": "minimalist/classic/scandinavian",
  "colors": ["oq", "kulrang"]
}
</JSON>

Ensure your Uzbek is natural and polite. Do not include markdown code block syntax around the JSON inside the <JSON> tag.
`;

        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: message },
            ],
            temperature: 0.7,
            max_tokens: 400,
          },
          {
            headers: {
              Authorization: `Bearer ${settings.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          },
        );

        const text = response.data.choices[0].message.content;
        const jsonMatch = text.match(/<JSON>([\s\S]*?)<\/JSON>/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1].trim());
          aiReplyText = parsed.reply || '';
          if (parsed.width > 0) width = parsed.width;
          if (parsed.length > 0) length = parsed.length;
          if (parsed.style) extractedStyle = parsed.style;
          if (parsed.colors) extractedColors = parsed.colors;
        } else {
          aiReplyText = text;
        }
      } catch (err) {
        this.logger.warn(
          `AI API call failed, using local fallback parser: ${err.message}`,
        );
      }
    }

    // Default reply if AI was not run or failed
    if (!aiReplyText) {
      if (width > 0 && length > 0) {
        aiReplyText = `Sizning ${length}x${width} metr o'lchamdagi xonangiz uchun minimalist va shinam gilamlarni tanladim. Katta mebellar ostiga qo'yish uchun quyidagi variantlar ideal hisoblanadi.`;
      } else {
        aiReplyText = `Xonangiz dizayniga mos keluvchi va eng ko'p sotilgan gilamlar kolleksiyasini tavsiya etaman. Farzandlaringiz uchun yumshoq, shinam va oson tozalanadigan variantlarni tanlab oldim.`;
      }
    }

    // Save preferences asynchronously to improve next queries
    if (userId && (extractedColors.length > 0 || width > 0 || extractedStyle)) {
      const sizeLabel =
        width > 0 && length > 0 ? `${width}x${length} sm` : undefined;
      this.recommendationService
        .trackUserPreference(
          userId,
          extractedColors[0],
          sizeLabel,
          extractedStyle,
        )
        .catch(() => {});
    }

    // Resolve recommended carpets
    // Set a default size label based on extracted width/length, otherwise use "2.5x3.5 sm"
    let targetSize = '2.5x3.5 sm';
    if (width > 0 && length > 0) {
      const sizes = this.recommendationService.recommendSizes(width, length);
      if (sizes.length > 0) {
        targetSize = sizes[0].sizeLabel;
      }
    }

    const carpets = await this.recommendationService.recommendCarpets(
      width || 4.2,
      length || 5.8,
      targetSize,
      userId,
      false,
    );

    return {
      reply: aiReplyText,
      parsedDimensions:
        width > 0 && length > 0
          ? { width, length, label: targetSize }
          : undefined,
      recommendedCarpets: carpets.slice(0, 5), // Return top 5 matches
    };
  }
}
