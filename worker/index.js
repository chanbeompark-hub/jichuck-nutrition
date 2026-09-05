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

    try {
      if (method === 'POST'   && path === '/api/register')    return await handleRegister(request, env);
      if (method === 'POST'   && path === '/api/result')      return await handleResult(request, env);
      if (method === 'POST'   && path === '/api/forget')      return await handleForget(request, env);
      if (method === 'GET'    && path === '/api/admin/list')  return await handleAdminList(request, env);
      if (method === 'GET'    && path === '/api/admin/csv')   return await handleAdminCsv(request, env);
      if (method === 'DELETE' && path === '/api/admin/row')   return await handleAdminDelete(request, env);
    } catch (err) {
      console.error('api error', path, err && err.message);
      return bad('서버에서 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', 500);
    }

    return bad('없는 주소입니다.', 404);
  }
};
