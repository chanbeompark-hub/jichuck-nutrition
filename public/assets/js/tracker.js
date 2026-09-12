/**
 * 체성분 변화 기록 (/tracker) — 화면 로직
 *
 * 서버는 worker/index.js 의 /api/pt/* 라우트.
 *
 * 회원: 이름 + 전화번호 뒷 4자리로 로그인하면 서버가 무작위 세션 토큰을 준다.
 *       이 브라우저에는 그 토큰만 저장하고, 모든 조회·기록·삭제는 토큰으로 한다.
 * 트레이너: 칼로리 계산기 /admin 과 같은 관리자 키(ADMIN_KEY)로 들어간다.
 */
(function () {
  'use strict';

  var API = '/api/pt';
  var TOKEN_KEY = 'pt_tracker_token_v2';
  var ADMIN_KEY_STORE = 'ng.adminkey';     // /admin 과 같은 저장 키 — 한 번 열면 양쪽에서 쓰인다

  /* ================================================================ 공통 */

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function store(kind) {
    var s = kind === 'session' ? window.sessionStorage : window.localStorage;
    return {
      get: function (k) { try { return s.getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { s.setItem(k, v); } catch (e) { /* 저장 불가 브라우저 */ } },
      del: function (k) { try { s.removeItem(k); } catch (e) { /* noop */ } }
    };
  }
  var local = store('local');
  var session = store('session');

  function call(method, path, body, headers) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    var opts = { method: method, headers: h };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function (r) {
      return r.json()
        .catch(function () { return { ok: false, error: '서버 응답을 이해하지 못했어요.' }; })
        .then(function (data) { return { status: r.status, data: data }; });
    }, function () {
      return { status: 0, data: { ok: false, error: '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.' } };
    });
  }

  function memberCall(method, path, body) {
    return call(method, path, body, { Authorization: 'Bearer ' + (local.get(TOKEN_KEY) || '') });
  }

  function adminCall(method, path, body) {
    return call(method, path, body, { 'X-Admin-Key': session.get(ADMIN_KEY_STORE) || '' });
  }

  // 한국 시간 기준 오늘
  function todayStr() {
    var d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }
  function fmtShort(s) { var p = String(s).split('-'); return p[1] + '/' + p[2]; }
  function fmtFull(s)  { var p = String(s).split('-'); return p[0] + '.' + p[1] + '.' + p[2]; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function num(v) { var x = parseFloat(v); return isFinite(x) ? x : null; }
  function has(v) { return v !== null && v !== undefined && v !== ''; }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function banner(msg, kind) {
    return '<div class="banner ' + (kind === 'ok' ? 'banner-ok' : 'banner-err') + '">' +
      '<div class="banner-dot"></div><div>' + esc(msg) + '</div></div>';
  }

  /* ================================================================ 측정 항목 */

  // 그래프·요약에 쓰는 항목. 키는 성인이면 거의 안 변해서 그래프에서 뺐다.
  var METRICS = {
    weight:          { label: '체중',     unit: 'kg', color: '--chart-weight', wash: '--chart-weight-wash' },
    body_fat_kg:     { label: '체지방량', unit: 'kg', color: '--chart-fat',    wash: '--chart-fat-wash' },
    body_fat_pct:    { label: '체지방률', unit: '%',  color: '--chart-fat',    wash: '--chart-fat-wash' },
    skeletal_muscle: { label: '골격근량', unit: 'kg', color: '--chart-muscle', wash: '--chart-muscle-wash' }
  };

  // 체성분은 2주에 한 번 재는 것을 권장한다 (그보다 잦으면 수분·식사 변동에 묻힌다)
  var RECOMMEND_DAYS = 14;

  function addDays(dateStr, days) {
    var d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(from, to) {
    return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
  }
  // 마지막 측정일 기준 다음 권장일과 남은 일수
  function nextDue(lastDate) {
    if (!lastDate) return null;
    var due = addDays(lastDate, RECOMMEND_DAYS);
    return { due: due, left: daysBetween(todayStr(), due) };
  }

  function deltaText(cur, first, unit) {
    var d = r1(cur - first);
    if (d === 0) return '시작과 같음';
    return (d > 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(1) + unit + ' (시작 대비)';
  }

  /* ================================================================ 그래프 */

  function niceStep(range) {
    var raw = range / 4;
    var mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var norm = raw / mag;
    var step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  }

  function renderChart(container, allEntries, metric) {
    var meta = METRICS[metric];
    var entries = allEntries.filter(function (e) { return has(e[metric]); });
    container.innerHTML = '';

    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = allEntries.length
        ? meta.label + ' 기록이 아직 없어요. 인바디 측정값을 입력하면 여기에 그려져요.'
        : '표시할 기록이 아직 없어요.';
      container.appendChild(empty);
      return;
    }

    var color = cssVar(meta.color), wash = cssVar(meta.wash), unit = meta.unit;
    var values = entries.map(function (e) { return e[metric]; });
    var vmin = Math.min.apply(null, values), vmax = Math.max.apply(null, values);
    if (vmin === vmax) { vmin -= 1; vmax += 1; }
    var pad = (vmax - vmin) * 0.18;
    var step = niceStep((vmax + pad) - (vmin - pad));
    var lo = Math.floor((vmin - pad) / step) * step, hi = Math.ceil((vmax + pad) / step) * step;

    // 실제 화면 폭으로 그려야 글씨가 줄어들지 않는다 (640 으로 그려 300px 에 넣으면 축 글씨가 5px 가 된다)
    var W = Math.round(Math.max(300, Math.min(760, container.clientWidth || 640)));
    var small = W < 480;
    var H = small ? 220 : 260, ML = small ? 38 : 46, MR = small ? 14 : 18, MT = 20, MB = 28;
    var plotW = W - ML - MR, plotH = H - MT - MB;
    var xAt = function (i) { return entries.length === 1 ? ML + plotW / 2 : ML + plotW * i / (entries.length - 1); };
    var yAt = function (v) { return MT + plotH - ((v - lo) / (hi - lo)) * plotH; };

    var NS = 'http://www.w3.org/2000/svg';
    var mk = function (tag, attrs) {
      var el = document.createElementNS(NS, tag);
      for (var k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    };

    var svg = mk('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'chart-svg', role: 'img',
                          'aria-label': meta.label + ' 변화 그래프' });

    for (var v = lo; v <= hi + 1e-9; v += step) {
      var y = yAt(v);
      svg.appendChild(mk('line', { x1: ML, x2: W - MR, y1: y, y2: y, 'class': 'grid-line' }));
      var t = mk('text', { x: ML - 8, y: y + 3.5, 'text-anchor': 'end', 'class': 'axis-label' });
      t.textContent = r1(v);
      svg.appendChild(t);
    }

    var stride = Math.max(1, Math.ceil(entries.length / (small ? 4 : 6)));
    entries.forEach(function (e, i) {
      if (i % stride !== 0 && i !== entries.length - 1) return;
      var t = mk('text', { x: xAt(i), y: H - 8, 'text-anchor': 'middle', 'class': 'axis-label' });
      t.textContent = fmtShort(e.measured_at);
      svg.appendChild(t);
    });

    var pts = entries.map(function (e, i) { return xAt(i) + ',' + yAt(e[metric]); }).join(' ');
    svg.appendChild(mk('polygon', {
      points: xAt(0) + ',' + yAt(lo) + ' ' + pts + ' ' + xAt(entries.length - 1) + ',' + yAt(lo), fill: wash
    }));
    svg.appendChild(mk('polyline', {
      points: pts, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));
    entries.forEach(function (e, i) {
      svg.appendChild(mk('circle', {
        cx: xAt(i), cy: yAt(e[metric]), r: i === entries.length - 1 ? 5 : 4,
        fill: color, stroke: cssVar('--surface'), 'stroke-width': 2
      }));
    });

    var last = entries[entries.length - 1], ex = xAt(entries.length - 1);
    var endLbl = mk('text', {
      x: Math.min(ex + 8, W - MR - 2), y: yAt(last[metric]) - 10,
      'text-anchor': ex > W - MR - 50 ? 'end' : 'start', 'class': 'end-label'
    });
    endLbl.textContent = Number(last[metric]).toFixed(1) + unit;
    svg.appendChild(endLbl);

    var cross = mk('line', { y1: MT, y2: MT + plotH, stroke: cssVar('--ink-3'), 'stroke-width': 1,
                             'stroke-dasharray': '2,2' });
    cross.style.opacity = '0';
    svg.appendChild(cross);

    var wrap = document.createElement('div');
    wrap.className = 'chart-pos';
    wrap.appendChild(svg);
    var tip = document.createElement('div');
    tip.className = 'tooltip';
    wrap.appendChild(tip);
    container.appendChild(wrap);

    function onMove(evt) {
      var ctm = svg.getScreenCTM();
      if (!ctm) return;
      var p = svg.createSVGPoint();
      var src = evt.touches ? evt.touches[0] : evt;
      p.x = src.clientX; p.y = src.clientY;
      var loc = p.matrixTransform(ctm.inverse());
      var idx = 0, best = Infinity;
      entries.forEach(function (_, i) {
        var d = Math.abs(xAt(i) - loc.x);
        if (d < best) { best = d; idx = i; }
      });
      var e = entries[idx];
      cross.setAttribute('x1', xAt(idx)); cross.setAttribute('x2', xAt(idx));
      cross.style.opacity = '1';
      var scale = svg.getBoundingClientRect().width / W;
      tip.style.left = (xAt(idx) * scale) + 'px';
      tip.style.top = (yAt(e[metric]) * scale - 10) + 'px';
      tip.innerHTML = '<div>' + esc(fmtFull(e.measured_at)) + '</div><div class="t-val">' +
        Number(e[metric]).toFixed(1) + unit + '</div>';
      tip.style.opacity = '1';
    }
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerdown', onMove);
    svg.addEventListener('pointerleave', function () { cross.style.opacity = '0'; tip.style.opacity = '0'; });
  }

  /* ================================================================ 상세 블록 (회원·트레이너 공용) */

  function statTile(label, value, delta, cls) {
    return '<div class="stat-tile' + (cls ? ' ' + cls : '') + '"><div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value tab-nums">' + esc(value) + '</div>' +
      '<div class="stat-delta">' + esc(delta) + '</div></div>';
  }

  // 다음 측정 권장일 타일 (마지막 측정 + 2주)
  function dueTile(lastDate) {
    var nd = nextDue(lastDate);
    if (!nd) return '';
    var when = nd.left > 0 ? nd.left + '일 남았어요'
             : nd.left === 0 ? '오늘이 그날이에요'
             : Math.abs(nd.left) + '일 지났어요';
    return statTile('다음 측정 권장일', fmtFull(nd.due), when, nd.left <= 0 ? 'due-now' : '');
  }

  // 항목별 "첫 값 → 최근 값" (그 항목을 잰 기록만 본다)
  function firstLast(entries, key) {
    var xs = entries.filter(function (e) { return has(e[key]); });
    return xs.length ? { first: xs[0][key], last: xs[xs.length - 1][key], n: xs.length } : null;
  }

  // opts.onDelete(entryId) 가 있으면 줄마다 삭제 버튼을 단다.
  function mountDetail(root, member, opts) {
    opts = opts || {};
    var metric = 'weight';
    var entries = [];

    root.innerHTML =
      '<div class="card">' +
        '<div class="member-head">' +
          '<div><div class="member-name">' + esc(member.name) + '</div>' +
          '<div class="member-meta mono">전화 ****' + esc(member.phone4) + '</div></div>' +
          '<a class="calc-link js-calc-link" href="/" hidden>이 체중으로 식단 계산하기 →</a>' +
        '</div>' +
        '<div class="stat-grid js-stats" style="margin-top:16px;"></div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="chart-card-head">' +
          '<p class="card-title js-chart-title" style="margin:0;">체중 변화</p>' +
          '<div class="metric-toggle" role="tablist" aria-label="그래프 항목">' +
            Object.keys(METRICS).map(function (k, i) {
              return '<button type="button" role="tab" data-metric="' + k + '" aria-selected="' + (i === 0) + '">' +
                '<span class="sw" style="background:var(' + METRICS[k].color + ')"></span>' + METRICS[k].label + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="chart-wrap js-chart"></div>' +
      '</div>' +
      '<div class="card">' +
        '<p class="card-title">전체 기록</p>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>날짜</th><th class="num">체중</th><th class="num">체지방량</th><th class="num">체지방률</th>' +
          '<th class="num">골격근량</th><th class="num">BMI</th><th>메모</th>' + (opts.onDelete ? '<th></th>' : '') +
        '</tr></thead><tbody class="js-rows"></tbody></table></div>' +
        '<p class="scroll-hint">표를 좌우로 밀면 나머지 항목이 보여요.</p>' +
      '</div>';

    var statsEl = root.querySelector('.js-stats');
    var titleEl = root.querySelector('.js-chart-title');
    var chartEl = root.querySelector('.js-chart');
    var rowsEl = root.querySelector('.js-rows');
    var calcLink = root.querySelector('.js-calc-link');

    root.querySelectorAll('.metric-toggle button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        metric = btn.getAttribute('data-metric');
        root.querySelectorAll('.metric-toggle button').forEach(function (b) {
          b.setAttribute('aria-selected', String(b === btn));
        });
        paint();
      });
    });

    rowsEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.js-del');
      if (!btn || !opts.onDelete) return;
      var id = btn.closest('tr').getAttribute('data-id');
      if (id && confirm('이 기록을 삭제할까요?')) opts.onDelete(id);
    });

    function paint() {
      titleEl.textContent = METRICS[metric].label + ' 변화';
      renderChart(chartEl, entries, metric);

      if (!entries.length) {
        statsEl.innerHTML = '';
        rowsEl.innerHTML = '<tr><td colspan="8" class="empty-row">아직 기록이 없어요.</td></tr>';
        calcLink.hidden = true;
        return;
      }

      var last = entries[entries.length - 1];
      var tiles = [];
      Object.keys(METRICS).forEach(function (k) {
        var fl = firstLast(entries, k);
        if (!fl) return;
        var m = METRICS[k];
        tiles.push(statTile('최근 ' + m.label, Number(fl.last).toFixed(1) + m.unit,
          fl.n > 1 ? deltaText(fl.last, fl.first, m.unit) : '첫 기록'));
      });
      tiles.push(statTile('기록 횟수', entries.length + '회', '최근 ' + fmtFull(last.measured_at)));
      tiles.push(dueTile(last.measured_at));
      statsEl.innerHTML = tiles.join('');

      // 식단 계산기로 최근 키·체중을 넘긴다
      calcLink.href = '/?weight=' + encodeURIComponent(last.weight) + '&height=' + encodeURIComponent(last.height);
      calcLink.hidden = false;

      var cell = function (v) { return has(v) ? Number(v).toFixed(1) : '—'; };
      rowsEl.innerHTML = entries.slice().reverse().map(function (e) {
        return '<tr data-id="' + esc(e.id) + '">' +
          '<td class="mono">' + esc(fmtFull(e.measured_at)) +
            (e.created_by === 'trainer' ? ' <span class="by-trainer" title="트레이너가 입력한 기록">T</span>' : '') + '</td>' +
          '<td class="num mono">' + cell(e.weight) + '</td>' +
          '<td class="num mono">' + cell(e.body_fat_kg) + '</td>' +
          '<td class="num mono">' + cell(e.body_fat_pct) + '</td>' +
          '<td class="num mono">' + cell(e.skeletal_muscle) + '</td>' +
          '<td class="num mono">' + cell(e.bmi) + '</td>' +
          '<td>' + esc(e.memo || '—') + '</td>' +
          (opts.onDelete ? '<td class="row-del"><button type="button" class="link-btn danger js-del">삭제</button></td>' : '') +
          '</tr>';
      }).join('');
    }

    var lastW = 0, resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!root.isConnected || chartEl.clientWidth === lastW) return;
        lastW = chartEl.clientWidth;
        renderChart(chartEl, entries, metric);
      }, 150);
    });

    paint();
    return { update: function (list) { entries = list || []; paint(); }, entries: function () { return entries; } };
  }

  /* ================================================================ 입력 폼 값 읽기 (회원·트레이너 공용) */

  function readEntry(prefix) {
    return {
      measuredAt: $(prefix + 'date').value,
      weight: num($(prefix + 'weight').value),
      height: num($(prefix + 'height').value),
      bodyFat: $(prefix + 'fat').value.trim(),
      bodyFatKg: $(prefix + 'fatkg').value.trim(),
      muscle: $(prefix + 'muscle').value.trim(),
      memo: $(prefix + 'memo').value.trim()
    };
  }

  function checkEntry(e) {
    if (!e.measuredAt) return '측정일을 입력해 주세요.';
    if (e.measuredAt > todayStr()) return '측정일이 오늘보다 뒤일 수 없어요.';
    if (e.weight == null || e.weight < 20 || e.weight > 250) return '체중을 20~250kg 사이로 입력해 주세요.';
    if (e.height == null || e.height < 100 || e.height > 230) return '키를 100~230cm 사이로 입력해 주세요.';
    if (e.bodyFat !== '' && !(num(e.bodyFat) >= 1 && num(e.bodyFat) <= 70)) return '체지방률을 1~70% 사이로 입력해 주세요.';
    if (e.bodyFatKg !== '' && !(num(e.bodyFatKg) >= 0.5 && num(e.bodyFatKg) <= 150)) return '체지방량을 0.5~150kg 사이로 입력해 주세요.';
    if (e.bodyFatKg !== '' && num(e.bodyFatKg) > e.weight) return '체지방량이 체중보다 많아요. 값을 확인해 주세요.';
    if (e.muscle !== '' && !(num(e.muscle) >= 5 && num(e.muscle) <= 100)) return '골격근량을 5~100kg 사이로 입력해 주세요.';
    return null;
  }

  function savedText(e) {
    var parts = ['체중 ' + e.weight.toFixed(1) + 'kg'];
    if (e.bodyFatKg !== '') parts.push('체지방량 ' + num(e.bodyFatKg).toFixed(1) + 'kg');
    if (e.bodyFat !== '') parts.push('체지방률 ' + num(e.bodyFat).toFixed(1) + '%');
    if (e.muscle !== '') parts.push('골격근량 ' + num(e.muscle).toFixed(1) + 'kg');
    return parts.join(' · ');
  }

  // 체지방률과 체지방량은 체중으로 서로 환산된다. 한쪽을 넣으면 다른 쪽을 채워 준다.
  // 사용자가 직접 고친 칸은 덮어쓰지 않는다.
  function bindFatFields(prefix) {
    var w = $(prefix + 'weight'), pct = $(prefix + 'fat'), kg = $(prefix + 'fatkg');
    var typed = null;   // 마지막으로 사람이 직접 친 칸

    function sync() {
      var W = num(w.value);
      if (!W) return;
      if (typed === 'pct' && num(pct.value) != null) {
        kg.value = r1(W * num(pct.value) / 100).toFixed(1);
        kg.dataset.auto = '1';
      } else if (typed === 'kg' && num(kg.value) != null) {
        pct.value = r1(num(kg.value) / W * 100).toFixed(1);
        pct.dataset.auto = '1';
      }
    }
    pct.addEventListener('input', function () { typed = 'pct'; delete pct.dataset.auto; if (pct.value === '') kg.value = ''; sync(); });
    kg.addEventListener('input',  function () { typed = 'kg';  delete kg.dataset.auto;  if (kg.value === '')  pct.value = ''; sync(); });
    // 체중을 고치면 자동으로 채워 둔 쪽만 다시 계산한다
    w.addEventListener('input', function () {
      if (typed) sync();
      else if (num(pct.value) != null && kg.dataset.auto) { typed = 'pct'; sync(); typed = null; }
    });
    return function reset() { typed = null; delete pct.dataset.auto; delete kg.dataset.auto; };
  }

  function busy(btn, on, idle) {
    btn.disabled = on;
    btn.textContent = on ? '처리 중…' : idle;
  }

  /* ================================================================ 화면 전환 */

  function show(view) {
    ['view-login', 'view-member', 'view-admin'].forEach(function (id) { $(id).hidden = id !== view; });
  }

  function setUserbar(name, role) {
    $('userbar').hidden = !name;
    $('userbar-name').textContent = name ? name + (role === '트레이너' ? '' : '님') : '';
    $('userbar-role').textContent = role || '';
  }

  /* ================================================================ 로그인 · 등록 */

  function initLogin() {
    var form = $('login-form');
    var err = $('login-error');
    var regBox = $('register-box');

    function values() {
      return { name: $('l-name').value.trim(), phone4: $('l-phone').value.trim() };
    }
    function valid(v) {
      if (!v.name) return '이름을 입력해 주세요.';
      if (!/^[0-9]{4}$/.test(v.phone4)) return '전화번호 뒷 4자리를 숫자 4개로 입력해 주세요.';
      return null;
    }

    // 이름이나 번호를 고치면 등록 안내를 접는다
    ['l-name', 'l-phone'].forEach(function (id) {
      $(id).addEventListener('input', function () { regBox.hidden = true; err.innerHTML = ''; });
    });

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      err.innerHTML = '';
      var v = values(), msg = valid(v);
      if (msg) { err.innerHTML = banner(msg); return; }

      var btn = $('login-btn');
      busy(btn, true, '로그인');
      var res = await call('POST', '/login', v);
      busy(btn, false, '로그인');

      if (res.data.ok) { local.set(TOKEN_KEY, res.data.token); enterMember(); return; }
      if (res.data.code === 'not_found') {
        regBox.hidden = false;
        $('reg-who').textContent = v.name + ' · ****' + v.phone4;
        regBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      err.innerHTML = banner(res.data.error || '로그인하지 못했어요.');
    });

    $('register-btn').addEventListener('click', async function () {
      err.innerHTML = '';
      var v = values(), msg = valid(v);
      if (msg) { err.innerHTML = banner(msg); return; }
      if (!$('reg-consent').checked) {
        err.innerHTML = banner('개인정보·건강정보 수집에 동의해야 등록할 수 있어요.');
        return;
      }
      var btn = $('register-btn');
      busy(btn, true, '동의하고 등록');
      var res = await call('POST', '/register', { name: v.name, phone4: v.phone4, consent: true });
      busy(btn, false, '동의하고 등록');

      if (res.data.ok) { local.set(TOKEN_KEY, res.data.token); enterMember(); return; }
      err.innerHTML = banner(res.data.error || '등록하지 못했어요.');
    });

    $('trainer-login-link').addEventListener('click', function () {
      $('trainer-box').hidden = !$('trainer-box').hidden;
      if (!$('trainer-box').hidden) $('t-key').focus();
    });

    $('trainer-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var key = $('t-key').value.trim();
      var terr = $('trainer-error');
      terr.innerHTML = '';
      if (!key) { terr.innerHTML = banner('관리자 키를 입력해 주세요.'); return; }
      session.set(ADMIN_KEY_STORE, key);
      var res = await adminCall('GET', '/admin/list');
      if (!res.data.ok) {
        session.del(ADMIN_KEY_STORE);
        terr.innerHTML = banner(res.status === 401 ? '관리자 키가 올바르지 않아요.' : (res.data.error || '열지 못했어요.'));
        return;
      }
      $('t-key').value = '';
      enterAdmin(res.data.rows);
    });
  }

  /* ================================================================ 회원 화면 */

  var memberDetail = null;
  var memberBound = false;

  async function enterMember() {
    var res = await memberCall('GET', '/me');
    if (!res.data.ok) {
      local.del(TOKEN_KEY);
      show('view-login');
      setUserbar(null);
      if (res.status !== 401) $('login-error').innerHTML = banner(res.data.error || '기록을 불러오지 못했어요.');
      return;
    }

    show('view-member');
    setUserbar(res.data.name, '회원');
    $('sub-text').textContent = '측정할 때마다 기록하고, 지금까지의 변화를 확인하세요.';

    memberDetail = mountDetail($('self-progress'), { name: res.data.name, phone4: res.data.phone4 }, {
      onDelete: async function (id) {
        var d = await memberCall('DELETE', '/entry', { entryId: id });
        if (!d.data.ok) { $('add-result').innerHTML = banner(d.data.error || '삭제하지 못했어요.'); return; }
        await reloadMember();
      }
    });
    memberDetail.update(res.data.entries);
    prefillHeight(res.data.entries, 'f-');

    if (memberBound) return;
    memberBound = true;
    $('f-date').value = todayStr();
    $('f-date').max = todayStr();
    var resetFat = bindFatFields('f-');

    $('entry-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var out = $('add-result');
      out.innerHTML = '';
      var e = readEntry('f-'), msg = checkEntry(e);
      if (msg) { out.innerHTML = banner(msg); return; }

      var btn = $('submit-btn');
      busy(btn, true, '기록 저장');
      var r = await memberCall('POST', '/entry', e);
      busy(btn, false, '기록 저장');

      if (r.status === 401) { expired(); return; }
      if (!r.data.ok) { out.innerHTML = banner(r.data.error || '저장하지 못했어요.'); return; }
      out.innerHTML = banner('저장했어요. ' + savedText(e), 'ok');
      ['f-weight', 'f-fat', 'f-fatkg', 'f-muscle', 'f-memo'].forEach(function (id) { $(id).value = ''; });
      resetFat();
      $('f-date').value = todayStr();
      await reloadMember();
    });

    $('self-delete-btn').addEventListener('click', async function () {
      if (!confirm('내 기록을 모두 삭제할까요? 되돌릴 수 없어요.')) return;
      await memberCall('POST', '/forget');
      local.del(TOKEN_KEY);
      location.reload();
    });
  }

  async function reloadMember() {
    var res = await memberCall('GET', '/me');
    if (res.status === 401) { expired(); return; }
    if (res.data.ok) { memberDetail.update(res.data.entries); prefillHeight(res.data.entries, 'f-'); }
  }

  // 키는 거의 안 바뀌니 마지막 값을 미리 채워 둔다
  function prefillHeight(entries, prefix) {
    var h = $(prefix + 'height');
    if (entries && entries.length && !h.value) h.value = entries[entries.length - 1].height;
  }

  function expired() {
    local.del(TOKEN_KEY);
    alert('로그인이 만료됐어요. 다시 로그인해 주세요.');
    location.reload();
  }

  /* ================================================================ 트레이너 화면 */

  var adminBound = false;
  var adminCurrent = null;   // 지금 열어 둔 회원 id

  function enterAdmin(rows) {
    show('view-admin');
    setUserbar('트레이너', '트레이너');
    $('sub-text').textContent = '전체 회원의 기록을 보고, 회원 대신 측정값을 입력할 수 있어요.';
    renderAdminList(rows || []);

    if (adminBound) return;
    adminBound = true;

    ['manage', 'add'].forEach(function (t) {
      $('atab-' + t).addEventListener('click', function () {
        ['manage', 'add'].forEach(function (o) {
          $('apanel-' + o).hidden = o !== t;
          $('atab-' + o).setAttribute('aria-selected', String(o === t));
        });
      });
    });

    var timer = null;
    $('manage-search').addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(loadAdminList, 250);
    });

    $('admin-back-btn').addEventListener('click', function () {
      adminCurrent = null;
      $('admin-detail').hidden = true;
      $('manage-list-card').hidden = false;
      loadAdminList();
    });

    $('admin-delete-member-btn').addEventListener('click', async function () {
      if (!adminCurrent) return;
      var name = $('admin-detail').getAttribute('data-name');
      if (!confirm(name + ' 회원의 기록을 모두 삭제할까요? 되돌릴 수 없어요.')) return;
      var r = await adminCall('DELETE', '/admin/member', { id: adminCurrent });
      if (r.status === 401) { adminExpired(); return; }
      $('admin-back-btn').click();
    });

    $('manage-body').addEventListener('click', function (ev) {
      var tr = ev.target.closest('tr[data-id]');
      if (tr) openAdminDetail(tr.getAttribute('data-id'));
    });

    $('af-date').value = todayStr();
    $('af-date').max = todayStr();
    var resetAdminFat = bindFatFields('af-');

    $('admin-entry-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var out = $('admin-add-result');
      out.innerHTML = '';
      var name = $('af-name').value.trim(), phone4 = $('af-phone').value.trim();
      if (!name) { out.innerHTML = banner('회원 이름을 입력해 주세요.'); return; }
      if (!/^[0-9]{4}$/.test(phone4)) { out.innerHTML = banner('전화번호 뒷 4자리를 숫자 4개로 입력해 주세요.'); return; }
      var e = readEntry('af-'), msg = checkEntry(e);
      if (msg) { out.innerHTML = banner(msg); return; }

      e.name = name; e.phone4 = phone4;
      e.consentConfirmed = $('af-consent').checked;

      var btn = $('admin-submit-btn');
      busy(btn, true, '기록 저장');
      var r = await adminCall('POST', '/admin/entry', e);
      busy(btn, false, '기록 저장');

      if (r.status === 401) { adminExpired(); return; }
      if (!r.data.ok) {
        if (r.data.code === 'needs_consent') $('af-consent-box').classList.add('attention');
        out.innerHTML = banner(r.data.error || '저장하지 못했어요.');
        return;
      }
      out.innerHTML = banner(name + '님 ' + (r.data.created ? '신규 등록 후 ' : '') + '기록을 저장했어요. ' + savedText(e), 'ok');
      ['af-weight', 'af-fat', 'af-fatkg', 'af-muscle', 'af-memo'].forEach(function (id) { $(id).value = ''; });
      resetAdminFat();
      $('af-consent').checked = false;
      $('af-consent-box').classList.remove('attention');
    });
  }

  async function loadAdminList() {
    var q = $('manage-search').value.trim();
    var r = await adminCall('GET', '/admin/list' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (r.status === 401) { adminExpired(); return; }
    if (!r.data.ok) {
      $('manage-body').innerHTML = '<div class="empty-state"><strong>목록을 불러오지 못했어요</strong><span>' +
        esc(r.data.error || '') + '</span></div>';
      return;
    }
    renderAdminList(r.data.rows);
  }

  function renderAdminList(rows) {
    var q = $('manage-search').value.trim();
    $('member-count').textContent = rows.length ? '· ' + rows.length + '명' : '';
    if (!rows.length) {
      $('manage-body').innerHTML = '<div class="empty-state"><strong>' +
        (q ? '검색 결과가 없어요' : '아직 등록된 회원이 없어요') +
        '</strong><span>회원이 직접 등록하거나, \'기록 추가\' 탭에서 대신 입력할 수 있어요.</span></div>';
      return;
    }
    var cell = function (v, d) { return has(v) ? Number(v).toFixed(d == null ? 1 : d) : '—'; };
    $('manage-body').innerHTML =
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>이름</th><th>전화</th><th class="num">체중</th><th>체중 변화</th>' +
        '<th class="num">체지방량</th><th class="num">체지방률</th><th class="num">골격근량</th>' +
        '<th class="num">기록</th><th>최근 측정</th><th>다음 측정</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (m) {
        var delta = (m.entry_count || 0) < 2 ? '첫 기록'
          : (has(m.first_weight) && has(m.last_weight) ? deltaText(m.last_weight, m.first_weight, 'kg') : '—');
        return '<tr class="clickable" data-id="' + esc(m.id) + '">' +
          '<td class="strong">' + esc(m.name) + '</td>' +
          '<td class="mono">****' + esc(m.phone4) + '</td>' +
          '<td class="num">' + cell(m.last_weight) + '</td>' +
          '<td class="mono">' + esc(delta) + '</td>' +
          '<td class="num">' + cell(m.last_body_fat_kg) + '</td>' +
          '<td class="num">' + cell(m.last_body_fat) + '</td>' +
          '<td class="num">' + cell(m.last_muscle) + '</td>' +
          '<td class="num">' + (m.entry_count || 0) + '</td>' +
          '<td class="mono">' + esc(m.last_measured_at ? fmtFull(m.last_measured_at) : '—') + '</td>' +
          dueCell(m.last_measured_at) + '</tr>';
      }).join('') +
      '</tbody></table></div><p class="scroll-hint">표를 좌우로 밀면 나머지 항목이 보여요.</p>';
  }

  // 명단의 "다음 측정" 칸 — 지났으면 눈에 띄게
  function dueCell(lastDate) {
    var nd = nextDue(lastDate);
    if (!nd) return '<td class="mono">—</td>';
    if (nd.left > 0)  return '<td class="mono">' + esc(fmtFull(nd.due)) + ' (' + nd.left + '일)</td>';
    if (nd.left === 0) return '<td class="mono due-now">오늘</td>';
    return '<td class="mono due-over">' + Math.abs(nd.left) + '일 지남</td>';
  }

  async function openAdminDetail(id) {
    adminCurrent = id;
    $('manage-list-card').hidden = true;
    $('admin-detail').hidden = false;
    var body = $('admin-detail-body');
    body.innerHTML = '<div class="empty-state">불러오는 중…</div>';

    var r = await adminCall('GET', '/admin/member?id=' + encodeURIComponent(id));
    if (r.status === 401) { adminExpired(); return; }
    if (!r.data.ok) {
      body.innerHTML = '<div class="empty-state"><strong>불러오지 못했어요</strong><span>' + esc(r.data.error || '') + '</span></div>';
      return;
    }
    $('admin-detail').setAttribute('data-name', r.data.name);

    var detail = mountDetail(body, { name: r.data.name, phone4: r.data.phone4 }, {
      onDelete: async function (entryId) {
        var d = await adminCall('DELETE', '/admin/entry', { entryId: entryId });
        if (d.status === 401) { adminExpired(); return; }
        var again = await adminCall('GET', '/admin/member?id=' + encodeURIComponent(id));
        if (again.data.ok) detail.update(again.data.entries);
      }
    });
    detail.update(r.data.entries);
  }

  function adminExpired() {
    session.del(ADMIN_KEY_STORE);
    alert('관리자 키가 더 이상 맞지 않아요. 다시 입력해 주세요.');
    location.reload();
  }

  /* ================================================================ 로그아웃 · 시작 */

  $('logout-btn').addEventListener('click', async function () {
    if (!$('view-admin').hidden) {
      session.del(ADMIN_KEY_STORE);
    } else {
      await memberCall('POST', '/logout');
      local.del(TOKEN_KEY);
    }
    location.reload();
  });

  initLogin();

  // 트레이너 키가 이 탭에 살아 있으면 트레이너 화면, 아니면 회원 토큰이 있으면 회원 화면
  // (관리자 키는 sessionStorage 라 이 탭을 닫으면 사라진다)
  (async function boot() {
    if (session.get(ADMIN_KEY_STORE)) {
      var r = await adminCall('GET', '/admin/list');
      if (r.data.ok) { enterAdmin(r.data.rows); return; }
      session.del(ADMIN_KEY_STORE);
    }
    if (local.get(TOKEN_KEY)) { enterMember(); return; }
    show('view-login');
  })();
})();
