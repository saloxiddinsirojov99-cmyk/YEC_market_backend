import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthService } from './auth.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';
import { GoogleMobileAuthDto } from './dto/google-mobile-auth.dto';
import { RequestRegisterOtpDto } from './dto/request-register-otp.dto';
import { RequestForgotPasswordDto } from './dto/request-forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyRegisterOtpDto } from './dto/verify-register-otp.dto';
import { GoogleAuthGuard } from './guards/google-auth.guard';

function isMobileClient(req: Request): boolean {
  const platformHeader = String(
    req.headers['x-client-platform'] ?? req.headers['x-platform'] ?? '',
  ).toLowerCase();
  const queryPlatform =
    typeof req.query?.platform === 'string'
      ? req.query.platform.toLowerCase()
      : '';
  return platformHeader === 'mobile' || queryPlatform === 'mobile';
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @ApiOperation({ summary: "Ro'yxatdan o'tish uchun Tasdiqlash kodi so'rash" })
  @ApiResponse({
    status: 201,
    description: 'Tasdiqlash kodi emailga yuborildi.',
  })
  @ApiBody({ type: RequestRegisterOtpDto })
  @Public()
  @Post('register/request-otp')
  requestRegisterOtp(@Body() dto: RequestRegisterOtpDto) {
    return this.authService.requestRegisterOtp(dto);
  }

  @ApiOperation({
    summary: "Ro'yxatdan o'tish (Tasdiqlash kodi emailga yuboriladi)",
  })
  @ApiResponse({
    status: 201,
    description: 'Tasdiqlash kodi emailga yuborildi.',
  })
  @ApiBody({ type: RequestRegisterOtpDto })
  @Public()
  @Post('register')
  register(@Body() dto: RequestRegisterOtpDto) {
    return this.authService.requestRegisterOtp(dto);
  }

  @ApiOperation({
    summary: "Tasdiqlash kodi bilan ro'yxatdan o'tishni yakunlash",
  })
  @ApiResponse({ status: 201, description: "Ro'yxatdan o'tish yakunlandi." })
  @ApiBody({ type: VerifyRegisterOtpDto })
  @Public()
  @Post('register/verify-otp')
  async verifyRegisterOtp(
    @Body() dto: VerifyRegisterOtpDto,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ) {
    const result = await this.authService.verifyRegisterOtp(
      dto,
      req.ip,
      req.headers['user-agent'] as string,
    );
    res.cookie('refreshToken', result.refreshToken, this.getCookieOptions());

    if (isMobileClient(req)) {
      return {
        message: result.message,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: result.user,
      };
    }

    return {
      message: result.message,
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  @ApiOperation({ summary: "Parolni unutgan bo'lsa kod yuborish" })
  @ApiResponse({ status: 200, description: 'Tasdiqlash kodi yuborildi.' })
  @Public()
  @Post('forgot-password/request-otp')
  requestForgotPasswordOtp(@Body() dto: RequestForgotPasswordDto) {
    return this.authService.requestForgotPasswordOtp(dto);
  }

  @ApiOperation({ summary: "Yangi parol o'rnatish" })
  @ApiResponse({
    status: 200,
    description: "Parol muvaffaqiyatli o'zgartirildi.",
  })
  @Public()
  @Post('forgot-password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @ApiOperation({ summary: 'Tizimga kirish (admin/customer)' })
  @ApiResponse({ status: 200, description: 'Kirish muvaffaqiyatli.' })
  @ApiBody({ type: LoginDto })
  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
    @Req() req: Request,
  ) {
    const result = await this.authService.login(
      dto,
      req.ip,
      req.headers['user-agent'] as string,
    );
    res.cookie('refreshToken', result.refreshToken, this.getCookieOptions());

    if (isMobileClient(req)) {
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: result.user,
      };
    }

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  @ApiOperation({ summary: 'Access tokenni refresh qilish' })
  @ApiResponse({ status: 200, description: 'Yangi access token qaytarildi.' })
  @ApiBody({ type: RefreshTokenDto, required: false })
  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: RefreshTokenDto,
  ) {
    const tokenFromCookie = req.cookies?.refreshToken as string | undefined;
    const isFromCookie = Boolean(tokenFromCookie);
    const token = tokenFromCookie || dto?.refreshToken;

    if (!token) {
      throw new UnauthorizedException('Refresh token topilmadi.');
    }

    const result = await this.authService.refreshAccessToken(
      token,
      req.ip,
      req.headers['user-agent'] as string,
    );
    res.cookie('refreshToken', result.refreshToken, this.getCookieOptions());

    if (!isFromCookie || isMobileClient(req)) {
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    }

    return {
      accessToken: result.accessToken,
    };
  }

  @ApiOperation({ summary: "Yangi admin qo'shish (faqat admin)" })
  @ApiBearerAuth()
  @ApiResponse({ status: 201, description: 'Yangi admin yaratildi.' })
  @ApiBody({ type: CreateAdminDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('admins')
  createAdmin(@Body() dto: CreateAdminDto) {
    return this.authService.createAdmin(dto);
  }

  @ApiOperation({ summary: 'Google orqali login' })
  @Public()
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  googleAuth() {
    return;
  }

  @ApiOperation({ summary: 'Google login callback' })
  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  async googleAuthRedirect(@Req() req: Request, @Res() res: Response) {
    const frontUrl =
      this.configService.get<string>('FRONTEND_URL')?.replace(/\/$/, '') ??
      'http://localhost:3002';

    if (!req.user) {
      const loginUrl = new URL('/login', frontUrl);
      loginUrl.searchParams.set(
        'oauthError',
        'Google akkaunt ma`lumotlarini olishda xatolik yuz berdi.',
      );
      return res.redirect(loginUrl.toString());
    }

    const loginResult = await this.authService.loginWithGoogle(
      req.user as any,
      req.ip,
      req.headers['user-agent'] as string,
    );

    res.cookie(
      'refreshToken',
      loginResult.refreshToken,
      this.getCookieOptions(),
    );

    const redirectUrl = new URL('/auth/google/callback', frontUrl);
    redirectUrl.searchParams.set('accessToken', loginResult.accessToken);

    return res.redirect(redirectUrl.toString());
  }

  @ApiOperation({
    summary: 'Google orqali mobil login (Google ID token verify)',
  })
  @ApiResponse({
    status: 200,
    description: 'Google orqali kirish muvaffaqiyatli.',
  })
  @ApiBody({ type: GoogleMobileAuthDto })
  @Public()
  @Post('google/mobile')
  async googleMobileLogin(
    @Body() dto: GoogleMobileAuthDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.loginWithGoogleMobile(
      dto.idToken,
      req.ip,
      req.headers['user-agent'] as string,
    );

    res.cookie('refreshToken', result.refreshToken, this.getCookieOptions());

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    };
  }

  @ApiOperation({ summary: 'Tizimdan chiqish' })
  @ApiResponse({ status: 200, description: 'Chiqish muvaffaqiyatli.' })
  @ApiBody({ type: LogoutDto, required: false })
  @Public()
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto?: LogoutDto,
  ) {
    const token = (req.cookies?.refreshToken || dto?.refreshToken) as
      | string
      | undefined;
    await this.authService.logout(token, dto?.allDevices);

    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax' as const,
      path: '/api/v1/auth',
    });

    return { message: 'Chiqish muvaffaqiyatli.' };
  }

  private getCookieOptions() {
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax' as const,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/api/v1/auth',
    };
  }
}
