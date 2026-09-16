import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CartPreviewDto } from './dto/cart-preview.dto';
import { CartService } from './cart.service';

@ApiTags('Cart')
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @ApiOperation({ summary: 'Savatni oldindan hisoblash' })
  @ApiResponse({ status: 200, description: 'Hisob-kitob muvaffaqiyatli.' })
  @ApiBody({ type: CartPreviewDto })
  @Public()
  @Post('preview')
  preview(@Body() dto: CartPreviewDto) {
    return this.cartService.preview(dto);
  }
}
