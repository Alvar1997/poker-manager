-- Módulo 18 (simplificado): tipos y valores de enum (ADD VALUE va en su propia migración).
-- CreateEnum
CREATE TYPE "RakeMode" AS ENUM ('MANUAL', 'FINAL_COUNT');

-- CreateEnum
CREATE TYPE "RakeMovementKind" AS ENUM ('MANUAL_ENTRY', 'CORRECTION');

-- CreateEnum
CREATE TYPE "StaffTipCountStatus" AS ENUM ('DRAFT', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "StaffTipEntryKind" AS ENUM ('PARTIAL', 'CORRECTION');

-- AlterEnum
ALTER TYPE "ClosureDiscrepancyResolution" ADD VALUE 'CLOSED_WITH_REASON';


-- AlterEnum (Módulo 18: arqueo de cierre aceptado con diferencia y motivo).
ALTER TYPE "ChipReconciliationStatus" ADD VALUE 'ACCEPTED_WITH_DIFFERENCE';
