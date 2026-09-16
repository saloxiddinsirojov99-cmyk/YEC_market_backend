import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
const request = require('supertest');
const cookieParser = require('cookie-parser');
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import * as bcrypt from 'bcrypt';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { resolveUploadsDir } from '../common/utils/uploads-path';

describe('Mobile Preparation Integration Tests (Stage 2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  const testEmail = `test-mobile-prep-${Date.now()}@example.com`;
  const testPhone = `+99899${Math.floor(1000000 + Math.random() * 9000000)}`;
  const testPassword = 'TestPassword123!';
  let testUserId: string;
  let testOrderId: string;
  let testCarpetId: string;
  const createdUploadFiles: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.setGlobalPrefix('api/v1', {
      exclude: ['', 'api/v1', 'health', 'health/ready'],
    });

    await app.init();

    prisma = app.get(PrismaService);
    authService = app.get(AuthService);

    // Create a dedicated clean test customer
    const hashedPassword = await bcrypt.hash(testPassword, 10);
    const testUser = await prisma.user.create({
      data: {
        name: 'Test Mobile User',
        email: testEmail,
        phone: testPhone,
        password: hashedPassword,
        role: 'CUSTOMER',
      },
    });
    testUserId = testUser.id;

    // Find or create a test carpet for order testing
    let carpet = await prisma.carpet.findFirst();
    if (!carpet) {
      carpet = await prisma.carpet.create({
        data: {
          name: 'Test Carpet Spec',
          uniqueCode: `TST-${Date.now()}`,
          patternCode: 'PT-01',
          productType: 'READY',
          shape: 'RECTANGLE',
          price: 500000,
          material: 'Acrylic',
        },
      });
    }
    testCarpetId = carpet.id;
  });

  afterAll(async () => {
    // 1. Clean up test uploads
    const uploadsDir = resolveUploadsDir();
    for (const file of createdUploadFiles) {
      const fullPath = join(uploadsDir, file);
      if (existsSync(fullPath)) {
        try {
          unlinkSync(fullPath);
        } catch {
          // ignore
        }
      }
    }

    // 2. Clean up test order if created
    if (testOrderId) {
      try {
        await prisma.returnRequest.deleteMany({
          where: { orderId: testOrderId },
        });
        await prisma.orderItem.deleteMany({ where: { orderId: testOrderId } });
        await prisma.order.deleteMany({ where: { id: testOrderId } });
      } catch {
        // ignore
      }
    }

    // 3. Clean up test user & refresh tokens
    if (testUserId) {
      try {
        await prisma.refreshToken.deleteMany({ where: { userId: testUserId } });
        await prisma.user.deleteMany({ where: { id: testUserId } });
      } catch {
        // ignore
      }
    }

    try {
      await app.close();
    } catch {
      // ignore Telegraf shutdown warning if bot was not started
    }
  });

  describe('1. Login & Token Flows', () => {
    it('should login for Web: returns cookie, does NOT include refreshToken in JSON body', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: testPassword });

      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.user).toBeDefined();
      expect(res.body.refreshToken).toBeUndefined(); // Web XSS safety!

      // Verify Set-Cookie header contains refreshToken
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some((c: string) => c.includes('refreshToken='))).toBe(
        true,
      );
    });

    it('should login for Mobile (x-client-platform: mobile): returns refreshToken in JSON body AND cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('x-client-platform', 'mobile')
        .send({ email: testEmail, password: testPassword });

      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined(); // Mobile gets token in body!
      expect(res.body.user).toBeDefined();

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some((c: string) => c.includes('refreshToken='))).toBe(
        true,
      );
    });
  });

  describe('2. Refresh Token Flow & Rotation', () => {
    it('should refresh token via HttpOnly Cookie (Web flow)', async () => {
      // 1. Login to obtain cookie
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: testPassword });

      const cookieHeader = loginRes.headers['set-cookie'];

      // 2. Refresh using cookie without body
      const refreshRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieHeader)
        .send({});

      expect(refreshRes.status).toBe(201);
      expect(refreshRes.body.accessToken).toBeDefined();
      expect(refreshRes.body.refreshToken).toBeUndefined(); // Web flow: token in cookie only

      const newCookies = refreshRes.headers['set-cookie'];
      expect(newCookies.some((c: string) => c.includes('refreshToken='))).toBe(
        true,
      );
    });

    it('should refresh token via Request Body without cookie (Mobile flow)', async () => {
      // 1. Login to obtain mobile refresh token
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('x-client-platform', 'mobile')
        .send({ email: testEmail, password: testPassword });

      const mobileRefreshToken = loginRes.body.refreshToken;
      expect(mobileRefreshToken).toBeDefined();

      // 2. Refresh using body without Cookie header
      const refreshRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: mobileRefreshToken });

      expect(refreshRes.status).toBe(201);
      expect(refreshRes.body.accessToken).toBeDefined();
      expect(refreshRes.body.refreshToken).toBeDefined(); // Mobile gets rotated token in body!
      expect(refreshRes.body.refreshToken).not.toBe(mobileRefreshToken); // Token rotated!
    });

    it('should prioritize Cookie when both Cookie and Body are sent simultaneously', async () => {
      // 1. Get valid cookie
      const loginRes1 = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: testPassword });
      const validCookie = loginRes1.headers['set-cookie'];

      // 2. Send valid Cookie with a bogus/expired Body token
      const refreshRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', validCookie)
        .send({
          refreshToken:
            'bogus_body_token_that_should_not_override_valid_cookie',
        });

      // Cookie is prioritized and succeeds!
      expect(refreshRes.status).toBe(201);
      expect(refreshRes.body.accessToken).toBeDefined();
    });

    it('should detect Refresh Token Reuse and revoke all sessions', async () => {
      // 1. Login on mobile
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('x-client-platform', 'mobile')
        .send({ email: testEmail, password: testPassword });

      const initialToken = loginRes.body.refreshToken;

      // 2. Rotate token once
      const rotateRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: initialToken });

      expect(rotateRes.status).toBe(201);

      // 3. Try to reuse the initial token again (Replay attack simulation)
      const reuseRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: initialToken });

      // Must be rejected with 401 Unauthorized
      expect(reuseRes.status).toBe(401);

      // 4. Verify all active refresh tokens for this user have been revoked
      const activeTokens = await prisma.refreshToken.findMany({
        where: { userId: testUserId, revokedAt: null },
      });
      expect(activeTokens.length).toBe(0);
    });
  });

  describe('3. Logout', () => {
    it('should logout via Cookie', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: testPassword });

      const cookieHeader = loginRes.headers['set-cookie'];

      const logoutRes = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookieHeader)
        .send({});

      expect(logoutRes.status).toBe(201);
      expect(logoutRes.body.message).toBe('Chiqish muvaffaqiyatli.');
    });

    it('should logout via Body refreshToken (Mobile)', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('x-client-platform', 'mobile')
        .send({ email: testEmail, password: testPassword });

      const token = loginRes.body.refreshToken;

      const logoutRes = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .send({ refreshToken: token, allDevices: false });

      expect(logoutRes.status).toBe(201);
      expect(logoutRes.body.message).toBe('Chiqish muvaffaqiyatli.');
    });
  });

  describe('4. Google Mobile Auth Endpoint', () => {
    it('should reject invalid/fake Google ID token without leaking internals', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/google/mobile')
        .send({ idToken: 'fake.google.idtoken.signature' });

      // Should be 401 or 503, never exposing raw internal stack or database error
      expect([401, 503]).toContain(res.status);
      expect(res.body.success === false || res.body.message).toBeTruthy();
    });

    it('should reject request when idToken is missing (validation error)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/google/mobile')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should reject when Google token audience does not match allowed client IDs', async () => {
      // Test verifyGoogleIdToken logic with mismatched audience
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          aud: 'unauthorized-malicious-client-id.apps.googleusercontent.com',
          iss: 'https://accounts.google.com',
          exp: String(Math.floor(Date.now() / 1000) + 3600),
          sub: '1234567890',
          email: 'test@example.com',
          email_verified: 'true',
        }),
      } as any);

      try {
        await expect(
          authService.loginWithGoogleMobile('dummy.jwt.token'),
        ).rejects.toThrow();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should handle Google network error/timeout safely without leaking internal errors', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('Network connection timeout'));

      try {
        await expect(
          authService.loginWithGoogleMobile('dummy.jwt.token'),
        ).rejects.toThrow();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('5. Orders - phone2 Optional Verification', () => {
    it('should successfully create order WITHOUT phone2', async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: testPassword });

      const token = loginRes.body.accessToken;

      const orderPayload = {
        customerName: 'Test Customer',
        phone: '+998901234567',
        // phone2 is omitted intentionally!
        address: 'Tashkent, Chilonzor test address',
        locationLat: 41.311081,
        locationLng: 69.279723,
        locationText: 'Tashkent test',
        paymentMethod: 'CASH',
        items: [
          {
            carpetId: testCarpetId,
            quantity: 1,
          },
        ],
        termsAccepted: true,
      };

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${token}`)
        .send(orderPayload);

      expect(res.status).toBe(201);
      const createdOrderId = res.body.order?.id || res.body.id;
      expect(createdOrderId).toBeDefined();

      // Verify created order in DB has phone2 as null/undefined
      const dbOrder = await prisma.order.findUnique({
        where: { id: createdOrderId },
      });
      expect(dbOrder).toBeDefined();
      expect(dbOrder?.phone2).toBeNull();

      // Clean up order created in this test
      if (createdOrderId) {
        await prisma.orderItem.deleteMany({
          where: { orderId: createdOrderId },
        });
        await prisma.order.deleteMany({ where: { id: createdOrderId } });
      }
    });
  });

  describe('6. Customer Return Image Upload', () => {
    let authToken: string;

    beforeAll(async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: testPassword });
      authToken = loginRes.body.accessToken;

      // Create dedicated delivered order for testing return uploads
      const order = await prisma.order.create({
        data: {
          customerId: testUserId,
          customerName: 'Test Return Customer',
          phone: testPhone,
          address: 'Tashkent return test address',
          locationLat: 41.311081,
          locationLng: 69.279723,
          locationText: 'Tashkent return test',
          paymentMethod: 'CASH',
          status: 'DELIVERED',
          deliveryCompletedAt: new Date(),
        },
      });
      testOrderId = order.id;
    });

    it('should reject upload when magic bytes are invalid (e.g. text disguised as jpg)', async () => {
      const fakeJpgBuffer = Buffer.from(
        'This is a plain text file disguised as an image',
      );

      const res = await request(app.getHttpServer())
        .post(`/api/v1/upload/return-image/${testOrderId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', fakeJpgBuffer, 'malicious.jpg');

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('binary');
    });

    it('should reject upload with disallowed MIME type', async () => {
      const textBuffer = Buffer.from('Hello world plain text');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/upload/return-image/${testOrderId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', textBuffer, 'file.txt');

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('format');
    });

    it('should reject upload if file is not attached', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/upload/return-image/${testOrderId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
    });

    it('should reject upload if file exceeds 10MB limit', async () => {
      // 10.5 MB buffer
      const largeBuffer = Buffer.alloc(10.5 * 1024 * 1024);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/upload/return-image/${testOrderId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', largeBuffer, 'huge.jpg');

      expect([400, 413]).toContain(res.status);
    });

    it('should reject upload if order does not belong to user (403 Forbidden)', async () => {
      // Create another user
      const otherUser = await prisma.user.create({
        data: {
          name: 'Other User',
          email: `other-${Date.now()}@example.com`,
          phone: `+99899${Math.floor(1000000 + Math.random() * 9000000)}`,
          role: 'CUSTOMER',
        },
      });

      // Sign token for other user
      const otherToken = await (authService as any).signAccessToken(
        otherUser.id,
        otherUser.email,
        otherUser.role,
      );

      const validPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
      ]);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/upload/return-image/${testOrderId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .attach('file', validPng, 'test.png');

      expect(res.status).toBe(403);

      // Cleanup other user
      await prisma.user.delete({ where: { id: otherUser.id } });
    });

    it('should accept valid PNG with genuine magic bytes for delivered order within 24 hours', async () => {
      // Valid PNG header (8 bytes) + dummy IHDR
      const validPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
      ]);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/upload/return-image/${testOrderId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', validPng, 'proof.png');

      expect(res.status).toBe(201);
      expect(res.body.url).toBeDefined();
      expect(res.body.filename).toBeDefined();
      expect(res.body.url).toContain('/uploads/return-');

      createdUploadFiles.push(res.body.filename);
    });

    it('should reject return image upload if 24 hours have elapsed', async () => {
      // Set deliveryCompletedAt to 25 hours ago
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await prisma.order.update({
        where: { id: testOrderId },
        data: { deliveryCompletedAt: twentyFiveHoursAgo },
      });

      const validPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
      ]);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/upload/return-image/${testOrderId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', validPng, 'late_proof.png');

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('24 soat');
    });
  });

  describe('7. Health Endpoints', () => {
    it('GET /health should return 200 and status', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('GET /health/ready should return 200 with db: true', async () => {
      const res = await request(app.getHttpServer()).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.db).toBe(true);
    });

    it('GET /api/v1 should return API status without exposing credentials', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1');
      expect(res.status).toBe(200);
      expect(res.body.message).toBeDefined();

      // Ensure no credentials/secrets leaked
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('postgresql://');
      expect(bodyStr).not.toContain('password');
    });
  });
});
