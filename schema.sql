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

-- ------------------------------------------------------------------
-- PT샵 체성분 변화 기록 (/tracker)
--
-- 위 members 테이블(칼로리 계산기)과는 별개입니다.
--
-- 로그인은 "이름 + 전화번호 뒷 4자리"로 회원을 찾되,
--   · 회원 id 는 무작위 UUID 라서 이름/번호로 역산할 수 없고
--   · 로그인하면 무작위 세션 토큰을 발급해, 모든 조회·기록·삭제는 그 토큰으로만 한다
--   · DB 에는 토큰 원문이 아니라 SHA-256 해시만 저장한다 (DB 가 새도 세션은 안 샘)
--   · 틀린 로그인은 IP·이름 단위로 횟수를 제한해 뒷 4자리 대입을 막는다
-- 트레이너 화면은 칼로리 계산기 /admin 과 같은 ADMIN_KEY 시크릿으로 연다.
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pt_members (
  id           TEXT PRIMARY KEY,          -- 무작위 UUID
  name         TEXT NOT NULL,             -- 화면에 보이는 이름
  name_key     TEXT NOT NULL,             -- 찾기용: 공백 제거 + 소문자
  phone4       TEXT NOT NULL,
  consent_at   TEXT,                      -- 개인정보·건강정보 수집 동의 시각
  created_by   TEXT NOT NULL DEFAULT 'self', -- 'self' 또는 'trainer'
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pt_members_login ON pt_members (name_key, phone4);
CREATE INDEX IF NOT EXISTS idx_pt_members_updated ON pt_members (updated_at DESC);

CREATE TABLE IF NOT EXISTS pt_entries (
  id              TEXT PRIMARY KEY,       -- 무작위 UUID
  member_id       TEXT NOT NULL,
  measured_at     TEXT NOT NULL,          -- 측정일 (YYYY-MM-DD)
  height          REAL NOT NULL,
  weight          REAL NOT NULL,
  body_fat_pct    REAL,                   -- 체지방률 (%)
  skeletal_muscle REAL,                   -- 골격근량 (kg)
  bmi             REAL,
  memo            TEXT,
  created_by      TEXT NOT NULL DEFAULT 'self',
  created_at      TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES pt_members(id)
);

CREATE INDEX IF NOT EXISTS idx_pt_entries_member ON pt_entries (member_id, measured_at);

CREATE TABLE IF NOT EXISTS pt_sessions (
  token_hash   TEXT PRIMARY KEY,          -- SHA-256(토큰) — 원문은 저장하지 않음
  member_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pt_sessions_member ON pt_sessions (member_id);

-- 로그인 시도 횟수 제한 (bucket = 'ip:…' / 'name:…' / 'reg:…')
CREATE TABLE IF NOT EXISTS pt_attempts (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  reset_at     INTEGER NOT NULL           -- epoch ms
);
