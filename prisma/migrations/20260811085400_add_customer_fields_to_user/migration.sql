-- CreateEnum
CREATE TYPE "CustomerSource" AS ENUM ('OFFLINE', 'WEBSITE', 'BOTH');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "customerSource" "CustomerSource",
ADD COLUMN     "isCustomer" BOOLEAN NOT NULL DEFAULT false;
