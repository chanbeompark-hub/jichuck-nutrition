/* ==========================================================================
   NUTRITION GUIDE — 트레이너용 회원 기록 조회
   ========================================================================== */
(function () {
  'use strict';

  var KEY_STORE = 'ng.adminkey';
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  var SEX  = { male: '남성', female: '여성' };
  var ACT  = { low: '낮음', mid: '보통', high: '높음', vhigh: '매우높음' };
  var GOAL = { cut: '다이어트', keep: '유지', gain: '증량' };

  var adminKey = '';

  function getKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
  }
  function setKey(v) {
    try {
      if (v) sessionStorage.setItem(KEY_STORE, v);
      else sessionStorage.removeItem(KEY_STORE);
    } catch (e) { /* noop */ }
  }

  function notice(boxId, msg) {
    var box = $(boxId);
    box.innerHTML = '';
    if (!msg) return;
    var n = el('div', 'notice');
    n.appendChild(el('span', 'ico', '⚠'));
    n.appendChild(el('div', null, esc(msg)));
    box.appendChild(n);
  }

  async function apiGet(path) {
    var res = await fetch(path, { headers: { 'X-Admin-Key': adminKey } });
    if (res.status === 401) throw new Error('관리자 키가 올바르지 않습니다.');
    var data = null;
    try { data = await res.json(); } catch (e) { /* noop */ }
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || '불러오지 못했습니다.');
    }
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    if (isNaN(d)) return '–';
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function numOr(v, suffix) {
    return (v === null || v === undefined || v === '') ? '–' : v + (suffix || '');
  }

  async function loadRows() {
    var q = $('q').value.trim();
    notice('listError', '');
    try {
      var d = await apiGet('/api/admin/list?limit=500' + (q ? '&q=' + encodeURIComponent(q) : ''));
      render(d);
    } catch (err) {
      notice('listError', err.message);
      if (err.message.indexOf('관리자 키') === 0) lock();
    }
  }

  function render(d) {
    var tb = $('rows');
    tb.innerHTML = '';

    $('count').textContent =
      '전체 ' + d.total + '명' + (d.rows.length !== d.total ? ' · 조건에 맞는 ' + d.rows.length + '명 표시' : '');

    if (!d.rows.length) {
      tb.appendChild(el('tr', null,
        '<td colspan="15" style="text-align:center; color:var(--ink-3); padding:26px;">' +
        '아직 기록이 없습니다.</td>'));
      return;
    }

    d.rows.forEach(function (r) {
      var tr = el('tr');
      tr.innerHTML =
        '<td class="food-name">' + esc(r.name) + '</td>' +
        '<td>' + esc(r.phone) + '</td>' +
        '<td class="role">' + fmtDate(r.updated_at || r.created_at) + '</td>' +
        '<td>' + r.calc_count + '</td>' +
        '<td class="role">' + esc(SEX[r.sex] || '–') + '</td>' +
        '<td>' + numOr(r.age) + '</td>' +
        '<td>' + numOr(r.height) + '</td>' +
        '<td>' + numOr(r.weight) + '</td>' +
        '<td class="role">' + esc(GOAL[r.goal] || '–') + '</td>' +
        '<td class="role">' + esc(ACT[r.activity] || '–') + '</td>' +
        '<td>' + numOr(r.target_kcal) + '</td>' +
        '<td>' + numOr(r.carb_g) + '</td>' +
        '<td>' + numOr(r.protein_g) + '</td>' +
        '<td>' + numOr(r.fat_g) + '</td>' +
        '<td></td>';

      var del = el('button', 'link-btn', '삭제');
      del.type = 'button';
      del.style.marginLeft = '0';
      del.addEventListener('click', function () { removeRow(r); });
      tr.lastElementChild.appendChild(del);

      tb.appendChild(tr);
    });
  }

  async function removeRow(r) {
    if (!window.confirm(r.name + ' 님의 기록을 완전히 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    try {
      var res = await fetch('/api/admin/row', {
        method: 'DELETE',
        headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id })
      });
      if (!res.ok) throw new Error('삭제하지 못했습니다.');
      loadRows();
    } catch (err) {
      notice('listError', err.message);
    }
  }

  async function downloadCsv() {
    notice('listError', '');
    try {
      var res = await fetch('/api/admin/csv', { headers: { 'X-Admin-Key': adminKey } });
      if (!res.ok) throw new Error('내려받지 못했습니다.');
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'nutrition-guide-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (err) {
      notice('listError', err.message);
    }
  }

  function unlock() {
    $('loginSec').hidden = true;
    $('listSec').hidden = false;
    loadRows();
  }

  function lock() {
    adminKey = '';
    setKey('');
    $('listSec').hidden = true;
    $('loginSec').hidden = false;
    $('adminKey').value = '';
  }

  function init() {
    $('loginForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var v = $('adminKey').value.trim();
      if (!v) { notice('loginError', '관리자 키를 입력해 주세요.'); return; }

      notice('loginError', '');
      $('loginBtn').disabled = true;
      adminKey = v;
      try {
        await apiGet('/api/admin/list?limit=1');
        setKey(v);
        unlock();
      } catch (err) {
        adminKey = '';
        notice('loginError', err.message);
      } finally {
        $('loginBtn').disabled = false;
      }
    });

    $('reloadBtn').addEventListener('click', loadRows);
    $('csvBtn').addEventListener('click', downloadCsv);
    $('logoutBtn').addEventListener('click', lock);

    var t = null;
    $('q').addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(loadRows, 250);
    });

    var saved = getKey();
    if (saved) { adminKey = saved; unlock(); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
