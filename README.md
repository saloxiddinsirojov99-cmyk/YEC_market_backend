# YEC Market Backend

NestJS + Prisma + PostgreSQL asosidagi gilam savdosi backend API.

## Asosiy funksiyalar
- JWT auth (admin/customer)
- Register vaqtida email Tasdiqlash kodi tasdiqlash
- Carpet CRUD + filter/search/pagination
- Category CRUD
- Order yaratish (`customerId` JWT dan olinadi)
- Cart preview
- Local image upload
- Swagger hujjatlar: `/docs`
- Barcha xatolik xabarlari o'zbekcha

## Local ishga tushirish
1. `.env.example` nusxasidan `.env` yarating
2. `npm install`
3. `npx prisma generate`
4. `npx prisma migrate dev --name init`
5. `node prisma/seed.js`
6. `npm run start:dev`

API base: `http://localhost:3001/api/v1`
Swagger: `http://localhost:3001/docs`

## Form-data endpointlar
Quyidagi body endpointlar `multipart/form-data` formatida ishlaydi:

### Auth
- `POST /api/v1/auth/register/request-otp`
- `POST /api/v1/auth/register/verify-otp`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/admins` (admin)

### Categories (admin)
- `POST /api/v1/categories`
- `PATCH /api/v1/categories/:id`

### Carpets
- `POST /api/v1/carpets` (admin)
- `PATCH /api/v1/carpets/:id` (admin)

### Orders
- `POST /api/v1/orders` (customer, auth required)
- `PATCH /api/v1/orders/:id/status` (admin)

### Cart
- `POST /api/v1/cart/preview`

### Upload
- `POST /api/v1/upload/image` (admin, file maydoni: `file`)

## Query endpointlar
- `GET /api/v1/carpets?search=&categoryId=&size=&minPrice=&maxPrice=&page=1&limit=10`
- `GET /api/v1/carpets/:id`
- `GET /api/v1/categories`
- `GET /api/v1/orders?page=1&limit=10&status=NEW` (admin)

## Docker
- `docker compose up --build`
