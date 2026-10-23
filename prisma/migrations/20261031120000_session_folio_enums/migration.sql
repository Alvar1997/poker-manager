-- Folios de sesión S-0001-YYYYMMDD y captura histórica — valor nuevo de enum
-- (en migración aparte para poder usarlo en la siguiente).
ALTER TYPE "PokerSessionStatus" ADD VALUE IF NOT EXISTS 'HISTORICAL';
