-- NUTRITION GUIDE — 회원 기록 테이블
-- 적용:  npx wrangler d1 execute nutrition-guide-db --remote --file=./schema.sql
-- 로컬:  npx wrangler d1 execute nutrition-guide-db --local  --file=./schema.sql

CREATE TABLE IF NOT EXISTS members (
  id           TEXT PRIMARY KEY,          -- 브라우저마다 발급하는 UUID
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  consent_at   TEXT NOT NULL,             -- 개인정보 수집 동의 시각 (ISO)
  created_at   TEXT NOT NULL,
  updated_at   TEXT,
  calc_count   INTEGER NOT NULL DEFAULT 0, -- 계산 횟수

  -- 마지막으로 계산한 입력값
  sex          TEXT,
  age          INTEGER,
  height       REAL,
  weight       REAL,
  activity     TEXT,
  goal         TEXT,
  meals        INTEGER,
  target_weight REAL,
  weeks        INTEGER,

  -- 마지막 계산 결과
  bmr          INTEGER,
  tdee         INTEGER,
  target_kcal  INTEGER,
  carb_g       INTEGER,
  protein_g    INTEGER,
  fat_g        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_members_created ON members (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_members_updated ON members (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_members_name    ON members (name);
