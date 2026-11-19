/*
 * หลังบ้าน Smart Pillbox (สำหรับผู้ดูแลระบบ)
 * ไฟล์ส่วนกลาง: ตั้งค่า ตัวช่วย และการต่อ ThingsBoard (หน้าจอทั้งหมดอยู่ใน admin.js)
 * วาง admin.html, admin.css, admin-core.js, admin.js ไว้โฟลเดอร์เดียวกับหน้าบ้าน แล้วเปิด .../admin.html
 *
 * เข้าใช้ 2 ชั้น
 * 1) ชื่อผู้ใช้และรหัสผ่านหลังบ้านด้านล่าง เป็นประตูหน้าเว็บ (เก็บเป็นค่า hash ไม่เก็บรหัสตรง ๆ)
 * 2) บัญชี Tenant ของ ThingsBoard กรอกครั้งแรกในแต่ละเครื่อง ข้อมูลจริงทั้งหมดอยู่ที่ ThingsBoard
 *    เบราว์เซอร์เก็บแค่ token ไม่เก็บรหัสผ่าน ห้ามใส่รหัส ThingsBoard หรือ access token ลงไฟล์นี้
 */
'use strict';

window.ADMIN_CONFIG = {
  // ที่อยู่ ThingsBoard ที่ใช้ในแล็บ
  TB_HOST: 'https://demo.thingsboard.io',

  // ชื่อผู้ใช้หลังบ้าน
  ADMIN_USER: 'smartbox',

  // รหัสผ่านหลังบ้านเก็บเป็นค่า SHA-256 ไม่เก็บรหัสตรง ๆ
  // ถ้าจะเปลี่ยนรหัส ใช้เครื่องมือในหน้า "บัญชีและการเชื่อมต่อ" สร้างค่าใหม่มาแทน
  ADMIN_HASH: '16d0155842e880116a6da94962d694c2c67cb6972b60dd0079c9b4ff65c47ed0',

  // ออกจากระบบอัตโนมัติเมื่อไม่ได้ใช้งานกี่นาที
  IDLE_MIN: 30,

  // หน้าภาพรวมและหน้าการแจ้งเตือนดึงข้อมูลใหม่ทุกกี่มิลลิวินาที
  REFRESH_MS: 30000
};


var CFG = window.ADMIN_CONFIG || {};
var MEALS = ['morning', 'noon', 'evening', 'bedtime'];
var MEAL_TH = { morning: 'มื้อเช้า', noon: 'มื้อกลางวัน', evening: 'มื้อเย็น', bedtime: 'ก่อนนอน' };
var NULL_ID = '13814000-1dd2-11b2-8080-808080808080'; // ThingsBoard ใช้ id นี้แทน "ยังไม่ได้ผูกกับ customer"
var DAY = 24 * 60 * 60 * 1000;
var KEYS = ['meal', 'dose', 'reminders', 'sos'];
var $app = document.getElementById('app');
var $toast = document.getElementById('toast');
var LOADING = '<p class="loading">กำลังโหลด…</p>';

/* ---------- ตัวช่วยทั่วไป ---------- */

function keep(area, k, v) {
  try {
    var s = area === 'local' ? window.localStorage : window.sessionStorage;
    if (v === undefined) return s.getItem(k);
    if (v === null) s.removeItem(k); else s.setItem(k, String(v));
  } catch (e) { /* เบราว์เซอร์ปิดที่เก็บข้อมูล */ }
  return null;
}
function local(k, v) { return keep('local', k, v); }
function session(k, v) { return keep('session', k, v); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function pad(n) { return String(n).padStart(2, '0'); }
function dayStart(ts) { var d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function isoDay(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function clock(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function hhmm(ts) { return new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }); }
function dShort(ts) { return new Date(ts).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }); }
function dt(ts) { return ts ? dShort(ts) + ' ' + hhmm(ts) : '–'; }
function isTrue(v) { return v === true || v === 'true'; }
function byId(id) { return document.getElementById(id); }
function idleMin() { return Number(CFG.IDLE_MIN) || 30; }
function assigned(d) { return !!(d.customerId && d.customerId.id && d.customerId.id !== NULL_ID); }
function elderOf(d) { return assigned(d) ? (d.customerTitle || d.label || '') : ''; }

var toastTimer = null;
function toast(msg, kind) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (kind ? ' ' + kind : '');
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { $toast.hidden = true; }, 4000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('คัดลอกแล้ว', 'ok');
  } catch (e) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
    if (ok) toast('คัดลอกแล้ว', 'ok'); else toast('คัดลอกไม่สำเร็จ ให้เลือกข้อความแล้วคัดลอกเอง', 'err');
  }
}

// SHA-256 (ทำงานได้ทั้งบน https และ http ในวงแลน)
function sha256(text) {
  var bin = '';
  new TextEncoder().encode(String(text)).forEach(function (b) { bin += String.fromCharCode(b); });
  var rot = function (v, n) { return (v >>> n) | (v << (32 - n)); };
  var max = Math.pow(2, 32);
  var hash = sha256.h = sha256.h || [];
  var k = sha256.k = sha256.k || [];
  var composite = {};
  var i, j;
  for (var c = 2, primes = k.length; primes < 64; c++) {
    if (!composite[c]) {
      for (i = 0; i < 313; i += c) composite[i] = c;
      hash[primes] = (Math.pow(c, 0.5) * max) | 0;
      k[primes++] = (Math.pow(c, 1 / 3) * max) | 0;
    }
  }
  var bitLen = bin.length * 8;
  var words = [];
  bin += '\x80';
  while (bin.length % 64 - 56) bin += '\x00';
  for (i = 0; i < bin.length; i++) words[i >> 2] |= bin.charCodeAt(i) << ((3 - i) % 4) * 8;
  words[words.length] = (bitLen / max) | 0;
  words[words.length] = bitLen;
  for (j = 0; j < words.length;) {
    var w = words.slice(j, j += 16);
    var old = hash;
    hash = hash.slice(0, 8);
    for (i = 0; i < 64; i++) {
      var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
      var t1 = hash[7] + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
        (w[i] = i < 16 ? w[i] : (w[i - 16] + (rot(w15, 7) ^ rot(w15, 18) ^ (w15 >>> 3)) + w[i - 7] +
          (rot(w2, 17) ^ rot(w2, 19) ^ (w2 >>> 10))) | 0);
      var t2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(t1 + t2) | 0].concat(hash);
      hash[4] = (hash[4] + t1) | 0;
    }
    for (i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
  }
  var out = '';
  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      var byte = (hash[i] >> (j * 8)) & 255;
      out += (byte < 16 ? '0' : '') + byte.toString(16);
    }
  }
  return out;
}
window.adminHash = function (user, pass) { return sha256(String(user).trim().toLowerCase() + ':' + pass); };

var ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  box: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18M12 4v16"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 3-5.5 6.5-5.5s6.5 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.5 2.3 3.5 5.2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  out: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/>'
};
function icon(name, size) {
  var s = size || 20;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
}
function logo(size) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 36 36" aria-hidden="true">' +
    '<rect x="2" y="2" width="32" height="32" rx="9" fill="#1E2C55" stroke="#F6EFE2" stroke-width="1"/>' +
    '<path d="M18 7v22M7 18h22" stroke="#F6EFE2" stroke-width="2.5" fill="none"/>' +
    '<path d="M21 26l3 3 6-7" stroke="#F6EFE2" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function badge(tone, text) { return '<span class="badge ' + tone + '">' + text + '</span>'; }
function emptyCard(text, extra) { return '<section class="card empty"><p>' + text + '</p>' + (extra || '') + '</section>'; }
function field(name, label, type, ph, req, value) {
  return '<label class="field"><span>' + label + '</span><input class="input" name="' + name + '" type="' + type + '"' +
    (ph ? ' placeholder="' + esc(ph) + '"' : '') + (value ? ' value="' + esc(value) + '"' : '') + (req ? ' required' : '') +
    (type === 'email' ? ' inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false"' : '') +
    (type === 'tel' ? ' inputmode="tel"' : '') + (type === 'password' ? ' autocomplete="new-password"' : '') + ' maxlength="80"></label>';
}
function showErr(form, msg) {
  var box = form.querySelector('[data-err]');
  if (!box) { toast(msg, 'err'); return; }
  box.textContent = msg;
  box.hidden = !msg;
}

/* ---------- ชั้นที่ 1: รหัสหลังบ้าน ---------- */

var lastTouch = 0;
var Gate = {
  msg: '',
  ok: function () { return session('adm_gate') === '1'; },
  check: function (user, pass) {
    return String(user || '').trim().toLowerCase() === String(CFG.ADMIN_USER || '').toLowerCase() &&
      window.adminHash(user, pass) === String(CFG.ADMIN_HASH || '').toLowerCase();
  },
  open: function () { session('adm_gate', '1'); Gate.msg = ''; Gate.touch(true); },
  close: function (msg) { session('adm_gate', null); session('adm_last', null); Gate.msg = msg || ''; },
  touch: function (force) {
    var now = Date.now();
    if (force || now - lastTouch > 5000) { lastTouch = now; session('adm_last', now); }
  },
  idle: function () {
    var last = Number(session('adm_last')) || 0;
    return Gate.ok() && last > 0 && Date.now() - last > idleMin() * 60000;
  }
};

/* ---------- ชั้นที่ 2: ThingsBoard (บัญชี Tenant) ---------- */

function fail(status, message) { var e = new Error(message); e.status = status; return e; }
function expired() { var e = fail(401, 'การเชื่อมต่อ ThingsBoard หมดอายุ กรุณาเชื่อมต่อใหม่'); e.expired = true; return e; }
function errorText(status) {
  if (status === 400) return 'ข้อมูลที่ส่งไม่ถูกต้อง (400)';
  if (status === 403) return 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ (403)';
  if (status === 404) return 'ไม่พบข้อมูลที่ขอ (404)';
  if (status >= 500) return 'ThingsBoard ไม่ตอบสนอง ลองใหม่อีกครั้ง (' + status + ')';
  return 'ทำรายการไม่สำเร็จ (' + status + ')';
}
function jwtExp(token) {
  try {
    var p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    return (JSON.parse(atob(p)).exp || 0) * 1000;
  } catch (e) { return 0; }
}
// แปลข้อความจาก ThingsBoard ที่รู้จัก เป็นภาษาไทย
function tbMsg(e, rules) {
  var m = (e && e.tb) || '';
  for (var i = 0; i < rules.length; i++) if (rules[i][0].test(m)) return rules[i][1];
  return e.message;
}

var TB = {
  host: function () { return String(CFG.TB_HOST || '').replace(/\/+$/, ''); },
  // ใช้ชื่อ key ต่างจากหน้าบ้าน (tb_token) เพราะหน้าบ้านกับหลังบ้านอยู่โดเมนเดียวกัน
  ready: function () { return !!(local('adm_tb_token') || local('adm_tb_refresh')); },
  save: function (j) {
    if (j && j.token) local('adm_tb_token', j.token);
    if (j && j.refreshToken) local('adm_tb_refresh', j.refreshToken);
  },
  clear: function () { local('adm_tb_token', null); local('adm_tb_refresh', null); },

  login: async function (email, password) {
    var res;
    try {
      res = await fetch(TB.host() + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password: password })
      });
    } catch (e) {
      throw fail(0, 'เชื่อมต่อ ThingsBoard ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่');
    }
    if (res.status === 401) throw fail(401, 'อีเมลหรือรหัสผ่าน ThingsBoard ไม่ถูกต้อง');
    if (!res.ok) throw fail(res.status, errorText(res.status));
    TB.save(await res.json());
    var me = await TB.req('GET', '/api/auth/user');
    if (!me || me.authority !== 'TENANT_ADMIN') {
      TB.clear();
      throw fail(403, 'บัญชีนี้ไม่ใช่บัญชี Tenant ใช้กับหลังบ้านไม่ได้ (บัญชีผู้ดูแลให้เข้าที่หน้าบ้าน)');
    }
  },

  refresh: async function () {
    var rt = local('adm_tb_refresh');
    if (!rt) return false;
    try {
      var res = await fetch(TB.host() + '/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt })
      });
      if (!res.ok) return false;
      TB.save(await res.json());
      return true;
    } catch (e) { return false; }
  },

  fresh: async function () {
    var t = local('adm_tb_token');
    var exp = t ? jwtExp(t) : 0;
    if (!t || (exp && exp - Date.now() < 60000)) {
      if (await TB.refresh()) t = local('adm_tb_token');
    }
    return t;
  },

  req: async function (method, path, body, opt) {
    opt = opt || {};
    var token = await TB.fresh();
    if (!token) { TB.clear(); throw expired(); }
    var init = { method: method, headers: { 'X-Authorization': 'Bearer ' + token } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var res;
    try { res = await fetch(TB.host() + path, init); } catch (e) {
      throw fail(0, 'เชื่อมต่อ ThingsBoard ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่');
    }
    if (res.status === 401 && !opt.retried && await TB.refresh()) {
      opt.retried = true;
      return TB.req(method, path, body, opt);
    }
    if (res.status === 401) { TB.clear(); throw expired(); }
    if (!res.ok) {
      var err = fail(res.status, errorText(res.status));
      try { err.tb = (await res.json()).message || ''; } catch (e) { err.tb = ''; }
      throw err;
    }
    var text = await res.text();
    if (opt.text) return text;
    return text ? JSON.parse(text) : null;
  }
};

var API = {
  me: function () { return TB.req('GET', '/api/auth/user'); },
  devices: async function () {
    var p = await TB.req('GET', '/api/tenant/deviceInfos?pageSize=200&page=0&sortProperty=name&sortOrder=ASC');
    return (p && p.data) || [];
  },
  device: function (id) { return TB.req('GET', '/api/device/' + id); },
  createDevice: function (name) { return TB.req('POST', '/api/device', { name: name, label: '' }); },
  deleteDevice: function (id) { return TB.req('DELETE', '/api/device/' + id); },
  token: async function (id) { return ((await TB.req('GET', '/api/device/' + id + '/credentials')) || {}).credentialsId || ''; },
  setLabel: async function (id, label) {
    var d = await API.device(id);
    d.label = label;
    return TB.req('POST', '/api/device', d);
  },
  attrs: async function (id, scope, keys) {
    var arr = await TB.req('GET', '/api/plugins/telemetry/DEVICE/' + id + '/values/attributes/' + scope +
      '?keys=' + encodeURIComponent(keys.join(',')));
    var out = {};
    (arr || []).forEach(function (a) { out[a.key] = { value: a.value, ts: a.lastUpdateTs }; });
    return out;
  },
  series: function (id, keys, from, to) {
    return TB.req('GET', '/api/plugins/telemetry/DEVICE/' + id + '/values/timeseries?keys=' + keys.join(',') +
      '&startTs=' + Math.floor(from) + '&endTs=' + Math.ceil(to) + '&limit=5000&orderBy=ASC&useStrictDataTypes=true');
  },
  shared: function (id, obj) { return TB.req('POST', '/api/plugins/telemetry/DEVICE/' + id + '/attributes/SHARED_SCOPE', obj); },
  customers: async function () {
    var p = await TB.req('GET', '/api/customers?pageSize=200&page=0&sortProperty=title&sortOrder=ASC');
    // ซ่อน customer "Public" ที่ ThingsBoard สร้างให้ทุก tenant
    return ((p && p.data) || []).filter(function (c) { return !(c.additionalInfo && c.additionalInfo.isPublic); });
  },
  createCustomer: function (title, phone) { return TB.req('POST', '/api/customer', { title: title, phone: phone || '' }); },
  deleteCustomer: function (id) { return TB.req('DELETE', '/api/customer/' + id); },
  users: async function (cid) {
    var p = await TB.req('GET', '/api/customer/' + cid + '/users?pageSize=200&page=0');
    return (p && p.data) || [];
  },
  createUser: function (cid, u) {
    return TB.req('POST', '/api/user?sendActivationMail=false', {
      email: u.email, firstName: u.firstName, lastName: u.lastName, phone: u.phone,
      authority: 'CUSTOMER_USER', customerId: { id: cid, entityType: 'CUSTOMER' }
    });
  },
  activationLink: function (uid) { return TB.req('GET', '/api/user/' + uid + '/activationLink', undefined, { text: true }); },
  sendActivation: function (email) { return TB.req('POST', '/api/user/sendActivationMail?email=' + encodeURIComponent(email)); },
  deleteUser: function (uid) { return TB.req('DELETE', '/api/user/' + uid); },
  assign: function (cid, did) { return TB.req('POST', '/api/customer/' + cid + '/device/' + did); },
  unassign: function (did) { return TB.req('DELETE', '/api/customer/device/' + did); },
  alarms: function (status, size) {
    return TB.req('GET', '/api/alarms?searchStatus=' + status + '&pageSize=' + size +
      '&page=0&sortProperty=createdTime&sortOrder=DESC&fetchOriginator=true');
  },
  ack: function (id) { return TB.req('POST', '/api/alarm/' + id + '/ack'); },
  clearAlarm: function (id) { return TB.req('POST', '/api/alarm/' + id + '/clear'); }
};

/* ---------- ข้อมูลการกินยา ---------- */

// แปลง telemetry เป็นรายการ [{ ts, dev, kind: 'dose' | 'sos', meal, dose, reminders }]
async function recordsOf(dev, from, to) {
  var r = (await API.series(dev.id.id, KEYS, from, to)) || {};
  var byTs = {};
  KEYS.forEach(function (k) {
    (r[k] || []).forEach(function (p) { (byTs[p.ts] = byTs[p.ts] || { ts: Number(p.ts) })[k] = p.value; });
  });
  var out = [];
  Object.keys(byTs).forEach(function (k) {
    var x = byTs[k];
    if (isTrue(x.sos)) out.push({ ts: x.ts, dev: dev, kind: 'sos' });
    if (MEALS.indexOf(x.meal) >= 0 && (x.dose === 'taken' || x.dose === 'missed')) {
      out.push({ ts: x.ts, dev: dev, kind: 'dose', meal: x.meal, dose: x.dose, reminders: Number(x.reminders) || 0 });
    }
  });
  return out;
}

function todaySummary(recs) {
  var latest = {};
  recs.forEach(function (r) {
    if (r.kind === 'dose' && (!latest[r.meal] || latest[r.meal].ts <= r.ts)) latest[r.meal] = r;
  });
  var taken = 0, missed = 0;
  MEALS.forEach(function (m) {
    if (latest[m]) { if (latest[m].dose === 'taken') taken++; else missed++; }
  });
  return { taken: taken, missed: missed };
}

async function statusOf(dev) {
  var id = dev.id.id;
  try {
    var r = await Promise.all([
      API.attrs(id, 'SERVER_SCOPE', ['active', 'lastActivityTime']),
      API.attrs(id, 'CLIENT_SCOPE', ['fw_version']),
      recordsOf(dev, dayStart(Date.now()), Date.now())
    ]);
    return {
      dev: dev,
      online: r[0].active ? isTrue(r[0].active.value) : false,
      last: r[0].lastActivityTime ? Number(r[0].lastActivityTime.value) : null,
      fw: r[1].fw_version ? String(r[1].fw_version.value) : '',
      today: todaySummary(r[2])
    };
  } catch (e) {
    if (e.expired) throw e;
    return { dev: dev, error: e.message };
  }
}

function alarmType(t) { return t === 'SOS' ? 'ขอความช่วยเหลือ' : t === 'MISSED_DOSE' ? 'ลืมกินยา' : t; }
function alarmAcked(a) { return a.acknowledged === true || /_ACK$/.test(a.status || ''); }
function alarmCleared(a) { return a.cleared === true || /^CLEARED/.test(a.status || ''); }