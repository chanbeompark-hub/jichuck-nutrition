/**
 * NUTRITION GUIDE — API Worker
 *
 * 정적 파일(public/)은 Cloudflare 가 직접 서빙하고,
 * 이 워커는 /api/* 경로만 처리한다.
 *
 *   POST /api/register     회원 등록 (이름 · 연락처 · 동의)
 *   POST /api/result       마지막 계산 결과 저장
 *   POST /api/forget       본인 기록 삭제
 *   GET  /api/admin/list   전체 조회      (X-Admin-Key 필요)
 *   GET  /api/admin/csv    CSV 내려받기   (X-Admin-Key 필요)
 *   DELETE /api/admin/row  한 건 삭제     (X-Admin-Key 필요)
 *
 *   ---- PT샵 체성분 변화 기록 (/tracker) ----
 *   POST   /api/pt/login           이름 + 뒷 4자리로 로그인 → 세션 토큰 발급
 *   POST   /api/pt/register        처음 등록 (동의 필수) → 세션 토큰 발급
 *   POST   /api/pt/logout          세션 종료
 *   GET    /api/pt/me              내 기록 조회                (Bearer 토큰)
 *   POST   /api/pt/entry           내 기록 추가                (Bearer 토큰)
 *   DELETE /api/pt/entry           내 기록 한 건 삭제          (Bearer 토큰)
 *   POST   /api/pt/forget          내 기록 전체 삭제           (Bearer 토큰)
 *   GET    /api/pt/admin/list      전체 회원 목록              (X-Admin-Key)
 *   GET    /api/pt/admin/member    회원 한 명 상세             (X-Admin-Key)
 *   POST   /api/pt/admin/entry     회원 대신 기록 입력         (X-Admin-Key)
 *   DELETE /api/pt/admin/entry     기록 한 건 삭제             (X-Admin-Key)
 *   DELETE /api/pt/admin/member    회원 전체 삭제              (X-Admin-Key)
 */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const bad = (message, status = 400) => json({ ok: false, error: message }, status);

/* ------------------------------------------------------------------ 검증 */

function cleanName(v) {
  var s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  if (s.length < 1 || s.length > 40) return null;
  return s;
}

function cleanPhone(v) {
  var s = String(v == null ? '' : v).trim();
  var digits = s.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  // 010-1234-5678 형태로 정규화 (국내 휴대폰이면)
  if (digits.length === 11 && digits.charAt(0) === '0') {
    return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
  }
  if (digits.length === 10 && digits.charAt(0) === '0') {
    return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  }
  return digits;
}

function cleanId(v) {
  var s = String(v == null ? '' : v).trim();
  return /^[0-9a-f-]{16,64}$/i.test(s) ? s : null;
}

var ALLOWED = {
  sex:      ['male', 'female'],
  activity: ['low', 'mid', 'high', 'vhigh'],
  goal:     ['cut', 'keep', 'gain']
};

function pickEnum(field, v) {
  var s = String(v == null ? '' : v);
  return ALLOWED[field].indexOf(s) >= 0 ? s : null;
}

function n(v, lo, hi) {
  var x = Number(v);
  if (!isFinite(x)) return null;
  if (x < lo || x > hi) return null;
  return x;
}

async function readJson(request) {
  var ct = request.headers.get('content-type') || '';
  if (ct.indexOf('application/json') < 0) return null;
  try {
    var body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ 관리자 */

// 타이밍 공격을 피하려고 길이와 내용을 상수 시간에 가깝게 비교한다
function keyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function requireAdmin(request, env) {
  var expected = env.ADMIN_KEY;
  if (!expected) {
    return bad('ADMIN_KEY 가 설정되지 않았습니다. wrangler secret put ADMIN_KEY 로 먼저 지정하세요.', 503);
  }
  var given = request.headers.get('X-Admin-Key') || '';
  if (!keyMatches(given, expected)) return bad('관리자 키가 올바르지 않습니다.', 401);
  return null;
}

/* ------------------------------------------------------------------ 핸들러 */

async function handleRegister(request, env) {
  var body = await readJson(request);
  if (!body) return bad('요청 형식이 올바르지 않습니다.');

  var name  = cleanName(body.name);
  var phone = cleanPhone(body.phone);
  if (!name)  return bad('이름을 확인해 주세요.');
  if (!phone) return bad('연락처를 확인해 주세요.');
  if (body.consent !== true) return bad('개인정보 수집에 동의해야 시작할 수 있습니다.');

  var id  = cleanId(body.id) || crypto.randomUUID();
  var now = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO members (id, name, phone, consent_at, created_at, updated_at, calc_count) ' +
    'VALUES (?1, ?2, ?3, ?4, ?4, ?4, 0) ' +
    'ON CONFLICT(id) DO UPDATE SET name = ?2, phone = ?3, updated_at = ?4'
  ).bind(id, name, phone, now).run();

  return json({ ok: true, id: id, name: name });
}

async function handleResult(request, env) {
  var body = await readJson(request);
  if (!body) return bad('요청 형식이 올바르지 않습니다.');

  var id = cleanId(body.id);
  if (!id) return bad('등록 정보를 찾을 수 없습니다. 처음 화면부터 다시 시작해 주세요.', 404);

  var f = body.form || {};
  var r = body.result || {};
  var now = new Date().toISOString();

  var row = {
    sex:      pickEnum('sex', f.sex),
    age:      n(f.age, 14, 90),
    height:   n(f.height, 130, 220),
    weight:   n(f.weight, 30, 200),
    activity: pickEnum('activity', f.activity),
    goal:     pickEnum('goal', f.goal),
    meals:    n(f.meals, 1, 8),
    targetWeight: n(f.targetWeight, 30, 200),
    weeks:    n(f.weeks, 1, 104),
    bmr:      n(r.bmr, 0, 6000),
    tdee:     n(r.tdee, 0, 12000),
    target:   n(r.target, 0, 12000),
    carb:     n(r.carb, 0, 2000),
    protein:  n(r.protein, 0, 1000),
    fat:      n(r.fat, 0, 1000)
  };

  var res = await env.DB.prepare(
    'UPDATE members SET ' +
    ' updated_at = ?2, calc_count = calc_count + 1,' +
    ' sex = ?3, age = ?4, height = ?5, weight = ?6, activity = ?7, goal = ?8, meals = ?9,' +
    ' target_weight = ?10, weeks = ?11,' +
    ' bmr = ?12, tdee = ?13, target_kcal = ?14, carb_g = ?15, protein_g = ?16, fat_g = ?17 ' +
    'WHERE id = ?1'
  ).bind(
    id, now,
    row.sex, row.age, row.height, row.weight, row.activity, row.goal, row.meals,
    row.targetWeight, row.weeks,
    row.bmr, row.tdee, row.target, row.carb, row.protein, row.fat
  ).run();

  if (!res.meta || res.meta.changes === 0) {
    return bad('등록 정보를 찾을 수 없습니다. 처음 화면부터 다시 시작해 주세요.', 404);
  }
  return json({ ok: true });
}

async function handleForget(request, env) {
  var body = await readJson(request);
  if (!body) return bad('요청 형식이 올바르지 않습니다.');
  var id = cleanId(body.id);
  if (!id) return bad('삭제할 기록이 없습니다.', 404);

  await env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

var LIST_COLUMNS =
  'id, name, phone, created_at, updated_at, calc_count, sex, age, height, weight, ' +
  'activity, goal, meals, target_weight, weeks, bmr, tdee, target_kcal, carb_g, protein_g, fat_g';

async function handleAdminList(request, env) {
  var denied = requireAdmin(request, env);
  if (denied) return denied;

  var url   = new URL(request.url);
  var limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
  var q     = (url.searchParams.get('q') || '').trim();

  var stmt;
  if (q) {
    stmt = env.DB.prepare(
      'SELECT ' + LIST_COLUMNS + ' FROM members WHERE name LIKE ?1 OR phone LIKE ?1 ' +
      'ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?2'
    ).bind('%' + q + '%', limit);
  } else {
    stmt = env.DB.prepare(
      'SELECT ' + LIST_COLUMNS + ' FROM members ' +
      'ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?1'
    ).bind(limit);
  }

  var out   = await stmt.all();
  var count = await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first();

  return json({ ok: true, total: count ? count.n : 0, rows: out.results || [] });
}

// 워커는 UTC 로 도니 한국 시간으로 바꿔서 내보낸다
function kst(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  d = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  var p = function (x) { return String(x).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
         ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

function csvCell(v) {
  if (v == null) return '';
  var s = String(v);
  // 엑셀 수식 주입 방지
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

async function handleAdminCsv(request, env) {
  var denied = requireAdmin(request, env);
  if (denied) return denied;

  var out = await env.DB.prepare(
    'SELECT ' + LIST_COLUMNS + ' FROM members ORDER BY COALESCE(updated_at, created_at) DESC'
  ).all();

  var SEX = { male: '남성', female: '여성' };
  var ACT = { low: '낮음', mid: '보통', high: '높음', vhigh: '매우높음' };
  var GOAL = { cut: '다이어트', keep: '유지', gain: '증량' };

  var header = ['이름', '연락처', '등록일시', '최근계산', '계산횟수', '성별', '나이', '키(cm)',
                '체중(kg)', '활동수준', '목표', '식사횟수', '목표체중(kg)', '기간(주)',
                'BMR', 'TDEE', '목표kcal', '탄수(g)', '단백질(g)', '지방(g)'];

  var lines = [header.map(csvCell).join(',')];
  (out.results || []).forEach(function (r) {
    lines.push([
      r.name, r.phone, kst(r.created_at), kst(r.updated_at), r.calc_count,
      SEX[r.sex] || r.sex, r.age, r.height, r.weight,
      ACT[r.activity] || r.activity, GOAL[r.goal] || r.goal, r.meals,
      r.target_weight, r.weeks,
      r.bmr, r.tdee, r.target_kcal, r.carb_g, r.protein_g, r.fat_g
    ].map(csvCell).join(','));
  });

  var stamp = new Date().toISOString().slice(0, 10);
  // 엑셀이 한글을 깨뜨리지 않도록 BOM 을 붙인다
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="nutrition-guide-' + stamp + '.csv"',
      'Cache-Control': 'no-store'
    }
  });
}

async function handleAdminDelete(request, env) {
  var denied = requireAdmin(request, env);
  if (denied) return denied;

  var body = await readJson(request);
  var id = body ? cleanId(body.id) : null;
  if (!id) return bad('삭제할 id 가 올바르지 않습니다.');

  var res = await env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(id).run();
  return json({ ok: true, deleted: res.meta ? res.meta.changes : 0 });
}

/* ------------------------------------------------------------------ PT샵 체성분 변화 기록 */

// 로그인은 "이름 + 전화번호 뒷 4자리"로 회원을 찾기만 한다.
// 찾은 뒤에는 무작위 세션 토큰을 발급하고, 조회·기록·삭제는 전부 그 토큰으로만 허용한다.
// 회원 id 는 무작위 UUID 라 이름/번호로 역산할 수 없다.

var PT_SESSION_DAYS = 90;

// 한 사람의 뒷 4자리를 맞히려면 평균 5,000번을 시도해야 한다.
// 이름 단위 제한(1시간 30회)이 그걸 몇 주 단위로 늘려 한 사람을 지킨다.
// IP 제한은 여러 이름을 훑는 걸 늦추는 용도라 넉넉하게 둔다 —
// 체육관 와이파이는 회원 전원이 같은 IP 이고, 신규 회원은 첫 로그인이 '없음'으로 집계되기 때문.
var PT_LIMITS = {
  nameFail: { max: 30,  windowMs: 60 * 60 * 1000 },  // 이름 당 틀린 로그인: 1시간에 30회
  ipFail:   { max: 100, windowMs: 15 * 60 * 1000 },  // IP 당 틀린 로그인: 15분에 100회
  register: { max: 60,  windowMs: 60 * 60 * 1000 }   // IP 당 신규 등록: 1시간에 60회
};

var PT_NEED_LOGIN = '로그인이 만료됐어요. 다시 로그인해 주세요.';

function ptNameKey(name) {
  return name.replace(/\s+/g, '').toLowerCase();
}

function cleanPhone4(v) {
  var s = String(v == null ? '' : v).trim();
  return /^[0-9]{4}$/.test(s) ? s : null;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'local';
}

function toHex(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function randomToken() {
  var b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

async function sha256hex(s) {
  var d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return toHex(new Uint8Array(d));
}

// 한국 시간 기준 오늘 (YYYY-MM-DD)
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function ptRound1(x) {
  return x == null ? null : Math.round(x * 10) / 10;
}

function ptBmi(height, weight) {
  if (!height || !weight) return null;
  var m = height / 100;
  return ptRound1(weight / (m * m));
}

/* ---- 시도 횟수 제한 ---- */

async function rateBlocked(env, bucket, limit) {
  var row = await env.DB.prepare('SELECT count, reset_at FROM pt_attempts WHERE bucket = ?1')
    .bind(bucket).first();
  if (!row || row.reset_at < Date.now()) return false;
  return row.count >= limit.max;
}

async function rateHit(env, bucket, limit) {
  var now = Date.now();
  await env.DB.prepare(
    'INSERT INTO pt_attempts (bucket, count, reset_at) VALUES (?1, 1, ?2) ' +
    'ON CONFLICT(bucket) DO UPDATE SET ' +
    ' count    = CASE WHEN reset_at < ?3 THEN 1  ELSE count + 1 END,' +
    ' reset_at = CASE WHEN reset_at < ?3 THEN ?2 ELSE reset_at  END'
  ).bind(bucket, now + limit.windowMs, now).run();
}

/* ---- 세션 ---- */

async function ptIssueSession(env, memberId) {
  var token = randomToken();
  var now = new Date();
  var exp = new Date(now.getTime() + PT_SESSION_DAYS * 86400000);
  await env.DB.prepare(
    'INSERT INTO pt_sessions (token_hash, member_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)'
  ).bind(await sha256hex(token), memberId, now.toISOString(), exp.toISOString()).run();
  return token;
}

function bearerToken(request) {
  var m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  return m ? m[1] : null;
}

// Authorization: Bearer <토큰> → 회원. 없거나 만료면 null
async function ptAuth(request, env) {
  var token = bearerToken(request);
  if (!token) return null;
  return await env.DB.prepare(
    'SELECT m.id, m.name, m.phone4 FROM pt_sessions s JOIN pt_members m ON m.id = s.member_id ' +
    'WHERE s.token_hash = ?1 AND s.expires_at > ?2'
  ).bind(await sha256hex(token), new Date().toISOString()).first();
}

/* ---- 기록 값 검증 (회원·트레이너 공용) ---- */

function ptParseEntry(body) {
  var height = n(body.height, 100, 230);
  var weight = n(body.weight, 20, 250);
  if (height == null) return { error: '키를 100~230cm 사이로 입력해 주세요.' };
  if (weight == null) return { error: '체중을 20~250kg 사이로 입력해 주세요.' };

  var blank = function (v) { return v === '' || v == null; };
  var bodyFat = blank(body.bodyFat) ? null : n(body.bodyFat, 1, 70);
  var muscle  = blank(body.muscle)  ? null : n(body.muscle, 5, 100);
  if (!blank(body.bodyFat) && bodyFat == null) return { error: '체지방률을 1~70% 사이로 입력해 주세요.' };
  if (!blank(body.muscle)  && muscle  == null) return { error: '골격근량을 5~100kg 사이로 입력해 주세요.' };

  var today = kstToday();
  var date = String(body.measuredAt || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) date = today;
  if (date > today) return { error: '측정일이 오늘보다 뒤일 수 없어요.' };
  if (date < '2000-01-01') return { error: '측정일을 확인해 주세요.' };

  return {
    height: height, weight: weight, bodyFat: bodyFat, muscle: muscle,
    bmi: ptBmi(height, weight),
    memo: String(body.memo == null ? '' : body.memo).trim().slice(0, 60),
    measuredAt: date
  };
}

async function ptInsertEntry(env, memberId, e, by) {
  var id = crypto.randomUUID();
  var now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO pt_entries (id, member_id, measured_at, height, weight, body_fat_pct, skeletal_muscle, bmi, memo, created_by, created_at) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)'
    ).bind(id, memberId, e.measuredAt, e.height, e.weight, e.bodyFat, e.muscle, e.bmi, e.memo, by, now),
    env.DB.prepare('UPDATE pt_members SET updated_at = ?2 WHERE id = ?1').bind(memberId, now)
  ]);
  return id;
}

var PT_ENTRY_COLUMNS =
  'id, measured_at, height, weight, body_fat_pct, skeletal_muscle, bmi, memo, created_by';

async function ptEntriesOf(env, memberId) {
  var out = await env.DB.prepare(
    'SELECT ' + PT_ENTRY_COLUMNS + ' FROM pt_entries WHERE member_id = ?1 ORDER BY measured_at ASC, created_at ASC'
  ).bind(memberId).all();
  return out.results || [];
}

function ptDeleteMemberStmts(env, memberId) {
  return [
    env.DB.prepare('DELETE FROM pt_entries  WHERE member_id = ?1').bind(memberId),
    env.DB.prepare('DELETE FROM pt_sessions WHERE member_id = ?1').bind(memberId),
    env.DB.prepare('DELETE FROM pt_members  WHERE id = ?1').bind(memberId)
  ];
}

/* ---- 회원용 ---- */

async function handlePtLogin(request, env) {
  var body = await readJson(request);
  if (!body) return bad('요청 형식이 올바르지 않습니다.');

  var name = cleanName(body.name);
  var phone4 = cleanPhone4(body.phone4);
  if (!name) return bad('이름을 확인해 주세요.');
  if (!phone4) return bad('전화번호 뒷 4자리(숫자 4자리)를 확인해 주세요.');

  var nameKey = ptNameKey(name);
  var ipBucket = 'ip:' + clientIp(request);
  var nameBucket = 'name:' + nameKey;

  if (await rateBlocked(env, ipBucket, PT_LIMITS.ipFail) ||
      await rateBlocked(env, nameBucket, PT_LIMITS.nameFail)) {
    return bad('로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.', 429);
  }

  var member = await env.DB.prepare(
    'SELECT id, name FROM pt_members WHERE name_key = ?1 AND phone4 = ?2'
  ).bind(nameKey, phone4).first();

  if (!member) {
    await rateHit(env, ipBucket, PT_LIMITS.ipFail);
    await rateHit(env, nameBucket, PT_LIMITS.nameFail);
    return json({ ok: false, code: 'not_found', error: '이 이름과 번호로 등록된 기록이 없어요.' }, 404);
  }

  var token = await ptIssueSession(env, member.id);
  return json({ ok: true, token: token, name: member.name });
}

async function handlePtRegister(request, env) {
  var body = await readJson(request);
  if (!body) return bad('요청 형식이 올바르지 않습니다.');

  var name = cleanName(body.name);
  var phone4 = cleanPhone4(body.phone4);
  if (!name) return bad('이름을 확인해 주세요.');
  if (!phone4) return bad('전화번호 뒷 4자리(숫자 4자리)를 확인해 주세요.');
  if (body.consent !== true) return bad('개인정보·건강정보 수집에 동의해야 등록할 수 있어요.');

  var regBucket = 'reg:' + clientIp(request);
  if (await rateBlocked(env, regBucket, PT_LIMITS.register)) {
    return bad('등록 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.', 429);
  }
  await rateHit(env, regBucket, PT_LIMITS.register);

  var nameKey = ptNameKey(name);
  var exists = await env.DB.prepare(
    'SELECT id FROM pt_members WHERE name_key = ?1 AND phone4 = ?2'
  ).bind(nameKey, phone4).first();
  if (exists) return bad('이미 등록된 이름과 번호예요. 로그인해 주세요.', 409);

  var id = crypto.randomUUID();
  var now = new Date().toISOString();
  try {
    await env.DB.prepare(
      'INSERT INTO pt_members (id, name, name_key, phone4, consent_at, created_by, created_at, updated_at) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, \'self\', ?5, ?5)'
    ).bind(id, name, nameKey, phone4, now).run();
  } catch (err) {
    // 동시에 같은 이름/번호로 등록한 경우 UNIQUE 인덱스가 막아 준다
    return bad('이미 등록된 이름과 번호예요. 로그인해 주세요.', 409);
  }

  var token = await ptIssueSession(env, id);
  return json({ ok: true, token: token, name: name });
}

async function handlePtMe(request, env) {
  var me = await ptAuth(request, env);
  if (!me) return bad(PT_NEED_LOGIN, 401);
  return json({ ok: true, name: me.name, phone4: me.phone4, entries: await ptEntriesOf(env, me.id) });
}

async function handlePtEntryAdd(request, env) {
  var me = await ptAuth(request, env);
  if (!me) return bad(PT_NEED_LOGIN, 401);

  var body = await readJson(request);
  if (!body) return bad('요청 형식이 올바르지 않습니다.');
  var e = ptParseEntry(body);
  if (e.error) return bad(e.error);

  var id = await ptInsertEntry(env, me.id, e, 'self');
  return json({ ok: true, id: id, bmi: e.bmi });
}

async function handlePtEntryDelete(request, env) {
  var me = await ptAuth(request, env);
  if (!me) return bad(PT_NEED_LOGIN, 401);

  var body = await readJson(request);
  var entryId = body ? cleanId(body.entryId) : null;
  if (!entryId) return bad('삭제할 기록을 찾을 수 없어요.');

  // 본인 기록만 지워진다 — 남의 기록 id 를 넣어도 member_id 가 달라 0건
  var res = await env.DB.prepare('DELETE FROM pt_entries WHERE id = ?1 AND member_id = ?2')
    .bind(entryId, me.id).run();
  if (!res.meta || res.meta.changes === 0) return bad('삭제할 기록을 찾을 수 없어요.', 404);
  return json({ ok: true });
}

async function handlePtLogout(request, env) {
  var token = bearerToken(request);
  if (token) {
    await env.DB.prepare('DELETE FROM pt_sessions WHERE token_hash = ?1').bind(await sha256hex(token)).run();
  }
  return json({ ok: true });
}

async function handlePtForget(request, env) {
  var me = await ptAuth(request, env);
  if (!me) return bad(PT_NEED_LOGIN, 401);
  await env.DB.batch(ptDeleteMemberStmts(env, me.id));
  return json({ ok: true });
}

/* ---- 트레이너용 (칼로리 계산기 /admin 과 같은 ADMIN_KEY) ---- */

async function handlePtAdminList(request, env) {
  var denied = requireAdmin(request, env);
  if (denied) return denied;

  var q = (new URL(request.url).searchParams.get('q') || '').trim();
  var LAST  = 'FROM pt_entries e WHERE e.member_id = m.id ORDER BY measured_at DESC, created_at DESC LIMIT 1';
  var FIRST = 'FROM pt_entries e WHERE e.member_id = m.id ORDER BY measured_at ASC,  created_at ASC  LIMIT 1';
  var SQL =
    'SELECT m.id, m.name, m.phone4, m.created_by, m.created_at, m.updated_at,' +
    ' (SELECT COUNT(*) FROM pt_entries e WHERE e.member_id = m.id) AS entry_count,' +
    ' (SELECT weight '          + LAST  + ') AS last_weight,' +
    ' (SELECT weight '          + FIRST + ') AS first_weight,' +
    ' (SELECT body_fat_pct '    + LAST  + ') AS last_body_fat,' +
    ' (SELECT skeletal_muscle ' + LAST  + ') AS last_muscle,' +
    ' (SELECT bmi '             + LAST  + ') AS last_bmi,' +
    ' (SELECT measured_at '     + LAST  + ') AS last_measured_at' +
    ' FROM pt_members m';

  var stmt = q
    ? env.DB.prepare(SQL + ' WHERE m.name LIKE ?1 OR m.phone4 LIKE ?1 ORDER BY COALESCE(m.updated_at, m.created_at) DESC')
        .bind('%' + q + '%')
    : env.DB.prepare(SQL + ' ORDER BY COALESCE(m.updated_at, m.created_at) DESC');

  var out = await stmt.all();
  return json({ ok: true, rows: out.results || [] });
}

async function handlePtAdminMember(request, env) {
  var denied = requireAdmin(request, env);
  if (denied) return denied;

  var id = cleanId(new URL(request.url).searchParams.get('id'));
  if (!id) return bad('회원 id 가 올바르지 않습니다.');

  var m = await env.DB.prepare('SELECT id, name, phone4, created_by FROM pt_members WHERE id = ?1').bind(id).first();
  if (!m) return bad('회원 정보를 찾을 수 없습니다.', 404);
  return json({ ok: true, id: m.id, name: m.name, phone4: m.phone4, createdBy: m.created_by,
                entries: await ptEntriesOf(env, m.id) });
}

// 회원 대신 기록 입력. memberId 로 지정하거나, 이름+번호로 찾는다.
// 없는 회원이면 consentConfirmed 가 true 일 때만 새로 만든다.
async function handlePtAdminEntry(request, env) {
  var denied = requireAdmin(request, env);
  if (denied) return denied;

  var body = await readJson(request);
  if (!body) return bad('요청 형식이 올바르지 않습니다.');
  var e = ptParseEntry(body);
  if (e.error) return bad(e.error);

  var memberId = null, created = false;

  if (body.memberId) {
    var byId = cleanId(body.memberId);
    var found = byId && await env.DB.prepare('SELECT id FROM pt_members WHERE id = ?1').bind(byId).first();
    if (!found) return bad('회원 정보를 찾을 수 없습니다.', 404);
    memberId = found.id;
  } else {
    var name = cleanName(body.name);
    var phone4 = cleanPhone4(body.phone4);
    if (!name) return bad('이름을 확인해 주세요.');
    if (!phone4) return bad('전화번호 뒷 4자리(숫자 4자리)를 확인해 주세요.');

    var nameKey = ptNameKey(name);
    var row = await env.DB.prepare('SELECT id FROM pt_members WHERE name_key = ?1 AND phone4 = ?2')
      .bind(nameKey, phone4).first();

    if (row) {
      memberId = row.id;
    } else {
      if (body.consentConfirmed !== true) {
        return json({ ok: false, code: 'needs_consent',
                      error: '처음 등록하는 회원이에요. 회원에게 동의를 받은 뒤 확인란을 체크해 주세요.' }, 400);
      }
      memberId = crypto.randomUUID();
      var now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO pt_members (id, name, name_key, phone4, consent_at, created_by, created_at, updated_at) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, \'trainer\', ?5, ?5)'
      ).bind(memberId, name, nameKey, phone4, now).run();
      created = true;
    }
  }

  var id = await ptInsertEntry(env, memberId, e, 'trainer');
  return json({ ok: true, id: id, memberId: memberId, created: created, bmi: e.bmi });
}

async function handlePtAdminDeleteEntry(request, env) {
  var denied = requireAdmin(request, env);
  if (denied) return denied;

  var body = await readJson(request);
  var entryId = body ? cleanId(body.entryId) : null;
  if (!entryId) return bad('삭제할 기록 id 가 올바르지 않습니다.');

  var res = await env.DB.prepare('DELETE FROM pt_entries WHERE id = ?1').bind(entryId).run();
  return json({ ok: true, deleted: res.meta ? res.meta.changes : 0 });
}

async function handlePtAdminDeleteMember(request, env) {
  var denied = requireAdmin(request, env);
  if (denied) return denied;

  var body = await readJson(request);
  var id = body ? cleanId(body.id) : null;
  if (!id) return bad('삭제할 회원 id 가 올바르지 않습니다.');

  await env.DB.batch(ptDeleteMemberStmts(env, id));
  return json({ ok: true });
}

/* ------------------------------------------------------------------ 라우팅 */

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (path.indexOf('/api/') !== 0) {
      // 정적 파일은 Cloudflare 가 직접 서빙하지만, 만약을 위한 폴백
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }

    if (!env.DB) {
      return bad('데이터베이스가 연결되지 않았습니다. wrangler.jsonc 의 d1_databases 설정을 확인하세요.', 503);
    }

    var method = request.method;
    var route = method + ' ' + path;

    try {
      switch (route) {
        case 'POST /api/register':          return await handleRegister(request, env);
        case 'POST /api/result':            return await handleResult(request, env);
        case 'POST /api/forget':            return await handleForget(request, env);
        case 'GET /api/admin/list':         return await handleAdminList(request, env);
        case 'GET /api/admin/csv':          return await handleAdminCsv(request, env);
        case 'DELETE /api/admin/row':       return await handleAdminDelete(request, env);

        case 'POST /api/pt/login':          return await handlePtLogin(request, env);
        case 'POST /api/pt/register':       return await handlePtRegister(request, env);
        case 'POST /api/pt/logout':         return await handlePtLogout(request, env);
        case 'GET /api/pt/me':              return await handlePtMe(request, env);
        case 'POST /api/pt/entry':          return await handlePtEntryAdd(request, env);
        case 'DELETE /api/pt/entry':        return await handlePtEntryDelete(request, env);
        case 'POST /api/pt/forget':         return await handlePtForget(request, env);

        case 'GET /api/pt/admin/list':      return await handlePtAdminList(request, env);
        case 'GET /api/pt/admin/member':    return await handlePtAdminMember(request, env);
        case 'POST /api/pt/admin/entry':    return await handlePtAdminEntry(request, env);
        case 'DELETE /api/pt/admin/entry':  return await handlePtAdminDeleteEntry(request, env);
        case 'DELETE /api/pt/admin/member': return await handlePtAdminDeleteMember(request, env);
      }
    } catch (err) {
      console.error('api error', path, err && err.message);
      return bad('서버에서 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', 500);
    }

    return bad('없는 주소입니다.', 404);
  }
};
