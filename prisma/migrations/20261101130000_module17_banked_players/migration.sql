-- Módulo 17 — jugadores bancados por la casa (PRIVADO).
-- Ver docs/MODULE_17_BANKED_PLAYERS.md. Tablas, relaciones y guardas en la base.

-- CreateEnum
CREATE TYPE "ChipPurchaseFunding" AS ENUM ('PLAYER', 'HOUSE');

-- CreateEnum
CREATE TYPE "BankingAgreementStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "BankingCycleStatus" AS ENUM ('IN_PROGRESS', 'READY_FOR_REVIEW', 'UNDER_REVIEW', 'UNDER_REGULARIZATION', 'CLOSED');

-- CreateEnum
CREATE TYPE "BankingGameStatus" AS ENUM ('IN_PROGRESS', 'PENDING_RECONCILIATION', 'CONFIRMED', 'UNDER_CORRECTION');

-- CreateEnum
CREATE TYPE "BankingChangeMode" AS ENUM ('WHOLE_CYCLE', 'FROM_NEXT_GAME');

-- CreateEnum
CREATE TYPE "BankingRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BankingAdvanceStatus" AS ENUM ('AUTHORIZED', 'PARTIALLY_PAID', 'PAID', 'CLOSED');

-- CreateEnum
CREATE TYPE "BankingClosingStatus" AS ENUM ('UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "BankingReserveMovementKind" AS ENUM ('CREATED', 'CONSUMED_BY_LOSS', 'CONSUMED_BY_REGULARIZATION', 'RECLASSIFIED_TO_WITHDRAWAL', 'RELEASED_FROM_WITHDRAWAL');

-- CreateEnum
CREATE TYPE "BankingWithdrawalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'CLOSED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BankingRegularizationKind" AS ENUM ('EXCESS_ADVANCE', 'PHYSICAL_DISCREPANCY');

-- CreateEnum
CREATE TYPE "BankingRegularizationStatus" AS ENUM ('OPEN', 'AWAITING_RETURN', 'RECOVERING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "BankingRegularizationResolution" AS ENUM ('RECOVER_FROM_FUTURE', 'APPLY_RESERVE', 'MONEY_RETURNED', 'DOCUMENTED_WRITE_OFF', 'DISCREPANCY_CLEARED');

-- AlterTable
ALTER TABLE "chip_purchases" ADD COLUMN     "fundingSource" "ChipPurchaseFunding" NOT NULL DEFAULT 'PLAYER';

-- AlterTable
ALTER TABLE "table_participations" ADD COLUMN     "bankingGameId" TEXT;

-- AlterTable
ALTER TABLE "purchase_deliveries" ADD COLUMN     "houseFundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "banking_agreements" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" "BankingAgreementStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banking_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_agreement_versions" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "playerPercent" DECIMAL(5,2) NOT NULL,
    "housePercent" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "changeRequestId" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banking_agreement_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_cycles" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "BankingCycleStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banking_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_percentage_segments" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "fromGameNumber" INTEGER NOT NULL,
    "agreementVersionId" TEXT NOT NULL,
    "playerPercent" DECIMAL(5,2) NOT NULL,
    "housePercent" DECIMAL(5,2) NOT NULL,
    "changeRequestId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banking_percentage_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_games" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "gameNumber" INTEGER NOT NULL,
    "status" "BankingGameStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "financedNominal" DECIMAL(14,2),
    "returnedNominal" DECIMAL(14,2),
    "zeroReturnConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "grossResult" DECIMAL(14,2),
    "returnOperationId" TEXT,
    "discrepancyNotes" TEXT,
    "incidentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "confirmIdempotencyKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banking_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_game_financial_sources" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "nominalAmount" DECIMAL(14,2) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banking_game_financial_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_game_adjustments" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "banking_game_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_percentage_change_requests" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "cycleId" TEXT,
    "fromPlayerPercent" DECIMAL(5,2) NOT NULL,
    "toPlayerPercent" DECIMAL(5,2) NOT NULL,
    "toHousePercent" DECIMAL(5,2) NOT NULL,
    "mode" "BankingChangeMode" NOT NULL,
    "startGameNumber" INTEGER,
    "reason" TEXT NOT NULL,
    "status" "BankingRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNotes" TEXT,
    "beforeCalculation" JSONB,
    "afterCalculation" JSONB,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "banking_percentage_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_advances" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "enablingGameId" TEXT NOT NULL,
    "requestedAmount" DECIMAL(14,2) NOT NULL,
    "authorizedAmount" DECIMAL(14,2) NOT NULL,
    "limitAtRegistration" DECIMAL(14,2) NOT NULL,
    "authorizerId" TEXT NOT NULL,
    "authorizerName" TEXT NOT NULL,
    "channel" "CreditAuthorizationChannel" NOT NULL,
    "status" "BankingAdvanceStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "banking_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_cycle_closings" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BankingClosingStatus" NOT NULL DEFAULT 'UNDER_REVIEW',
    "snapshot" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "grossTotal" DECIMAL(14,2) NOT NULL,
    "previousCarriedLoss" DECIMAL(14,2) NOT NULL,
    "reserveBefore" DECIMAL(14,2) NOT NULL,
    "reserveConsumed" DECIMAL(14,2) NOT NULL,
    "playerShare" DECIMAL(14,2) NOT NULL,
    "houseShare" DECIMAL(14,2) NOT NULL,
    "advancesPaid" DECIMAL(14,2) NOT NULL,
    "recoveryApplied" DECIMAL(14,2) NOT NULL,
    "excessAdvance" DECIMAL(14,2) NOT NULL,
    "reserveAmount" DECIMAL(14,2) NOT NULL,
    "payAmount" DECIMAL(14,2) NOT NULL,
    "carriedLossOut" DECIMAL(14,2) NOT NULL,
    "lossAllocation" JSONB,
    "notes" TEXT,
    "preparedById" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNotes" TEXT,
    "payableId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "approveIdempotencyKey" TEXT,

    CONSTRAINT "banking_cycle_closings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_reserve_movements" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "kind" "BankingReserveMovementKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "closingId" TEXT,
    "withdrawalId" TEXT,
    "regularizationId" TEXT,
    "uniqueKey" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banking_reserve_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_reserve_withdrawals" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "requestedAmount" DECIMAL(14,2) NOT NULL,
    "approvedAmount" DECIMAL(14,2),
    "status" "BankingWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNotes" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "banking_reserve_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_regularizations" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "cycleId" TEXT,
    "closingId" TEXT,
    "gameId" TEXT,
    "kind" "BankingRegularizationKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "BankingRegularizationStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "resolution" "BankingRegularizationResolution",
    "resolutionNotes" TEXT,
    "incidentId" TEXT,
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "banking_regularizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_regularization_recoveries" (
    "id" TEXT NOT NULL,
    "regularizationId" TEXT NOT NULL,
    "closingId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banking_regularization_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banking_regularization_receipts" (
    "id" TEXT NOT NULL,
    "regularizationId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "financialTransactionId" TEXT NOT NULL,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "banking_regularization_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "banking_agreements_idempotencyKey_key" ON "banking_agreements"("idempotencyKey");

-- CreateIndex
CREATE INDEX "banking_agreements_playerId_status_idx" ON "banking_agreements"("playerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "banking_agreement_versions_changeRequestId_key" ON "banking_agreement_versions"("changeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_agreement_versions_agreementId_version_key" ON "banking_agreement_versions"("agreementId", "version");

-- CreateIndex
CREATE INDEX "banking_cycles_status_idx" ON "banking_cycles"("status");

-- CreateIndex
CREATE UNIQUE INDEX "banking_cycles_playerId_number_key" ON "banking_cycles"("playerId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "banking_percentage_segments_changeRequestId_key" ON "banking_percentage_segments"("changeRequestId");

-- CreateIndex
CREATE INDEX "banking_percentage_segments_cycleId_createdAt_idx" ON "banking_percentage_segments"("cycleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "banking_games_returnOperationId_key" ON "banking_games"("returnOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_games_confirmIdempotencyKey_key" ON "banking_games"("confirmIdempotencyKey");

-- CreateIndex
CREATE INDEX "banking_games_status_idx" ON "banking_games"("status");

-- CreateIndex
CREATE UNIQUE INDEX "banking_games_playerId_sessionId_key" ON "banking_games"("playerId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_games_cycleId_gameNumber_key" ON "banking_games"("cycleId", "gameNumber");

-- CreateIndex
CREATE UNIQUE INDEX "banking_game_financial_sources_purchaseId_key" ON "banking_game_financial_sources"("purchaseId");

-- CreateIndex
CREATE INDEX "banking_game_financial_sources_gameId_idx" ON "banking_game_financial_sources"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_game_adjustments_idempotencyKey_key" ON "banking_game_adjustments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "banking_game_adjustments_gameId_idx" ON "banking_game_adjustments"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_percentage_change_requests_idempotencyKey_key" ON "banking_percentage_change_requests"("idempotencyKey");

-- CreateIndex
CREATE INDEX "banking_percentage_change_requests_agreementId_status_idx" ON "banking_percentage_change_requests"("agreementId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "banking_advances_idempotencyKey_key" ON "banking_advances"("idempotencyKey");

-- CreateIndex
CREATE INDEX "banking_advances_playerId_status_idx" ON "banking_advances"("playerId", "status");

-- CreateIndex
CREATE INDEX "banking_advances_cycleId_idx" ON "banking_advances"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_cycle_closings_payableId_key" ON "banking_cycle_closings"("payableId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_cycle_closings_idempotencyKey_key" ON "banking_cycle_closings"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "banking_cycle_closings_approveIdempotencyKey_key" ON "banking_cycle_closings"("approveIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "banking_cycle_closings_cycleId_version_key" ON "banking_cycle_closings"("cycleId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "banking_reserve_movements_uniqueKey_key" ON "banking_reserve_movements"("uniqueKey");

-- CreateIndex
CREATE INDEX "banking_reserve_movements_playerId_createdAt_idx" ON "banking_reserve_movements"("playerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "banking_reserve_withdrawals_idempotencyKey_key" ON "banking_reserve_withdrawals"("idempotencyKey");

-- CreateIndex
CREATE INDEX "banking_reserve_withdrawals_playerId_status_idx" ON "banking_reserve_withdrawals"("playerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "banking_regularizations_closingId_key" ON "banking_regularizations"("closingId");

-- CreateIndex
CREATE INDEX "banking_regularizations_playerId_status_idx" ON "banking_regularizations"("playerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "banking_regularization_recoveries_regularizationId_closingI_key" ON "banking_regularization_recoveries"("regularizationId", "closingId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_regularization_receipts_financialTransactionId_key" ON "banking_regularization_receipts"("financialTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "banking_regularization_receipts_idempotencyKey_key" ON "banking_regularization_receipts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "banking_regularization_receipts_regularizationId_idx" ON "banking_regularization_receipts"("regularizationId");

-- CreateIndex
CREATE UNIQUE INDEX "table_participations_bankingGameId_key" ON "table_participations"("bankingGameId");

-- AddForeignKey
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_bankingGameId_fkey" FOREIGN KEY ("bankingGameId") REFERENCES "banking_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_agreements" ADD CONSTRAINT "banking_agreements_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_agreements" ADD CONSTRAINT "banking_agreements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_agreements" ADD CONSTRAINT "banking_agreements_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_agreement_versions" ADD CONSTRAINT "banking_agreement_versions_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "banking_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_agreement_versions" ADD CONSTRAINT "banking_agreement_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_agreement_versions" ADD CONSTRAINT "banking_agreement_versions_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_cycles" ADD CONSTRAINT "banking_cycles_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_cycles" ADD CONSTRAINT "banking_cycles_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "banking_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_cycles" ADD CONSTRAINT "banking_cycles_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_percentage_segments" ADD CONSTRAINT "banking_percentage_segments_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "banking_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_percentage_segments" ADD CONSTRAINT "banking_percentage_segments_agreementVersionId_fkey" FOREIGN KEY ("agreementVersionId") REFERENCES "banking_agreement_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_percentage_segments" ADD CONSTRAINT "banking_percentage_segments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_games" ADD CONSTRAINT "banking_games_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "banking_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_games" ADD CONSTRAINT "banking_games_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_games" ADD CONSTRAINT "banking_games_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "poker_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_games" ADD CONSTRAINT "banking_games_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_games" ADD CONSTRAINT "banking_games_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_game_financial_sources" ADD CONSTRAINT "banking_game_financial_sources_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "banking_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_game_financial_sources" ADD CONSTRAINT "banking_game_financial_sources_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "chip_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_game_financial_sources" ADD CONSTRAINT "banking_game_financial_sources_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_game_adjustments" ADD CONSTRAINT "banking_game_adjustments_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "banking_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_game_adjustments" ADD CONSTRAINT "banking_game_adjustments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_percentage_change_requests" ADD CONSTRAINT "banking_percentage_change_requests_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "banking_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_percentage_change_requests" ADD CONSTRAINT "banking_percentage_change_requests_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "banking_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_percentage_change_requests" ADD CONSTRAINT "banking_percentage_change_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_percentage_change_requests" ADD CONSTRAINT "banking_percentage_change_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_advances" ADD CONSTRAINT "banking_advances_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_advances" ADD CONSTRAINT "banking_advances_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "banking_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_advances" ADD CONSTRAINT "banking_advances_enablingGameId_fkey" FOREIGN KEY ("enablingGameId") REFERENCES "banking_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_advances" ADD CONSTRAINT "banking_advances_authorizerId_fkey" FOREIGN KEY ("authorizerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_advances" ADD CONSTRAINT "banking_advances_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_advances" ADD CONSTRAINT "banking_advances_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_cycle_closings" ADD CONSTRAINT "banking_cycle_closings_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "banking_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_cycle_closings" ADD CONSTRAINT "banking_cycle_closings_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_cycle_closings" ADD CONSTRAINT "banking_cycle_closings_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_movements" ADD CONSTRAINT "banking_reserve_movements_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_movements" ADD CONSTRAINT "banking_reserve_movements_closingId_fkey" FOREIGN KEY ("closingId") REFERENCES "banking_cycle_closings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_movements" ADD CONSTRAINT "banking_reserve_movements_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "banking_reserve_withdrawals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_movements" ADD CONSTRAINT "banking_reserve_movements_regularizationId_fkey" FOREIGN KEY ("regularizationId") REFERENCES "banking_regularizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_movements" ADD CONSTRAINT "banking_reserve_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_withdrawals" ADD CONSTRAINT "banking_reserve_withdrawals_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_withdrawals" ADD CONSTRAINT "banking_reserve_withdrawals_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_withdrawals" ADD CONSTRAINT "banking_reserve_withdrawals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_reserve_withdrawals" ADD CONSTRAINT "banking_reserve_withdrawals_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularizations" ADD CONSTRAINT "banking_regularizations_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularizations" ADD CONSTRAINT "banking_regularizations_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "banking_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularizations" ADD CONSTRAINT "banking_regularizations_closingId_fkey" FOREIGN KEY ("closingId") REFERENCES "banking_cycle_closings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularizations" ADD CONSTRAINT "banking_regularizations_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "banking_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularizations" ADD CONSTRAINT "banking_regularizations_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularizations" ADD CONSTRAINT "banking_regularizations_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularization_recoveries" ADD CONSTRAINT "banking_regularization_recoveries_regularizationId_fkey" FOREIGN KEY ("regularizationId") REFERENCES "banking_regularizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularization_recoveries" ADD CONSTRAINT "banking_regularization_recoveries_closingId_fkey" FOREIGN KEY ("closingId") REFERENCES "banking_cycle_closings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularization_receipts" ADD CONSTRAINT "banking_regularization_receipts_regularizationId_fkey" FOREIGN KEY ("regularizationId") REFERENCES "banking_regularizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banking_regularization_receipts" ADD CONSTRAINT "banking_regularization_receipts_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ══ Guardas del Módulo 17 ═════════════════════════════════════════════════

-- Cuenta técnica de participaciones de bancaje (idempotente; requiere la
-- Caja Central MAIN; el seed también la crea).
INSERT INTO "financial_accounts" ("id", "kind", "code", "name", "cashBoxId", "isMoney", "scope", "nonNegative", "isActive", "createdAt", "updatedAt")
SELECT 'm17-account-banking-share', 'BANKING_PLAYER_SHARE', 'PARTICIPACIONES_BANCAJE',
       'Participaciones de jugadores bancados', c."id", false, 'GLOBAL', false, true, NOW(), NOW()
FROM "cash_boxes" c WHERE c."code" = 'MAIN'
ON CONFLICT ("kind") DO NOTHING;

-- ── Acuerdos y porcentajes ──────────────────────────────────────────────
CREATE UNIQUE INDEX "banking_agreements_one_active_per_player"
  ON "banking_agreements" ("playerId") WHERE "status" = 'ACTIVE';
ALTER TABLE "banking_agreements" ADD CONSTRAINT "banking_agreements_end_valid"
  CHECK (("status" = 'ACTIVE') = ("endedAt" IS NULL) AND ("status" = 'ACTIVE' OR "endedById" IS NOT NULL));
ALTER TABLE "banking_agreement_versions" ADD CONSTRAINT "banking_agreement_versions_percent_valid"
  CHECK ("version" >= 1 AND "playerPercent" >= 0 AND "playerPercent" <= 100
    AND "housePercent" = 100 - "playerPercent");
ALTER TABLE "banking_percentage_segments" ADD CONSTRAINT "banking_percentage_segments_valid"
  CHECK ("fromGameNumber" BETWEEN 1 AND 4 AND "playerPercent" >= 0 AND "playerPercent" <= 100
    AND "housePercent" = 100 - "playerPercent");
ALTER TABLE "banking_percentage_change_requests" ADD CONSTRAINT "banking_change_requests_valid"
  CHECK ("toPlayerPercent" >= 0 AND "toPlayerPercent" <= 100 AND "toHousePercent" = 100 - "toPlayerPercent"
    AND ("startGameNumber" IS NULL OR "startGameNumber" BETWEEN 1 AND 5)
    AND ("status" = 'PENDING' OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)));

-- ── Jugadas: exactamente 1..4 por ciclo; resultado = devuelto − financiado ──
ALTER TABLE "banking_games" ADD CONSTRAINT "banking_games_number_valid" CHECK ("gameNumber" BETWEEN 1 AND 4);
ALTER TABLE "banking_games" ADD CONSTRAINT "banking_games_result_valid"
  CHECK (("status" IN ('IN_PROGRESS', 'PENDING_RECONCILIATION')
          AND "financedNominal" IS NULL AND "returnedNominal" IS NULL AND "grossResult" IS NULL
          AND "returnOperationId" IS NULL AND "confirmedAt" IS NULL)
     OR ("status" IN ('CONFIRMED', 'UNDER_CORRECTION')
          AND "financedNominal" > 0 AND "returnedNominal" >= 0
          AND "grossResult" = "returnedNominal" - "financedNominal"
          AND "confirmedAt" IS NOT NULL AND "confirmedById" IS NOT NULL
          -- Retorno cero solo con confirmación EXPLÍCITA; con fichas, operación real de entrada.
          AND ("returnedNominal" > 0 OR "zeroReturnConfirmed")
          AND (("returnedNominal" > 0) = ("returnOperationId" IS NOT NULL))));

CREATE FUNCTION "banking_games_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'banking_games no admite DELETE (historial)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cycleId" <> OLD."cycleId" OR NEW."playerId" <> OLD."playerId" OR NEW."sessionId" <> OLD."sessionId"
     OR NEW."gameNumber" <> OLD."gameNumber" THEN
    RAISE EXCEPTION 'Ciclo, jugador, sesión y número de una jugada son inmutables' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('CONFIRMED', 'UNDER_CORRECTION') THEN
    -- El resultado conciliado nunca se reescribe: se corrige con ajustes.
    IF NEW."financedNominal" IS DISTINCT FROM OLD."financedNominal"
       OR NEW."returnedNominal" IS DISTINCT FROM OLD."returnedNominal"
       OR NEW."grossResult" IS DISTINCT FROM OLD."grossResult"
       OR NEW."returnOperationId" IS DISTINCT FROM OLD."returnOperationId"
       OR NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt"
       OR NEW."status" NOT IN ('CONFIRMED', 'UNDER_CORRECTION') THEN
      RAISE EXCEPTION 'Una jugada conciliada es inmutable (se corrige con un ajuste auditado)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "banking_games_guard" BEFORE UPDATE OR DELETE ON "banking_games"
  FOR EACH ROW EXECUTE FUNCTION "banking_games_guard"();

-- Fuente financiada: compra HOUSE del MISMO jugador y sesión de la jugada.
CREATE FUNCTION "banking_sources_insert_guard"() RETURNS trigger AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  SELECT (p."fundingSource" = 'HOUSE' AND p."playerId" = g."playerId" AND p."sessionId" = g."sessionId"
          AND p."nominalAmount" = NEW."nominalAmount")
    INTO ok
    FROM "chip_purchases" p, "banking_games" g
    WHERE p."id" = NEW."purchaseId" AND g."id" = NEW."gameId";
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'La compra no es una compra financiada de esta jugada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "banking_sources_insert_guard" BEFORE INSERT ON "banking_game_financial_sources"
  FOR EACH ROW EXECUTE FUNCTION "banking_sources_insert_guard"();

-- ── Compras financiadas: sin cobros, sin crédito ordinario, origen inmutable ──
CREATE FUNCTION "house_purchases_no_player_money"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "chip_purchases" p WHERE p."id" = NEW."purchaseId" AND p."fundingSource" = 'HOUSE') THEN
    RAISE EXCEPTION 'Una compra financiada por la casa no admite cobros, crédito ni deuda ordinaria' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "purchase_payments_not_house" BEFORE INSERT ON "purchase_payments"
  FOR EACH ROW EXECUTE FUNCTION "house_purchases_no_player_money"();
CREATE TRIGGER "purchase_credit_authorizations_not_house" BEFORE INSERT ON "purchase_credit_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "house_purchases_no_player_money"();
CREATE TRIGGER "player_debts_not_house" BEFORE INSERT ON "player_debts"
  FOR EACH ROW EXECUTE FUNCTION "house_purchases_no_player_money"();

-- chip_purchases_guard (Módulo 16) + origen del financiamiento inmutable.
CREATE OR REPLACE FUNCTION "chip_purchases_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."sequenceNumber" IS NOT NULL THEN
      RAISE EXCEPTION 'Una compra nace como borrador sin numeración';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chip_purchases no admite DELETE (historial)';
  END IF;
  IF NEW."fundingSource" IS DISTINCT FROM OLD."fundingSource" THEN
    RAISE EXCEPTION 'El origen del financiamiento de una compra es inmutable';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'Una compra cancelada o revertida es inmutable';
  END IF;
  IF OLD."status" = 'CONFIRMED' THEN
    IF NEW."status" = 'REVERSED'
       AND EXISTS (SELECT 1 FROM "purchase_reversals" r WHERE r."purchaseId" = OLD."id")
       AND NEW."nominalAmount" = OLD."nominalAmount"
       AND NEW."folio" = OLD."folio"
       AND NEW."sessionId" = OLD."sessionId"
       AND NEW."sessionTableId" = OLD."sessionTableId"
       AND NEW."idempotencyKey" = OLD."idempotencyKey"
       AND NEW."createdById" = OLD."createdById"
       AND NEW."playerId" = OLD."playerId"
       AND NEW."tableId" = OLD."tableId"
       AND NEW."cycleId" = OLD."cycleId"
       AND NEW."participationId" = OLD."participationId"
       AND NEW."confirmedAt" IS NOT DISTINCT FROM OLD."confirmedAt"
       AND NEW."confirmedById" IS NOT DISTINCT FROM OLD."confirmedById"
       AND NEW."sequenceNumber" IS NOT DISTINCT FROM OLD."sequenceNumber"
       AND NEW."purchaseType" IS NOT DISTINCT FROM OLD."purchaseType"
       AND NEW."rebuyNumber" IS NOT DISTINCT FROM OLD."rebuyNumber" THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Una compra confirmada es inmutable (solo un reverso ejecutado la marca REVERSED)';
  END IF;
  IF NEW."folio" IS DISTINCT FROM OLD."folio"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."sessionTableId" IS DISTINCT FROM OLD."sessionTableId"
     OR NEW."cycleId" IS DISTINCT FROM OLD."cycleId"
     OR NEW."participationId" IS DISTINCT FROM OLD."participationId"
     OR NEW."playerId" IS DISTINCT FROM OLD."playerId"
     OR NEW."tableId" IS DISTINCT FROM OLD."tableId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" THEN
    RAISE EXCEPTION 'Jugador, mesa, participación, folio y creador de una compra son inmutables';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'La versión de una compra no retrocede';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Entregas: pagos + por cobrar + financiado por la casa = importe. Una
-- entrega financiada no tiene pagos ni saldo por cobrar (y viceversa).
ALTER TABLE "purchase_deliveries" DROP CONSTRAINT IF EXISTS "purchase_deliveries_amounts_valid";
ALTER TABLE "purchase_deliveries" ADD CONSTRAINT "purchase_deliveries_amounts_valid"
  CHECK ("nominalAmount" > 0 AND "confirmedPayments" >= 0 AND "pendingTransfers" >= 0
         AND "outstandingAmount" >= 0 AND "pendingTransfers" <= "outstandingAmount"
         AND "houseFundedAmount" >= 0
         AND ("houseFundedAmount" = 0 OR ("confirmedPayments" = 0 AND "outstandingAmount" = 0))
         AND "confirmedPayments" + "outstandingAmount" + "houseFundedAmount" = "nominalAmount");
CREATE FUNCTION "purchase_deliveries_house_matches"() RETURNS trigger AS $$
BEGIN
  IF (NEW."houseFundedAmount" > 0) IS DISTINCT FROM EXISTS (
       SELECT 1 FROM "chip_purchases" p WHERE p."id" = NEW."purchaseId" AND p."fundingSource" = 'HOUSE') THEN
    RAISE EXCEPTION 'Solo una compra financiada por la casa registra entrega financiada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "purchase_deliveries_house_matches" BEFORE INSERT ON "purchase_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "purchase_deliveries_house_matches"();

-- ── Participaciones: salida por liquidación O por jugada conciliada ─────────
ALTER TABLE "table_participations" DROP CONSTRAINT IF EXISTS "table_participations_valid";
ALTER TABLE "table_participations" ADD CONSTRAINT "table_participations_valid"
  CHECK (("status" = 'ACTIVE' OR ("leftAt" IS NOT NULL AND "leftById" IS NOT NULL))
         AND ("status" NOT IN ('SETTLING', 'SETTLED') OR "settlementId" IS NOT NULL
              OR ("status" = 'SETTLED' AND "bankingGameId" IS NOT NULL))
         AND NOT ("settlementId" IS NOT NULL AND "bankingGameId" IS NOT NULL));

-- ── Cortes: snapshot inmutable; una aprobada y una en revisión por ciclo ────
CREATE UNIQUE INDEX "banking_closings_one_approved_per_cycle"
  ON "banking_cycle_closings" ("cycleId") WHERE "status" = 'APPROVED';
CREATE UNIQUE INDEX "banking_closings_one_under_review_per_cycle"
  ON "banking_cycle_closings" ("cycleId") WHERE "status" = 'UNDER_REVIEW';
ALTER TABLE "banking_cycle_closings" ADD CONSTRAINT "banking_closings_amounts_valid"
  CHECK ("version" >= 1 AND "previousCarriedLoss" >= 0 AND "reserveBefore" >= 0
    AND "reserveConsumed" >= 0 AND "reserveConsumed" <= "reserveBefore"
    AND "playerShare" >= 0 AND "houseShare" >= 0 AND "advancesPaid" >= 0
    AND "recoveryApplied" >= 0 AND "excessAdvance" >= 0
    AND "reserveAmount" >= 0 AND "payAmount" >= 0 AND "carriedLossOut" >= 0
    -- Con excedente no hay reparto; sin excedente, reserva + pago = saldo.
    AND ("excessAdvance" = 0 OR ("reserveAmount" = 0 AND "payAmount" = 0))
    AND ("excessAdvance" > 0
         OR "reserveAmount" + "payAmount" = "playerShare" - "advancesPaid" - "recoveryApplied")
    AND ("status" IN ('UNDER_REVIEW', 'SUPERSEDED') OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)));
CREATE FUNCTION "banking_closings_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'banking_cycle_closings no admite DELETE' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'UNDER_REVIEW' THEN
    IF NEW."status" <> OLD."status" OR NEW."payableId" IS DISTINCT FROM OLD."payableId"
       AND NOT (OLD."status" = 'APPROVED' AND OLD."payableId" IS NULL) THEN
      RAISE EXCEPTION 'Un corte decidido es inmutable' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."snapshot" <> OLD."snapshot" OR NEW."snapshotHash" <> OLD."snapshotHash"
     OR NEW."cycleId" <> OLD."cycleId" OR NEW."version" <> OLD."version"
     OR NEW."reserveAmount" <> OLD."reserveAmount" OR NEW."payAmount" <> OLD."payAmount"
     OR NEW."playerShare" <> OLD."playerShare" OR NEW."carriedLossOut" <> OLD."carriedLossOut" THEN
    RAISE EXCEPTION 'El snapshot de un corte es inmutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "banking_closings_guard" BEFORE UPDATE OR DELETE ON "banking_cycle_closings"
  FOR EACH ROW EXECUTE FUNCTION "banking_closings_guard"();

CREATE FUNCTION "banking_cycles_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'banking_cycles no admite DELETE' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CLOSED' AND (NEW."status" <> 'CLOSED' OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt") THEN
    RAISE EXCEPTION 'Un ciclo cerrado es inmutable (se regulariza aparte)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."playerId" <> OLD."playerId" OR NEW."number" <> OLD."number" THEN
    RAISE EXCEPTION 'Jugador y número de un ciclo son inmutables' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "banking_cycles_guard" BEFORE UPDATE OR DELETE ON "banking_cycles"
  FOR EACH ROW EXECUTE FUNCTION "banking_cycles_guard"();
ALTER TABLE "banking_cycles" ADD CONSTRAINT "banking_cycles_valid"
  CHECK ("number" >= 1 AND (("status" = 'CLOSED') = ("closedAt" IS NOT NULL)));

-- ── Reserva: libro de solo inserción y nunca negativa ──────────────────────
ALTER TABLE "banking_reserve_movements" ADD CONSTRAINT "banking_reserve_movements_positive" CHECK ("amount" > 0);
CREATE FUNCTION "banking_reserve_nonnegative"() RETURNS trigger AS $$
DECLARE
  bal DECIMAL(14, 2);
BEGIN
  SELECT COALESCE(SUM(CASE WHEN m."kind" IN ('CREATED', 'RELEASED_FROM_WITHDRAWAL') THEN m."amount" ELSE -m."amount" END), 0)
    INTO bal FROM "banking_reserve_movements" m WHERE m."playerId" = NEW."playerId";
  IF bal < 0 THEN
    RAISE EXCEPTION 'La reserva del jugador no puede quedar negativa (sin doble aplicación)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "banking_reserve_nonnegative" AFTER INSERT ON "banking_reserve_movements"
  FOR EACH ROW EXECUTE FUNCTION "banking_reserve_nonnegative"();

-- ── Anticipos, retiros y regularizaciones ──────────────────────────────────
ALTER TABLE "banking_advances" ADD CONSTRAINT "banking_advances_amounts_valid"
  CHECK ("requestedAmount" > 0 AND "authorizedAmount" > 0 AND "authorizedAmount" <= "limitAtRegistration"
    AND (("status" = 'CLOSED') = ("closedAt" IS NOT NULL)));
CREATE TRIGGER "banking_advances_no_delete" BEFORE DELETE ON "banking_advances"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
ALTER TABLE "banking_reserve_withdrawals" ADD CONSTRAINT "banking_withdrawals_amounts_valid"
  CHECK ("requestedAmount" > 0
    AND ("approvedAmount" IS NULL OR ("approvedAmount" > 0 AND "approvedAmount" <= "requestedAmount"))
    AND (("status" IN ('APPROVED', 'PARTIALLY_PAID', 'PAID', 'CLOSED')) = ("approvedAmount" IS NOT NULL)));
CREATE TRIGGER "banking_withdrawals_no_delete" BEFORE DELETE ON "banking_reserve_withdrawals"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
ALTER TABLE "banking_regularizations" ADD CONSTRAINT "banking_regularizations_valid"
  CHECK ("amount" >= 0 AND ("status" <> 'RESOLVED' OR ("resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "resolution" IS NOT NULL)));
CREATE TRIGGER "banking_regularizations_no_delete" BEFORE DELETE ON "banking_regularizations"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
CREATE TRIGGER "banking_agreements_no_delete" BEFORE DELETE ON "banking_agreements"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();
CREATE TRIGGER "banking_change_requests_no_delete" BEFORE DELETE ON "banking_percentage_change_requests"
  FOR EACH ROW EXECUTE FUNCTION "m15_no_delete"();

ALTER TABLE "banking_regularization_recoveries" ADD CONSTRAINT "banking_recoveries_positive" CHECK ("amount" > 0);
ALTER TABLE "banking_regularization_receipts" ADD CONSTRAINT "banking_reg_receipts_positive" CHECK ("amount" > 0);
ALTER TABLE "banking_game_adjustments" ADD CONSTRAINT "banking_adjustments_nonzero" CHECK ("amount" <> 0);
ALTER TABLE "banking_game_financial_sources" ADD CONSTRAINT "banking_sources_positive" CHECK ("nominalAmount" > 0);

-- Lo recuperado y lo devuelto nunca exceden el excedente regularizado.
CREATE FUNCTION "banking_regularization_within"() RETURNS trigger AS $$
DECLARE
  total DECIMAL(14, 2);
  cap DECIMAL(14, 2);
BEGIN
  SELECT r."amount" INTO cap FROM "banking_regularizations" r WHERE r."id" = NEW."regularizationId";
  SELECT COALESCE((SELECT SUM("amount") FROM "banking_regularization_recoveries" WHERE "regularizationId" = NEW."regularizationId"), 0)
       + COALESCE((SELECT SUM("amount") FROM "banking_regularization_receipts" WHERE "regularizationId" = NEW."regularizationId"), 0)
    INTO total;
  IF total > cap THEN
    RAISE EXCEPTION 'Se excede el importe de la regularización (sin doble recuperación)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "banking_recoveries_within" AFTER INSERT ON "banking_regularization_recoveries"
  FOR EACH ROW EXECUTE FUNCTION "banking_regularization_within"();
CREATE TRIGGER "banking_reg_receipts_within" AFTER INSERT ON "banking_regularization_receipts"
  FOR EACH ROW EXECUTE FUNCTION "banking_regularization_within"();

-- Hechos: SOLO INSERCIÓN.
CREATE TRIGGER "banking_agreement_versions_append_only" BEFORE UPDATE OR DELETE ON "banking_agreement_versions"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "banking_percentage_segments_append_only" BEFORE UPDATE OR DELETE ON "banking_percentage_segments"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "banking_game_financial_sources_append_only" BEFORE UPDATE OR DELETE ON "banking_game_financial_sources"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "banking_game_adjustments_append_only" BEFORE UPDATE OR DELETE ON "banking_game_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "banking_reserve_movements_append_only" BEFORE UPDATE OR DELETE ON "banking_reserve_movements"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "banking_regularization_recoveries_append_only" BEFORE UPDATE OR DELETE ON "banking_regularization_recoveries"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
CREATE TRIGGER "banking_regularization_receipts_append_only" BEFORE UPDATE OR DELETE ON "banking_regularization_receipts"
  FOR EACH ROW EXECUTE FUNCTION "m15_append_only"();
