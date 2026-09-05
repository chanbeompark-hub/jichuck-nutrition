/* ==========================================================================
   NUTRITION GUIDE — 식단 칼로리 계산기
   엑셀(회원설정 / 자동식단설계 / 자동식단3안)의 계산 로직을 그대로 옮긴 스크립트
   ========================================================================== */
(function () {
  'use strict';

  var FOODS   = window.FOOD_DB || [];
  var PLANS   = window.PLANS   || [];
  var ACTIVITY= window.ACTIVITY|| [];
  var GOALS   = window.GOALS   || [];
  var GUIDE   = window.GUIDE   || {};
  var STORE   = 'ng.form.v2';
  var MEMBER  = 'ng.member.v1';

  var byName = {};
  FOODS.forEach(function (f) { byName[f.n] = f; });

  var $  = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  var num  = function (v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; };
  var r0   = function (n) { return Math.round(n); };
  var r1   = function (n) { return Math.round(n * 10) / 10; };
  var to5  = function (n) { return Math.round(n / 5) * 5; };
  var clamp= function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };
  var fmt  = function (n) {
    var v = r0(n);
    if (v === 0) v = 0;              // -0 이 "-0" 으로 찍히는 것 방지
    return v.toLocaleString('ko-KR');
  };
  var esc  = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  // 가운뎃점이 줄 첫머리에 떨어지지 않게 앞 공백만 줄바꿈 없는 공백으로 바꾼다.
  // ("탄수화물 · 단백질 / · 지방의" → "탄수화물 · 단백질 · / 지방의")
  // 같은 자리에 두 번 돌려도 결과가 같아서 렌더링마다 불러도 안전하다.
  function fixMiddots(root) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue.indexOf(' · ') < 0) continue;
      var tag = n.parentNode && n.parentNode.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      n.nodeValue = n.nodeValue.replace(/ · /g, ' · ');
    }
  }

  var state = null;   // 마지막 계산 결과
  var swaps = {};     // { planId: { carb: '식품명', protein: ..., fat: ... } }

  /* ---------------------------------------------------------------- 셀렉트 */

  function fillSelects() {
    var a = $('activity');
    ACTIVITY.forEach(function (x) {
      a.appendChild(new Option(x.label + ' (×' + x.factor.toFixed(2) + ')', x.key));
    });
    a.value = 'mid';

    var g = $('goal');
    GOALS.forEach(function (x) { g.appendChild(new Option(x.label, x.key)); });
    g.value = 'cut';

    a.addEventListener('change', syncHints);
    g.addEventListener('change', function () { applyGoalDefaults(); syncHints(); });
    syncHints();
  }

  function syncHints() {
    var a = ACTIVITY.filter(function (x) { return x.key === $('activity').value; })[0];
    var g = GOALS.filter(function (x) { return x.key === $('goal').value; })[0];
    $('activityHint').textContent = a ? a.desc : '';
    $('goalHint').textContent     = g ? g.desc : '';
  }

  // 목표를 바꾸면 단백질·지방 기준을 그 목표의 기본값으로 되돌린다
  function applyGoalDefaults() {
    var g = GOALS.filter(function (x) { return x.key === $('goal').value; })[0];
    if (!g) return;
    $('proteinPerKg').value = g.protein;
    $('fatPerKg').value     = g.fat;
    $('calAdjust').value    = '';
  }

  /* ---------------------------------------------------------------- 계산 */

  function readForm() {
    var sexEl = document.querySelector('input[name="sex"]:checked');
    return {
      sex:      sexEl ? sexEl.value : 'male',
      age:      num($('age').value, 0),
      height:   num($('height').value, 0),
      weight:   num($('weight').value, 0),
      activity: $('activity').value,
      goal:     $('goal').value,
      meals:    parseInt($('meals').value, 10) || 4,
      bmrInput: num($('bmrInput').value, 0),
      targetWeight: num($('targetWeight').value, NaN),
      weeks:    num($('weeks').value, NaN),
      proteinPerKg: num($('proteinPerKg').value, 1.6),
      fatPerKg:     num($('fatPerKg').value, 0.8),
      calAdjust:    $('calAdjust').value === '' ? null : num($('calAdjust').value, 0)
    };
  }

  function validate(f) {
    var errs = [];
    if (!(f.age >= 14 && f.age <= 90))       errs.push('나이는 14~90 사이로 입력해 주세요.');
    if (!(f.height >= 130 && f.height <= 220)) errs.push('키는 130~220cm 사이로 입력해 주세요.');
    if (!(f.weight >= 30 && f.weight <= 200))  errs.push('체중은 30~200kg 사이로 입력해 주세요.');
    return errs;
  }

  // 자동식단설계 시트 B5:B14 와 동일한 계산
  function compute(f) {
    var act  = ACTIVITY.filter(function (x) { return x.key === f.activity; })[0] || ACTIVITY[1];
    var goal = GOALS.filter(function (x) { return x.key === f.goal; })[0] || GOALS[1];

    // 인바디 값이 있으면 그것을, 없으면 Mifflin-St Jeor 추정식
    var estimated = 10 * f.weight + 6.25 * f.height - 5 * f.age + (f.sex === 'male' ? 5 : -161);
    var bmr = f.bmrInput > 0 ? f.bmrInput : r0(estimated);

    var tdee   = r0(bmr * act.factor);
    var adjust = f.calAdjust !== null ? f.calAdjust : goal.adjust;
    var target = r0(tdee + adjust);

    var protein = r0(f.weight * f.proteinPerKg);
    var fat     = r0(f.weight * f.fatPerKg);
    var carb    = Math.max(0, r0((target - protein * 4 - fat * 9) / 4));

    // 이 섭취량이 만드는 주당 예상 체중 변화 (지방 1kg ≒ 7,700kcal)
    var paceKg = r1((target - tdee) * 7 / 7700);

    var planChange = null, planPerWeek = null;
    if (isFinite(f.targetWeight) && f.targetWeight > 0) {
      planChange = r1(f.targetWeight - f.weight);
      if (isFinite(f.weeks) && f.weeks > 0) planPerWeek = r1(planChange / f.weeks);
    }

    return {
      form: f, act: act, goal: goal,
      bmr: bmr, bmrEstimated: f.bmrInput <= 0, estimated: r0(estimated),
      tdee: tdee, adjust: adjust, target: target,
      protein: protein, fat: fat, carb: carb,
      paceKg: paceKg, planChange: planChange, planPerWeek: planPerWeek,
      kcalCarb: carb * 4, kcalProt: protein * 4, kcalFat: fat * 9
    };
  }

  /* ---------------------------------------------------------------- 결과 */

  function renderResults(s) {
    var f = s.form;

    $('resultSummary').textContent =
      f.sex === 'male' ? '남성 ' : '여성 ';
    $('resultSummary').textContent +=
      f.age + '세 · ' + r1(f.height) + 'cm · ' + r1(f.weight) + 'kg · ' +
      s.act.label + ' 활동 · ' + s.goal.label;

    $('kBmr').innerHTML  = fmt(s.bmr) + '<em>kcal</em>';
    $('kBmrNote').textContent = s.bmrEstimated
      ? 'Mifflin-St Jeor 추정식'
      : '인바디 입력값 (추정식은 ' + fmt(s.estimated) + ')';

    $('kTdee').innerHTML = fmt(s.tdee) + '<em>kcal</em>';
    $('kTdeeNote').textContent = '기초대사량 × ' + s.act.factor.toFixed(2) + ' (' + s.act.label + ')';

    $('kAdjust').innerHTML = (s.adjust > 0 ? '+' : '') + fmt(s.adjust) + '<em>kcal</em>';
    $('kAdjustNote').textContent = s.goal.label + ' 기준';

    $('kTarget').innerHTML = fmt(s.target) + '<em>kcal</em>';
    $('kTargetNote').textContent =
      s.paceKg === 0 ? '체중 유지 페이스'
        : '이 섭취량이면 주당 약 ' + (s.paceKg > 0 ? '+' : '') + s.paceKg + 'kg 예상';

    var totalKcal = s.kcalCarb + s.kcalProt + s.kcalFat || 1;
    function macro(id, g, kcal) {
      $('m' + id).innerHTML = fmt(g) + '<em>g</em>';
      $('m' + id + 'Sub').textContent =
        fmt(kcal) + ' kcal · ' + Math.round(kcal / totalKcal * 100) + '%';
      $('m' + id + 'Bar').style.width = (kcal / totalKcal * 100) + '%';
    }
    macro('Carb', s.carb,    s.kcalCarb);
    macro('Prot', s.protein, s.kcalProt);
    macro('Fat',  s.fat,     s.kcalFat);

    renderWarnings(s);
    renderMealSplit(s);

    fixMiddots($('results'));

    $('results').hidden = false;
    $('plans').hidden = false;
  }

  function renderWarnings(s) {
    var box = $('warnings');
    box.innerHTML = '';
    var f = s.form;
    var out = [];

    if (s.target < s.bmr) {
      out.push(['warn',
        '목표 칼로리가 기초대사량(' + fmt(s.bmr) + 'kcal)보다 낮습니다. ' +
        '기초대사량 아래로 오래 먹으면 근손실과 컨디션 저하가 따라옵니다. ' +
        '칼로리를 올리거나 활동량을 늘리는 쪽을 먼저 고려하세요.']);
    }
    var floor = f.sex === 'male' ? 1500 : 1200;
    if (s.target < floor) {
      out.push(['warn',
        '하루 ' + fmt(floor) + 'kcal 미만은 일반적인 자가 관리 범위를 벗어납니다. ' +
        '이 구간은 전문가 관리가 필요합니다.']);
    }
    if (Math.abs(s.paceKg) > f.weight * 0.01) {
      out.push(['warn',
        '주당 체중 변화가 현재 체중의 1%(' + r1(f.weight * 0.01) + 'kg)를 넘습니다. ' +
        '조정 폭을 줄이는 편이 안전하고, 결과도 오래갑니다.']);
    }
    if (s.planPerWeek !== null && s.paceKg !== 0) {
      var gap = Math.abs(s.planPerWeek - s.paceKg);
      if (gap > 0.15) {
        out.push(['calm',
          '목표대로면 주당 ' + s.planPerWeek + 'kg이 필요한데, 지금 설정한 섭취량의 예상 속도는 주당 ' +
          (s.paceKg > 0 ? '+' : '') + s.paceKg + 'kg입니다. ' +
          '기간을 늘리거나 칼로리 조정값을 바꿔서 맞추세요.']);
      }
    }
    if (s.carb < s.protein) {
      out.push(['calm',
        '계산된 탄수화물(' + fmt(s.carb) + 'g)이 단백질(' + fmt(s.protein) + 'g)보다 적습니다. ' +
        '가이드 원칙상 탄수화물을 단백질보다 충분히 두는 편이 좋습니다. ' +
        '단백질·지방 기준(g/kg)을 조금 낮춰 보세요.']);
    }
    if (f.bmrInput > 0 && Math.abs(f.bmrInput - s.estimated) > s.estimated * 0.2) {
      out.push(['calm',
        '입력한 인바디 기초대사량이 추정식 값(' + fmt(s.estimated) + 'kcal)과 20% 이상 차이 납니다. ' +
        '입력값을 한 번 확인해 주세요.']);
    }

    out.forEach(function (o) {
      var n = el('div', 'notice' + (o[0] === 'calm' ? ' calm' : ''));
      n.appendChild(el('span', 'ico', o[0] === 'calm' ? 'ℹ' : '⚠'));
      n.appendChild(el('div', null, o[1]));
      box.appendChild(n);
    });
  }

  function renderMealSplit(s) {
    var n = s.form.meals;
    var tb = $('mealSplit');
    tb.innerHTML = '';
    for (var i = 1; i <= n; i++) {
      var tr = el('tr');
      tr.innerHTML =
        '<td>' + i + '끼</td>' +
        '<td>' + fmt(s.target / n) + '</td>' +
        '<td>' + fmt(s.carb / n) + '</td>' +
        '<td>' + fmt(s.protein / n) + '</td>' +
        '<td>' + fmt(s.fat / n) + '</td>';
      tb.appendChild(tr);
    }
    var tot = el('tr', 'total');
    tot.innerHTML =
      '<td>하루 합계</td><td>' + fmt(s.target) + '</td><td>' + fmt(s.carb) +
      '</td><td>' + fmt(s.protein) + '</td><td>' + fmt(s.fat) + '</td>';
    tb.appendChild(tot);
  }

  /* ---------------------------------------------------------------- 식단 3안 */

  // 자동식단3안 시트의 순차 해법:
  //  1) 고정식품을 뺀 나머지 탄수화물을 탄수원으로 채운다
  //  2) 거기서 나온 단백질까지 빼고 남은 단백질을 단백질원으로 채운다
  //  3) 마지막으로 남은 지방을 지방원으로 채운다
  function solvePlan(plan, s) {
    var sw = swaps[plan.id] || {};
    var carbF = byName[sw.carb    || plan.carb];
    var protF = byName[sw.protein || plan.protein];
    var fatF  = byName[sw.fat     || plan.fat];
    if (!carbF || !protF || !fatF) return null;

    var fixed = plan.fixed.map(function (x) {
      return { food: byName[x.name], g: x.g, note: x.note, spread: x.spread };
    }).filter(function (x) { return x.food; });

    var sum = function (key) {
      return fixed.reduce(function (a, x) { return a + x.g / 100 * x.food[key]; }, 0);
    };
    var fixCa = sum('ca'), fixP = sum('p'), fixF = sum('f');

    var carbG = carbF.ca > 0 ? (s.carb - fixCa) / carbF.ca * 100 : 0;
    carbG = clamp(to5(carbG), 0, 2000);

    var protG = protF.p > 0
      ? (s.protein - carbG / 100 * carbF.p - fixP) / protF.p * 100 : 0;
    protG = clamp(to5(protG), 0, 2000);

    var fatG = fatF.f > 0
      ? (s.fat - carbG / 100 * carbF.f - protG / 100 * protF.f - fixF) / fatF.f * 100 : 0;
    fatG = clamp(r0(fatG), 0, 300);

    var items = [
      { food: carbF, g: carbG, role: '탄수화물원', spread: 'all', note: plan.split[plan.carb]    || '끼니마다 나눠서' },
      { food: protF, g: protG, role: '단백질원',   spread: 'all', note: plan.split[plan.protein] || '끼니마다 나눠서' },
      { food: fatF,  g: fatG,  role: '지방원',     spread: 'all', note: plan.split[plan.fat]     || '조리 · 샐러드에 나눠 사용' }
    ].concat(fixed.map(function (x) {
      return { food: x.food, g: x.g, role: '고정', spread: x.spread, note: x.note };
    }));

    var tot = items.reduce(function (a, it) {
      var k = it.g / 100;
      a.kcal += k * it.food.k; a.ca += k * it.food.ca;
      a.p    += k * it.food.p; a.f  += k * it.food.f;
      return a;
    }, { kcal: 0, ca: 0, p: 0, f: 0 });

    return { plan: plan, items: items, total: tot, carbF: carbF, protF: protF, fatF: fatF };
  }

  function renderPlans(s) {
    var tabs = $('planTabs'), panels = $('planPanels');
    tabs.innerHTML = ''; panels.innerHTML = '';

    PLANS.forEach(function (plan, i) {
      var btn = el('button', null, 'PLAN ' + plan.id + ' · ' + plan.name);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      btn.setAttribute('aria-controls', 'panel' + plan.id);
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs.children, function (b, j) {
          b.setAttribute('aria-selected', j === i ? 'true' : 'false');
        });
        Array.prototype.forEach.call(panels.children, function (p, j) {
          p.hidden = j !== i;
        });
      });
      tabs.appendChild(btn);

      var panel = el('div', 'card plan-panel');
      panel.id = 'panel' + plan.id;
      panel.hidden = i !== 0;
      panels.appendChild(panel);
      drawPanel(panel, plan, s);
    });
  }

  function drawPanel(panel, plan, s) {
    panel.innerHTML = '';
    var res = solvePlan(plan, s);
    if (!res) { panel.appendChild(el('p', null, '식품 데이터를 찾지 못했습니다.')); return; }

    var head = el('div', 'plan-head');
    head.appendChild(el('h3', null, 'PLAN ' + plan.id + '. ' + esc(plan.name)));
    head.appendChild(el('span', 'tag', esc(plan.tag)));
    panel.appendChild(head);
    panel.appendChild(el('p', 'plan-desc', esc(plan.desc)));

    // ---- 식품 교체
    var swapRow = el('div', 'swap-row');
    [['carb', '탄수화물원', ['탄수화물', '과일']],
     ['protein', '단백질원', ['단백질']],
     ['fat', '지방원', ['지방']]].forEach(function (spec) {
      var wrap = el('div', 'field');
      wrap.appendChild(el('label', null, spec[1] + ' 바꾸기'));
      var sel = document.createElement('select');
      FOODS.filter(function (f) { return spec[2].indexOf(f.c) >= 0; })
           .forEach(function (f) { sel.appendChild(new Option(f.n, f.n)); });
      var cur = (swaps[plan.id] || {})[spec[0]] || plan[spec[0]];
      sel.value = cur;
      sel.addEventListener('change', function () {
        swaps[plan.id] = swaps[plan.id] || {};
        swaps[plan.id][spec[0]] = sel.value;
        drawPanel(panel, plan, s);
      });
      wrap.appendChild(sel);
      swapRow.appendChild(wrap);
    });
    panel.appendChild(swapRow);

    // ---- 하루 총량 표
    var scroll = el('div', 'table-scroll');
    var t = el('table');
    t.innerHTML =
      '<thead><tr><th>식품</th><th>역할</th><th>하루 총량</th><th>kcal</th>' +
      '<th>탄수 (g)</th><th>단백질 (g)</th><th>지방 (g)</th><th>분배</th></tr></thead>';
    var tb = el('tbody');

    res.items.forEach(function (it) {
      var k = it.g / 100, f = it.food;
      var tr = el('tr');
      tr.innerHTML =
        '<td class="food-name">' + esc(f.n) + '</td>' +
        '<td class="role">' + it.role + '</td>' +
        '<td>' + fmt(it.g) + ' g</td>' +
        '<td>' + fmt(k * f.k) + '</td>' +
        '<td>' + fmt(k * f.ca) + '</td>' +
        '<td>' + fmt(k * f.p) + '</td>' +
        '<td>' + fmt(k * f.f) + '</td>' +
        '<td class="role">' + esc(it.note) + '</td>';
      tb.appendChild(tr);
    });

    var tot = el('tr', 'total');
    tot.innerHTML =
      '<td colspan="3">합계</td><td>' + fmt(res.total.kcal) + '</td><td>' + fmt(res.total.ca) +
      '</td><td>' + fmt(res.total.p) + '</td><td>' + fmt(res.total.f) + '</td><td></td>';
    tb.appendChild(tot);

    function diffCell(actual, goal, tol) {
      var d = actual - goal;
      var cls = Math.abs(d) <= tol ? 'ok' : 'off';
      return '<td class="' + cls + '">' + (d > 0 ? '+' : '') + fmt(d) + '</td>';
    }
    var dif = el('tr', 'diff');
    dif.innerHTML =
      '<td colspan="3">목표 대비 차이</td>' +
      diffCell(res.total.kcal, s.target, s.target * 0.05) +
      diffCell(res.total.ca, s.carb, 10) +
      diffCell(res.total.p, s.protein, 8) +
      diffCell(res.total.f, s.fat, 5) + '<td></td>';
    tb.appendChild(dif);

    t.appendChild(tb);
    scroll.appendChild(t);
    panel.appendChild(scroll);
    panel.appendChild(el('p', 'scroll-hint', '표를 좌우로 밀면 나머지 항목이 보입니다.'));

    // 축 식품이 사실상 빠졌을 때 안내.
    // 무게로 재면 기름(29g = 256kcal)과 밥(29g = 42kcal)을 똑같이 취급하게 되므로
    // 하루 목표 칼로리에서 차지하는 몫으로 판단한다.
    var tiny = res.items.filter(function (it) {
      if (it.role === '고정') return false;
      if (it.g === 0) return true;
      return it.g / 100 * it.food.k < s.target * 0.05;
    });
    if (tiny.length) {
      var n = el('div', 'notice calm');
      n.appendChild(el('span', 'ico', 'ℹ'));
      n.appendChild(el('div', null,
        tiny.map(function (z) { return esc(z.food.n) + ' ' + fmt(z.g) + 'g'; }).join(' · ') +
        ' — 고정 식품만으로 그 영양소를 거의 다 채웠다는 뜻입니다. ' +
        '고정 식품 양을 줄이거나, 위에서 다른 식품으로 바꿔 보세요.'));
      panel.appendChild(n);
    }

    // 지방 많은 단백질원을 골랐을 때처럼 총량이 목표를 크게 넘는 경우
    var over = res.total.kcal - s.target;
    if (Math.abs(over) > s.target * 0.05) {
      var w = el('div', 'notice');
      w.appendChild(el('span', 'ico', '⚠'));
      w.appendChild(el('div', null,
        '이 조합의 하루 합계가 목표보다 ' + fmt(Math.abs(over)) + ' kcal ' +
        (over > 0 ? '많습니다' : '적습니다') + '. ' +
        (over > 0
          ? '단백질원이나 고정 식품의 지방이 이미 목표를 넘겼기 때문입니다. 지방이 적은 단백질원(닭가슴살 · 흰살생선 · 대구 등)으로 바꾸면 맞춰집니다.'
          : '고정 식품과 축 식품만으로는 목표를 다 못 채웁니다. 탄수화물원 양을 늘리거나 간식을 추가하세요.')));
      panel.appendChild(w);
    }

    panel.appendChild(renderMeals(res, s));
    fixMiddots(panel);
  }

  // 하루 총량을 끼니 수에 맞춰 실제로 나눠 준다
  function renderMeals(res, s) {
    var n = s.form.meals;
    var meals = [];
    for (var i = 0; i < n; i++) meals.push([]);

    res.items.forEach(function (it) {
      if (it.g <= 0) return;
      var count = it.spread === 'all' ? n : Math.min(n, it.spread || n);
      var per = it.g / count;
      for (var i = 0; i < count; i++) {
        meals[i].push({ name: it.food.n, g: per, food: it.food });
      }
    });

    var grid = el('div', 'meal-grid');
    meals.forEach(function (list, i) {
      var kcal = list.reduce(function (a, x) { return a + x.g / 100 * x.food.k; }, 0);
      var card = el('div', 'meal');
      var h = el('h4', null, (i + 1) + '끼 <span>' + fmt(kcal) + ' kcal</span>');
      card.appendChild(h);
      var ul = el('ul');
      list.forEach(function (x) {
        ul.appendChild(el('li', null,
          esc(x.name) + '<b>' + fmt(x.g) + 'g</b>'));
      });
      card.appendChild(ul);
      grid.appendChild(card);
    });
    return grid;
  }

  /* ---------------------------------------------------------------- 음식 찾기 */

  var CATS = ['전체', '탄수화물', '단백질', '지방', '채소', '과일', '간식'];
  var activeCat = '전체';
  var shown = 30;

  function renderChips() {
    var box = $('catChips');
    box.innerHTML = '';
    CATS.forEach(function (c) {
      var b = el('button', null, c);
      b.type = 'button';
      b.setAttribute('aria-pressed', c === activeCat ? 'true' : 'false');
      b.addEventListener('click', function () {
        activeCat = c; shown = 30; renderChips(); renderFoods();
      });
      box.appendChild(b);
    });
  }

  function filteredFoods() {
    var q = $('foodQuery').value.trim().toLowerCase();
    return FOODS.filter(function (f) {
      if (activeCat !== '전체' && f.c !== activeCat) return false;
      if (!q) return true;
      return f.n.toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderFoods() {
    var list = filteredFoods();
    var p = clamp(num($('portion').value, 100), 1, 2000);
    var k = p / 100;
    var rows = $('foodRows');
    rows.innerHTML = '';

    list.slice(0, shown).forEach(function (f) {
      var tr = el('tr');
      tr.innerHTML =
        '<td class="food-name">' + esc(f.n) + '</td>' +
        '<td class="role">' + esc(f.c) + '</td>' +
        '<td>' + fmt(k * f.k) + '</td>' +
        '<td>' + r1(k * f.ca) + '</td>' +
        '<td>' + r1(k * f.p) + '</td>' +
        '<td>' + r1(k * f.f) + '</td>' +
        '<td class="memo">' + esc(f.m || '') + '</td>';
      rows.appendChild(tr);
    });

    $('foodCount').textContent =
      list.length + '개 중 ' + Math.min(shown, list.length) + '개 표시 · ' +
      p + 'g(ml) 기준 값';
    $('moreBtn').hidden = list.length <= shown;
    fixMiddots(rows);

    if (!list.length) {
      rows.appendChild(el('tr', null,
        '<td colspan="7" style="text-align:center; color:var(--ink-3); padding:26px;">' +
        '검색 결과가 없습니다.</td>'));
    }
  }

  /* ---------------------------------------------------------------- 가이드 */

  function renderGuide() {
    (GUIDE.principles || []).forEach(function (t) {
      $('gPrinciples').appendChild(el('li', null, t));
    });
    (GUIDE.checklist || []).forEach(function (t) {
      $('gChecklist').appendChild(el('li', null, t));
    });
    (GUIDE.groups || []).forEach(function (g) {
      var d = el('div', 'foodgroup');
      d.appendChild(el('div', 'gname', esc(g.name)));
      d.appendChild(el('div', 'glist', esc(g.list)));
      $('gGroups').appendChild(d);
    });
    $('gToEat').textContent = GUIDE.toEat || '';
    $('dbCount').textContent = '음식 ' + FOODS.length + '종 · 100g(ml) 기준';
    fixMiddots($('guide'));
  }

  /* ---------------------------------------------------------------- 저장 */

  var FIELDS = ['age', 'height', 'weight', 'activity', 'goal', 'meals',
                'bmrInput', 'targetWeight', 'weeks', 'proteinPerKg', 'fatPerKg', 'calAdjust'];

  function save(f) {
    try { localStorage.setItem(STORE, JSON.stringify(f)); } catch (e) { /* 사파리 시크릿 등 */ }
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE); } catch (e) { return false; }
    if (!raw) return false;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return false; }
    if (!d || typeof d !== 'object') return false;

    FIELDS.forEach(function (id) {
      var v = d[id === 'bmrInput' ? 'bmrInput' : id];
      if (v === undefined || v === null || v === '' || (typeof v === 'number' && !isFinite(v))) return;
      if ($(id)) $(id).value = v;
    });
    if (d.sex) {
      var r = document.querySelector('input[name="sex"][value="' + d.sex + '"]');
      if (r) r.checked = true;
    }
    syncHints();
    return true;
  }

  /* ---------------------------------------------------------------- 회원 */

  // { id, name } = 등록한 회원 / { skipped: true } = 이름 없이 쓰는 사람 / null = 아직 정하지 않음
  var member = null;

  var isRegistered = function () { return !!(member && member.id); };
  var hasChosen    = function () { return !!(member && (member.id || member.skipped)); };

  function loadMember() {
    try {
      var raw = localStorage.getItem(MEMBER);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d && d.id && d.name) return d;
      if (d && d.skipped) return { skipped: true };
      return null;
    } catch (e) { return null; }
  }

  function saveMember(m) {
    try { localStorage.setItem(MEMBER, JSON.stringify(m)); } catch (e) { /* noop */ }
  }

  function showGate() {
    $('gate').hidden = false;
    $('app').hidden = true;
    $('foodSection').hidden = true;
    $('gate').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showApp() {
    $('gate').hidden = true;
    $('app').hidden = false;
    $('foodSection').hidden = false;
    $('welcome').hidden = false;

    var reg = isRegistered();
    $('welcome').className = 'welcome' + (reg ? '' : ' anon');
    $('welcomeWho').innerHTML = reg
      ? '<b>' + esc(member.name) + '</b> 님, 반갑습니다'
      : '이름 없이 이용 중입니다';
    $('registerBtn').hidden = reg;
    $('forgetBtn').hidden = !reg;
    if (!reg) syncNote('');
  }

  function skip() {
    member = { skipped: true };
    saveMember(member);
    gateError('');
    showApp();
    $('input').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function gateError(msg) {
    var box = $('gateError');
    box.innerHTML = '';
    if (!msg) return;
    var n = el('div', 'notice');
    n.appendChild(el('span', 'ico', '⚠'));
    n.appendChild(el('div', null, esc(msg)));
    box.appendChild(n);
  }

  function syncNote(text, isError) {
    var n = $('syncNote');
    n.textContent = text || '';
    n.className = 'sync' + (isError ? ' err' : '');
  }

  async function api(path, body, method) {
    var res = await fetch(path, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* 본문이 JSON 이 아닐 수 있다 */ }
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || '서버와 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    return data;
  }

  async function submitGate(e) {
    e.preventDefault();
    var name  = $('gName').value.trim();
    var phone = $('gPhone').value.trim();

    if (!name)  { gateError('이름을 입력해 주세요.'); $('gName').focus(); return; }
    if (phone.replace(/\D/g, '').length < 9) {
      gateError('연락처를 정확히 입력해 주세요.'); $('gPhone').focus(); return;
    }
    if (!$('gConsent').checked) {
      gateError('개인정보 수집 · 이용에 동의해야 시작할 수 있습니다.'); return;
    }

    gateError('');
    var btn = $('gateBtn');
    btn.disabled = true;
    btn.textContent = '등록하는 중…';

    try {
      var d = await api('/api/register', { name: name, phone: phone, consent: true });
      member = { id: d.id, name: d.name };
      saveMember(member);
      showApp();
      syncNote('');
      $('input').scrollIntoView({ behavior: 'smooth', block: 'start' });
      // 건너뛰고 쓰다가 뒤늦게 등록한 경우, 이미 낸 결과도 같이 보낸다
      if (state) pushResult(state);
    } catch (err) {
      gateError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '동의하고 시작하기';
    }
  }

  // 계산 결과를 서버에 남긴다. 실패해도 계산기 사용은 막지 않는다.
  async function pushResult(s) {
    if (!isRegistered()) return;   // 이름 없이 쓰는 사람의 값은 서버로 보내지 않는다
    syncNote('저장하는 중…');
    try {
      await api('/api/result', {
        id: member.id,
        form: {
          sex: s.form.sex, age: s.form.age, height: s.form.height, weight: s.form.weight,
          activity: s.form.activity, goal: s.form.goal, meals: s.form.meals,
          targetWeight: isFinite(s.form.targetWeight) ? s.form.targetWeight : null,
          weeks: isFinite(s.form.weeks) ? s.form.weeks : null
        },
        result: {
          bmr: s.bmr, tdee: s.tdee, target: s.target,
          carb: s.carb, protein: s.protein, fat: s.fat
        }
      });
      syncNote('트레이너에게 전달됨');
    } catch (err) {
      syncNote('저장 실패 — 계산은 그대로 쓰실 수 있습니다', true);
    }
  }

  async function forget() {
    if (!isRegistered()) return;
    if (!window.confirm('저장된 내 기록을 지웁니다. 계속할까요?')) return;
    try { await api('/api/forget', { id: member.id }); } catch (e) { /* 이미 없을 수 있다 */ }
    try {
      localStorage.removeItem(MEMBER);
      localStorage.removeItem(STORE);
    } catch (e) { /* noop */ }
    window.location.reload();
  }

  /* ---------------------------------------------------------------- 실행 */

  function run(scroll) {
    var f = readForm();
    var errs = validate(f);
    if (errs.length) {
      $('results').hidden = false;
      $('plans').hidden = true;
      var box = $('warnings');
      box.innerHTML = '';
      errs.forEach(function (e) {
        var n = el('div', 'notice');
        n.appendChild(el('span', 'ico', '⚠'));
        n.appendChild(el('div', null, e));
        box.appendChild(n);
      });
      return;
    }
    state = compute(f);
    save(f);
    renderResults(state);
    renderPlans(state);
    if (scroll) {
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      pushResult(state);
    }
  }

  function init() {
    fillSelects();
    renderGuide();
    renderChips();
    renderFoods();

    member = loadMember();
    if (hasChosen()) { showApp(); } else { showGate(); }

    $('gateForm').addEventListener('submit', submitGate);
    $('skipBtn').addEventListener('click', skip);
    $('forgetBtn').addEventListener('click', forget);
    $('registerBtn').addEventListener('click', function () {
      gateError('');
      showGate();
    });

    var restored = load();

    $('userForm').addEventListener('submit', function (e) {
      e.preventDefault();
      run(true);
    });

    $('resetBtn').addEventListener('click', function () {
      try { localStorage.removeItem(STORE); } catch (e) { /* noop */ }
      $('userForm').reset();
      $('activity').value = 'mid';
      $('goal').value = 'cut';
      applyGoalDefaults();
      syncHints();
      swaps = {};
      run(false);
    });

    $('printBtn').addEventListener('click', function () {
      if ($('results').hidden) run(false);
      window.print();
    });

    $('foodQuery').addEventListener('input', function () { shown = 30; renderFoods(); });
    $('portion').addEventListener('input', renderFoods);
    $('moreBtn').addEventListener('click', function () { shown += 50; renderFoods(); });

    fixMiddots(document.body);

    // 저장된 값이 있으면 바로 결과까지 보여 준다
    if (restored) run(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
