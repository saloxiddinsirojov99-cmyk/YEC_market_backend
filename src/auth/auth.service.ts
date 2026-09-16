import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OtpPurpose, UserRole } from '@prisma/client';
import axios from 'axios';
import * as bcrypt from 'bcrypt';
import { createHmac, randomBytes } from 'crypto';
import { MailService } from '../mail/mail.service';
import * as compression from 'compression';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { RequestRegisterOtpDto } from './dto/request-register-otp.dto';
import { VerifyRegisterOtpDto } from './dto/verify-register-otp.dto';
import { RequestForgotPasswordDto } from './dto/request-forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { GoogleProfile } from './strategies/google.strategy';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  async requestRegisterOtp(dto: RequestRegisterOtpDto) {
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw new BadRequestException(
        "Bu email bilan foydalanuvchi allaqachon ro'yxatdan o'tgan.",
      );
    }

    const existingByPhone = await this.usersService.findByPhone(dto.phone);
    if (existingByPhone && existingByPhone.registrationType === 'ONLINE') {
      throw new BadRequestException(
        "Bu telefon raqami bilan foydalanuvchi allaqachon ro'yxatdan o'tgan.",
      );
    }

    const fullName = this.buildFullName(dto.firstName, dto.lastName);
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const otp = this.generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.prisma.otpCode.updateMany({
      where: {
        email: dto.email,
        purpose: OtpPurpose.REGISTER,
        usedAt: null,
      },
      data: {
        usedAt: new Date(),
      },
    });

    await this.prisma.otpCode.create({
      data: {
        email: dto.email,
        code: otp,
        purpose: OtpPurpose.REGISTER,
        pendingName: fullName,
        pendingPhone: dto.phone,
        pendingPassword: hashedPassword,
        expiresAt,
      },
    });

    try {
      await this.mailService.sendOtpEmail(dto.email, otp);
      return {
        message: 'Tasdiqlash kodi emailingizga yuborildi.',
      };
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        return {
          message:
            'SMTP sozlanmagani uchun Tasdiqlash kodi emailga yuborilmadi. Dev rejimda kod qaytarildi.',
          devOtpCode: otp,
        };
      }
      throw new InternalServerErrorException(
        'Tasdiqlash kodini emailga yuborishda xatolik yuz berdi.',
      );
    }
  }

  async verifyRegisterOtp(
    dto: VerifyRegisterOtpDto,
    ip = 'unknown',
    userAgent = 'unknown',
  ) {
    const otpRecord = await this.prisma.otpCode.findFirst({
      where: {
        email: dto.email,
        purpose: OtpPurpose.REGISTER,
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      throw new BadRequestException(
        'Tasdiqlash kodi topilmadi yoki muddati tugagan.',
      );
    }

    if (otpRecord.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Tasdiqlash kodi muddati tugagan.');
    }

    if (otpRecord.code !== dto.otp) {
      throw new UnauthorizedException("Tasdiqlash kodi noto'g'ri.");
    }

    if (!otpRecord.pendingPassword) {
      throw new BadRequestException(
        "Ro'yxatdan o'tish ma'lumotlari topilmadi.",
      );
    }
    if (!otpRecord.pendingName || !otpRecord.pendingPhone) {
      throw new BadRequestException(
        "Ro'yxatdan o'tish ma'lumotlari to'liq emas.",
      );
    }

    const createdUser = await this.usersService.createCustomer(
      otpRecord.pendingName,
      dto.email,
      otpRecord.pendingPhone,
      otpRecord.pendingPassword,
    );

    await this.prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { usedAt: new Date() },
    });

    const deviceId = randomBytes(16).toString('hex');
    const tokens = await this.generateTokens(createdUser, deviceId);

    this.logger.log(
      `Audit: Successful registration and login for User: ${createdUser.id}, Device: ${deviceId}, IP: ${ip}, UA: ${userAgent}`,
    );

    return {
      message: "Ro'yxatdan o'tish muvaffaqiyatli yakunlandi.",
      user: {
        id: createdUser.id,
        name: createdUser.name,
        email: createdUser.email!,
        phone: createdUser.phone,
        role: createdUser.role,
      },
      ...tokens,
    };
  }

  async login(
    dto: LoginDto,
    ip = 'unknown',
    userAgent = 'unknown',
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      name: string;
      email: string;
      phone: string;
      role: string;
    };
  }> {
    const user = await this.usersService.findByCredential(dto.email);

    if (!user) {
      this.logger.warn(
        `Audit Warning: Failed login attempt for credential: ${dto.email}, IP: ${ip}, UA: ${userAgent}`,
      );
      throw new UnauthorizedException("Ma'lumotlar noto'g'ri.");
    }
    if (!user.password) {
      throw new UnauthorizedException(
        "Parol o'rnatilmagan yoki ma'lumotlar noto'g'ri.",
      );
    }
    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      this.logger.warn(
        `Audit Warning: Incorrect password login attempt for User: ${user.id}, IP: ${ip}, UA: ${userAgent}`,
      );
      throw new UnauthorizedException("Parol noto'g'ri.");
    }

    const deviceId = randomBytes(16).toString('hex');
    const tokens = await this.generateTokens(user, deviceId);

    this.logger.log(
      `Audit: Successful login for User: ${user.id}, Device: ${deviceId}, IP: ${ip}, UA: ${userAgent}`,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email!,
        phone: user.phone,
        role: user.role,
      },
    };
  }

  async loginWithGoogle(
    profile: GoogleProfile,
    ip = 'unknown',
    userAgent = 'unknown',
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      name: string;
      email: string;
      phone: string;
      role: string;
      avatar?: string | null;
    };
  }> {
    const phoneFromGoogle =
      this.normalizePhoneFromGoogle(profile.phone) ??
      this.normalizePhoneFromGoogle(
        await this.fetchGooglePhone(profile.accessToken),
      );
    const user = await this.findOrCreateGoogleUser(profile, phoneFromGoogle);

    const deviceId = randomBytes(16).toString('hex');
    const tokens = await this.generateTokens(user, deviceId);

    this.logger.log(
      `Audit: Successful Google login for User: ${user.id}, Device: ${deviceId}, IP: ${ip}, UA: ${userAgent}`,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email!,
        phone: user.phone,
        role: user.role,
        avatar: user.avatar,
      },
    };
  }

  getAllowedGoogleClientIds(): string[] {
    const rawIds = [
      this.configService.get<string>('GOOGLE_CLIENT_ID'),
      this.configService.get<string>('GOOGLE_MOBILE_CLIENT_ID'),
      this.configService.get<string>('GOOGLE_IOS_CLIENT_ID'),
      this.configService.get<string>('GOOGLE_ANDROID_CLIENT_ID'),
    ];

    const result: string[] = [];
    for (const raw of rawIds) {
      if (raw && typeof raw === 'string') {
        const parts = raw
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        result.push(...parts);
      }
    }

    return Array.from(new Set(result));
  }

  async loginWithGoogleMobile(
    idToken: string,
    ip = 'unknown',
    userAgent = 'unknown',
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      name: string;
      email: string;
      phone: string;
      role: string;
      avatar?: string | null;
    };
  }> {
    const allowedClientIds = this.getAllowedGoogleClientIds();
    if (allowedClientIds.length === 0) {
      this.logger.warn(
        'Google mobile login attempted but no valid Google Client ID is configured.',
      );
      throw new ServiceUnavailableException(
        'Google orqali kirish xizmati sozlanmagan (Google Client ID topilmadi).',
      );
    }

    let tokenInfo: any;
    try {
      const response = await axios.get(
        'https://oauth2.googleapis.com/tokeninfo',
        {
          params: { id_token: idToken },
          timeout: 5000,
          headers: { Accept: 'application/json' },
        },
      );
      tokenInfo = response.data;
    } catch (error: any) {
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        this.logger.warn(`Google tokeninfo request timed out from IP: ${ip}`);
        throw new ServiceUnavailableException(
          "Google autentifikatsiya xizmatiga ulanib bo'lmadi (timeout). Iltimos, birozdan so'ng qayta urinib ko'ring.",
        );
      }
      if (error.response?.status === 400 || error.response?.status === 401) {
        throw new UnauthorizedException(
          "Google ID token noto'g'ri yoki muddati tugagan.",
        );
      }
      this.logger.warn(
        `Google tokeninfo request failed from IP: ${ip}. Status: ${error.response?.status}`,
      );
      throw new ServiceUnavailableException(
        'Google autentifikatsiya xizmatida vaqtincha xatolik yuz berdi.',
      );
    }

    if (!tokenInfo || typeof tokenInfo !== 'object') {
      throw new UnauthorizedException("Google ID token noto'g'ri.");
    }

    // 1. Validate issuer
    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!validIssuers.includes(tokenInfo.iss)) {
      throw new UnauthorizedException("Google token issuer (iss) noto'g'ri.");
    }

    // 2. Validate expiration
    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = Number(tokenInfo.exp);
    if (!exp || exp < nowSeconds) {
      throw new UnauthorizedException('Google ID token muddati tugagan.');
    }

    // 3. Validate audience
    if (!tokenInfo.aud || !allowedClientIds.includes(tokenInfo.aud)) {
      throw new UnauthorizedException(
        'Google token audience (aud) tizimga mos kelmaydi.',
      );
    }

    // 4. Validate email and email verification
    const email = tokenInfo.email?.trim().toLowerCase();
    const isEmailVerified =
      tokenInfo.email_verified === true || tokenInfo.email_verified === 'true';

    if (!email || !isEmailVerified) {
      throw new UnauthorizedException(
        'Google akkauntida email tasdiqlanmagan yoki mavjud emas.',
      );
    }

    // 5. Subject (Google unique user ID)
    const googleId = tokenInfo.sub;
    if (!googleId) {
      throw new UnauthorizedException('Google akkaunt ID (sub) topilmadi.');
    }

    // Safely map verified profile
    const profile: GoogleProfile = {
      email,
      name: tokenInfo.name?.trim() || email.split('@')[0],
      avatar: tokenInfo.picture?.trim() || undefined,
      googleId,
    };

    return this.loginWithGoogle(profile, ip, userAgent);
  }

  async refreshAccessToken(
    refreshToken: string,
    ip = 'unknown',
    userAgent = 'unknown',
  ): Promise<{ accessToken: string; refreshToken: string }> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token topilmadi.');
    }

    const refreshSecret = this.getRefreshSecret();
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: refreshSecret,
      });
    } catch {
      this.logger.warn(
        `Audit Warning: Invalid refresh token signature or expired from IP: ${ip}, UA: ${userAgent}`,
      );
      throw new UnauthorizedException('Refresh token muddati tugagan.');
    }

    if (!payload || !payload.jti) {
      throw new UnauthorizedException("Refresh token noto'g'ri.");
    }

    const { sub: userId, deviceId, jti } = payload;

    // Look up token in DB matching id (jti)
    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { id: jti },
    });

    // Reuse detection
    if (!storedToken || storedToken.revokedAt !== null) {
      this.logger.warn(
        `Audit Warning [REUSE DETECTION]: Refresh token reuse attempt detected! ` +
          `User ID: ${userId}, Device ID: ${deviceId}, Token ID (jti): ${jti}, IP: ${ip}, UA: ${userAgent}, Time: ${new Date().toISOString()}`,
      );
      await this.revokeAllSessions(userId);
      throw new UnauthorizedException(
        'Sessiya bekor qilindi. Iltimos qaytadan kiring.',
      );
    }

    // Mark old token as used and revoked
    await this.prisma.refreshToken.update({
      where: { id: jti },
      data: {
        lastUsedAt: new Date(),
        revokedAt: new Date(),
      },
    });

    const user = await this.usersService.findById(userId);
    const accessToken = await this.signAccessToken(
      user.id,
      user.email!,
      user.role,
    );
    const newRefreshToken = await this.signRefreshToken(
      user.id,
      user.email!,
      user.role,
      deviceId,
    );

    this.logger.log(
      `Audit: Successful token rotation for User: ${userId}, Device: ${deviceId}, IP: ${ip}, UA: ${userAgent}`,
    );

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string | undefined, allDevices = false) {
    if (refreshToken) {
      try {
        const decoded = this.jwtService.decode(refreshToken);
        if (decoded && decoded.sub) {
          if (allDevices) {
            await this.revokeAllSessions(decoded.sub);
          } else {
            await this.revokeSession(decoded.sub, decoded.deviceId);
          }
        }
      } catch {
        // silent
      }
    }
  }

  async revokeSession(userId: string, deviceId: string) {
    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        deviceId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    this.logger.log(
      `Audit: Session revoked for User: ${userId}, Device: ${deviceId}`,
    );
  }

  async revokeAllSessions(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    this.logger.log(`Audit: All sessions revoked for User: ${userId}`);
  }

  async createAdmin(dto: CreateAdminDto) {
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const admin = await this.usersService.createAdmin(
      dto.name,
      dto.email,
      dto.phone,
      hashedPassword,
    );

    return {
      message: 'Yangi admin muvaffaqiyatli yaratildi.',
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        phone: admin.phone,
        role: admin.role,
      },
    };
  }

  private generateOtpCode(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  private async findOrCreateGoogleUser(
    profile: GoogleProfile,
    phoneFromGoogle?: string | null,
  ) {
    const email = profile.email.trim().toLowerCase();
    const rawName = profile.name?.trim();
    const existing = await this.usersService.findByEmail(email);

    if (!existing) {
      const randomPassword = randomBytes(24).toString('hex');
      const hashedPassword = await bcrypt.hash(randomPassword, 10);
      const name = rawName || email.split('@')[0];

      return this.prisma.user.create({
        data: {
          name,
          email,
          phone: phoneFromGoogle ?? '',
          password: hashedPassword,
          role: UserRole.CUSTOMER,
          avatar: profile.avatar ?? null,
        },
      });
    }

    const updates: Record<string, string> = {};
    if (
      rawName &&
      (existing.name.trim().length === 0 || existing.name === existing.email)
    ) {
      updates.name = rawName;
    }
    if (profile.avatar && !existing.avatar) {
      updates.avatar = profile.avatar;
    }
    if (
      phoneFromGoogle &&
      (!existing.phone || existing.phone.trim().length === 0)
    ) {
      updates.phone = phoneFromGoogle;
    }

    if (Object.keys(updates).length === 0) {
      return existing;
    }

    return this.prisma.user.update({
      where: { id: existing.id },
      data: updates,
    });
  }

  async requestForgotPasswordOtp(dto: RequestForgotPasswordDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      return {
        message:
          "Agar ushbu email bazada mavjud bo'lsa, unga tasdiqlash kodi yuborildi.",
      };
    }

    const otp = this.generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.prisma.otpCode.updateMany({
      where: {
        email: dto.email,
        purpose: OtpPurpose.FORGOT_PASSWORD,
        usedAt: null,
      },
      data: {
        usedAt: new Date(),
      },
    });

    await this.prisma.otpCode.create({
      data: {
        email: dto.email,
        code: otp,
        purpose: OtpPurpose.FORGOT_PASSWORD,
        expiresAt,
      },
    });

    try {
      await this.mailService.sendOtpEmail(dto.email, otp);
      return { message: 'Tasdiqlash kodi emailingizga yuborildi.' };
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        return {
          message:
            'SMTP sozlanmagani uchun kod emailga yuborilmadi. Dev rejimda kod qaytarildi.',
          devOtpCode: otp,
        };
      }
      throw new InternalServerErrorException(
        'Tasdiqlash kodini yuborishda xatolik yuz berdi.',
      );
    }
  }

  async resetPassword(dto: ResetPasswordDto) {
    const otpRecord = await this.prisma.otpCode.findFirst({
      where: {
        email: dto.email,
        purpose: OtpPurpose.FORGOT_PASSWORD,
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord || otpRecord.code !== dto.otp) {
      throw new UnauthorizedException(
        "Tasdiqlash kodi noto'g'ri yoki muddati tugagan.",
      );
    }

    if (otpRecord.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Tasdiqlash kodi muddati tugagan.');
    }

    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new NotFoundException('Foydalanuvchi topilmadi.');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    await this.prisma.otpCode.update({
      where: { id: otpRecord.id },
      data: { usedAt: new Date() },
    });

    return { message: "Parol muvaffaqiyatli o'zgartirildi." };
  }

  private async fetchGooglePhone(accessToken?: string): Promise<string | null> {
    if (!accessToken) return null;
    const fetchFn = (globalThis as any).fetch as
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined;
    if (!fetchFn) return null;

    try {
      const response = await fetchFn(
        'https://people.googleapis.com/v1/people/me?personFields=phoneNumbers',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
      if (!response.ok) return null;
      const data = (await response.json()) as {
        phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>;
      };
      const first = data.phoneNumbers?.[0];
      return first?.canonicalForm || first?.value || null;
    } catch {
      return null;
    }
  }

  private normalizePhoneFromGoogle(phone?: string | null): string | null {
    if (!phone) return null;
    const normalized = String(phone)
      .trim()
      .replace(/[^\d+]/g, '');
    if (!normalized) return null;
    return normalized.startsWith('+') ? normalized : `+${normalized}`;
  }

  private buildFullName(firstName: string, lastName: string): string {
    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    const fullName = `${trimmedFirst} ${trimmedLast}`
      .replace(/\s+/g, ' ')
      .trim();

    if (!trimmedFirst || !trimmedLast) {
      throw new BadRequestException(
        "Ism va familiya to'liq kiritilishi kerak.",
      );
    }

    if (fullName.length > 100) {
      throw new BadRequestException(
        'Ism va familiya uzunligi 100 ta belgidan oshmasligi kerak.',
      );
    }

    return fullName;
  }

  private getAccessExpiresIn(): string {
    return this.configService.get<string>('JWT_EXPIRES_IN', '30m');
  }

  private getRefreshExpiresIn(): string {
    return this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d');
  }

  private getRefreshSecret(): string {
    return this.configService.get<string>(
      'JWT_REFRESH_SECRET',
      this.configService.get<string>('JWT_SECRET', 'super-secret-change-me'),
    );
  }

  private hashToken(token: string): string {
    const secret = this.getRefreshSecret();
    return createHmac('sha256', secret).update(token).digest('hex');
  }

  private async signAccessToken(id: string, email: string, role: string) {
    const accessSecret = this.configService.get<string>(
      'JWT_SECRET',
      'super-secret-change-me',
    );
    return this.jwtService.signAsync(
      {
        sub: id,
        email,
        role,
        iss: 'yec-market',
        aud: 'yec-client',
      },
      {
        secret: accessSecret,
        expiresIn: this.getAccessExpiresIn() as any,
      },
    );
  }

  private async signRefreshToken(
    id: string,
    email: string,
    role: string,
    deviceId: string,
  ) {
    const jti = randomBytes(16).toString('hex');
    const refreshSecret = this.getRefreshSecret();
    const token = await this.jwtService.signAsync(
      {
        sub: id,
        email,
        role,
        deviceId,
        jti,
        iss: 'yec-market',
        aud: 'yec-client',
      },
      {
        secret: refreshSecret,
        expiresIn: this.getRefreshExpiresIn() as any,
      },
    );

    const decoded = this.jwtService.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);
    const tokenHash = this.hashToken(token);

    await this.prisma.refreshToken.create({
      data: {
        id: jti,
        tokenHash,
        userId: id,
        deviceId,
        expiresAt,
      },
    });

    return token;
  }

  private async generateTokens(user: any, deviceId?: string) {
    const devId = deviceId || randomBytes(16).toString('hex');
    const accessToken = await this.signAccessToken(
      user.id,
      user.email,
      user.role,
    );
    const refreshToken = await this.signRefreshToken(
      user.id,
      user.email,
      user.role,
      devId,
    );
    return { accessToken, refreshToken };
  }
}
