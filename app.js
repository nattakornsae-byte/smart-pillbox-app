/*
 * ตั้งค่าเว็บ Smart Pillbox
 * ไฟล์นี้ไม่มีรหัสผ่านหรือ token ใด ๆ จึงอัปโหลดขึ้น GitHub ได้
 * ผู้ดูแลจะพิมพ์อีเมลและรหัสผ่านของตัวเองตอนเข้าสู่ระบบ
 */
window.APP_CONFIG = {
  // ที่อยู่ ThingsBoard ที่ใช้ในแล็บ
  TB_HOST: 'https://demo.thingsboard.io',

  // ชื่อ device ของตู้ยาใน ThingsBoard
  // เว้นว่างไว้ = ใช้ตู้แรกที่บัญชีนี้มองเห็น
  DEVICE_NAME: '',

  // ดึงข้อมูลซ้ำทุกกี่มิลลิวินาที (กันกรณี WebSocket หลุด)
  POLL_MS: 30000
};

/*
 * ต่อ ThingsBoard ผ่าน REST API + WebSocket
 * ชื่อ key ต้องตรงกับ docs/api-contract.md (เฟิร์มแวร์ใช้ชื่อเดียวกัน)
 * ห้าม console.log token
 */
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var MEALS = ['morning', 'noon', 'evening', 'bedtime'];
  var LABELS = { morning: 'มื้อเช้า', noon: 'มื้อกลางวัน', evening: 'มื้อเย็น', bedtime: 'ก่อนนอน' };
  var SHORT = { morning: 'เช้า', noon: 'กลางวัน', evening: 'เย็น', bedtime: 'ก่อนนอน' };

  /* ---------- ฟังก์ชันกลาง ใช้ทั้งโหมดจริงและโหมดตัวอย่าง ---------- */

  function startOfDay(d) {
    var x = new Date(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  }

  function dayKey(ts) {
    var d = new Date(ts);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function isTrue(v) { return v === true || v === 'true'; }

  function parseSchedule(v) {
    if (!v) return null;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
    return (v && typeof v === 'object') ? v : null;
  }

  // เอาผลมื้อล่าสุดของแต่ละมื้อในแต่ละวัน: { 'YYYY-MM-DD': { morning: record, ... } }
  function latestPerDayMeal(records) {
    var out = {};
    records.forEach(function (r) {
      var k = dayKey(r.ts);
      out[k] = out[k] || {};
      if (!out[k][r.meal] || out[k][r.meal].ts <= r.ts) out[k][r.meal] = r;
    });
    return out;
  }

  function buildToday(schedule, records) {
    var latest = latestPerDayMeal(records)[dayKey(Date.now())] || {};
    return MEALS.map(function (k) {
      var s = (schedule && schedule[k]) || {};
      var r = latest[k];
      return {
        key: k,
        label: LABELS[k],
        time: s.time || '',
        med: s.med || '',
        status: r ? r.dose : 'wait',
        at: r ? r.ts : null,
        reminders: r ? (Number(r.reminders) || 0) : 0
      };
    });
  }

  window.PillboxData = {
    MEALS: MEALS, LABELS: LABELS, SHORT: SHORT,
    startOfDay: startOfDay, dayKey: dayKey, isTrue: isTrue,
    parseSchedule: parseSchedule, latestPerDayMeal: latestPerDayMeal, buildToday: buildToday
  };

  /* ---------- เก็บ token ในเบราว์เซอร์ของเครื่องนี้ ---------- */

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  function host() { return String(cfg.TB_HOST || '').replace(/\/+$/, ''); }

  function apiError(status, message) {
    var e = new Error(message);
    e.status = status;
    return e;
  }

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

  function saveTokens(j) {
    if (j && j.token) store.set('tb_token', j.token);
    if (j && j.refreshToken) store.set('tb_refresh', j.refreshToken);
  }

  /* ---------- โหมดจริง: ThingsBoard ---------- */

  var TBApi = {
    isDemo: false,
    _user: null,
    _device: null,

    ready: function () { return !!store.get('tb_token'); },

    login: async function (username, password) {
      var res;
      try {
        res = await fetch(host() + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username, password: password })
        });
      } catch (e) {
        throw apiError(0, 'เชื่อมต่อ ThingsBoard ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่');
      }
      if (res.status === 401) throw apiError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง กรุณากรอกใหม่');
      if (!res.ok) throw apiError(res.status, errorText(res.status));
      saveTokens(await res.json());
      this._user = null;
      this._device = null;
    },

    logout: function () {
      this.unsubscribe();
      store.del('tb_token');
      store.del('tb_refresh');
      this._user = null;
      this._device = null;
    },

    _refresh: async function () {
      var rt = store.get('tb_refresh');
      if (!rt) return false;
      try {
        var res = await fetch(host() + '/api/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt })
        });
        if (!res.ok) return false;
        saveTokens(await res.json());
        return true;
      } catch (e) { return false; }
    },

    _freshToken: async function () {
      var t = store.get('tb_token');
      if (t && jwtExp(t) && jwtExp(t) - Date.now() < 60000) {
        await this._refresh();
        t = store.get('tb_token');
      }
      return t;
    },

    req: async function (method, path, body, retried) {
      var token = await this._freshToken();
      if (!token) throw apiError(401, 'กรุณาเข้าสู่ระบบ');
      var opt = { method: method, headers: { 'X-Authorization': 'Bearer ' + token } };
      if (body !== undefined) {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(body);
      }
      var res;
      try { res = await fetch(host() + path, opt); } catch (e) {
        throw apiError(0, 'เชื่อมต่อ ThingsBoard ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่');
      }
      if (res.status === 401 && !retried && await this._refresh()) {
        return this.req(method, path, body, true);
      }
      if (res.status === 401) {
        this.logout();
        throw apiError(401, 'หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่');
      }
      if (!res.ok) throw apiError(res.status, errorText(res.status));
      var text = await res.text();
      return text ? JSON.parse(text) : null;
    },

    me: async function (force) {
      if (!this._user || force) this._user = await this.req('GET', '/api/auth/user');
      return this._user;
    },

    device: async function () {
      if (this._device) return this._device;
      var u = await this.me();
      var path = u.authority === 'TENANT_ADMIN'
        ? '/api/tenant/devices?pageSize=50&page=0'
        : '/api/customer/' + u.customerId.id + '/devices?pageSize=50&page=0';
      var page = await this.req('GET', path);
      var list = (page && page.data) || [];
      var want = String(cfg.DEVICE_NAME || '').trim();
      var d = want ? list.filter(function (x) { return x.name === want; })[0] : list[0];
      if (!d) {
        throw apiError(404, want
          ? 'ไม่พบตู้ชื่อ "' + want + '" ในบัญชีนี้'
          : 'ยังไม่มีตู้ที่ผูกกับบัญชีนี้ ให้ผู้ดูแลระบบ assign device ให้ customer ก่อน');
      }
      this._device = d;
      return d;
    },

    _base: async function () {
      var d = await this.device();
      return '/api/plugins/telemetry/DEVICE/' + d.id.id;
    },

    // คืนค่า { key: { value, ts } }
    attrs: async function (scope, keys) {
      var base = await this._base();
      var arr = await this.req('GET', base + '/values/attributes/' + scope + '?keys=' + encodeURIComponent(keys.join(',')));
      var out = {};
      (arr || []).forEach(function (a) { out[a.key] = { value: a.value, ts: a.lastUpdateTs }; });
      return out;
    },

    saveShared: async function (obj) {
      var base = await this._base();
      return this.req('POST', base + '/attributes/SHARED_SCOPE', obj);
    },

    // ผลกินยาเป็นรายการ [{ ts, meal, dose, reminders }] เรียงจากเก่าไปใหม่
    getRecords: async function (fromTs, toTs) {
      var base = await this._base();
      var q = '?keys=meal,dose,reminders&startTs=' + Math.floor(fromTs) + '&endTs=' + Math.ceil(toTs) +
        '&limit=1000&orderBy=ASC&useStrictDataTypes=true';
      var r = (await this.req('GET', base + '/values/timeseries' + q)) || {};
      var byTs = {};
      ['meal', 'dose', 'reminders'].forEach(function (k) {
        (r[k] || []).forEach(function (p) {
          byTs[p.ts] = byTs[p.ts] || { ts: p.ts };
          byTs[p.ts][k] = p.value;
        });
      });
      return Object.keys(byTs).map(function (k) { return byTs[k]; })
        .filter(function (x) { return MEALS.indexOf(x.meal) >= 0 && (x.dose === 'taken' || x.dose === 'missed'); })
        .sort(function (a, b) { return a.ts - b.ts; });
    },

    getStatus: async function () {
      var d = await this.device();
      var s = await this.attrs('SERVER_SCOPE', ['active', 'lastActivityTime']);
      return {
        name: d.label || d.name,
        online: s.active ? isTrue(s.active.value) : false,
        last: s.lastActivityTime ? Number(s.lastActivityTime.value) : null
      };
    },

    getToday: async function () {
      var results = await Promise.all([
        this.attrs('SHARED_SCOPE', ['schedule']),
        this.getRecords(startOfDay(Date.now()), Date.now())
      ]);
      var sched = results[0].schedule ? parseSchedule(results[0].schedule.value) : null;
      return buildToday(sched, results[1]);
    },

    getSchedule: async function () {
      var r = await Promise.all([
        this.attrs('SHARED_SCOPE', ['schedule']),
        this.attrs('CLIENT_SCOPE', ['schedule_received']),
        this.attrs('SERVER_SCOPE', ['active'])
      ]);
      return {
        schedule: r[0].schedule ? parseSchedule(r[0].schedule.value) : null,
        savedTs: r[0].schedule ? r[0].schedule.ts : null,
        // ใช้เวลาที่เซิร์ฟเวอร์ได้รับ (lastUpdateTs) ไม่ขึ้นกับนาฬิกาของตู้
        received: r[1].schedule_received ? r[1].schedule_received.ts : null,
        online: r[2].active ? isTrue(r[2].active.value) : false
      };
    },

    saveSchedule: async function (schedule) {
      await this.saveShared({ schedule: schedule });
    },

    // คำขอความช่วยเหลือที่ยังไม่มีใครรับทราบ หรือ null
    getSos: async function () {
      var d = await this.device();
      var page = await this.req('GET', '/api/alarm/DEVICE/' + d.id.id +
        '?searchStatus=ACTIVE&pageSize=20&page=0&sortProperty=createdTime&sortOrder=DESC');
      var a = ((page && page.data) || []).filter(function (x) {
        return x.type === 'SOS' && !x.acknowledged && x.status !== 'ACTIVE_ACK';
      })[0];
      return a ? { id: a.id.id, createdTime: a.createdTime } : null;
    },

    ackSos: async function (alarmId) {
      await this.req('POST', '/api/alarm/' + alarmId + '/ack');
      var now = Date.now();
      var warn = null;
      try { await this.saveShared({ sos_ack: now }); } catch (e) {
        warn = 'รับทราบแล้ว แต่ส่งสถานะไปที่ตู้ไม่สำเร็จ: ' + e.message;
      }
      return { ackTs: now, warn: warn };
    },

    getProfile: async function () {
      var u = await this.me(true);
      return {
        fullName: [u.firstName, u.lastName].filter(Boolean).join(' '),
        phone: u.phone || '',
        email: u.email || ''
      };
    },

    saveProfile: async function (p) {
      var u = Object.assign({}, await this.me(true));
      var parts = String(p.fullName || '').trim().split(/\s+/).filter(Boolean);
      u.firstName = parts.shift() || '';
      u.lastName = parts.join(' ');
      u.phone = p.phone || '';
      this._user = await this.req('POST', '/api/user', u);
    },

    changePassword: async function (current, next) {
      var j = await this.req('POST', '/api/auth/changePassword', { currentPassword: current, newPassword: next });
      saveTokens(j);
    },

    // ฟังข้อมูลสดผ่าน WebSocket: มีผลกินยาหรือ SOS ใหม่ → เรียก onChange()
    subscribe: function (onChange) {
      var self = this;
      self.unsubscribe();
      var closed = false;
      var delay = 1000;
      var keys = ['meal', 'dose', 'reminders', 'sos'].map(function (k) { return { type: 'TIME_SERIES', key: k }; });

      async function open() {
        if (closed) return;
        var token = await self._freshToken();
        if (!token || closed) return;
        var ws;
        try { ws = new WebSocket(host().replace(/^http/, 'ws') + '/api/ws'); } catch (e) { return; }
        self._ws = ws;
        ws.onopen = function () {
          delay = 1000;
          ws.send(JSON.stringify({
            authCmd: { cmdId: 0, token: token },
            cmds: [{
              cmdId: 1,
              type: 'ENTITY_DATA',
              query: {
                entityFilter: { type: 'entityType', entityType: 'DEVICE' },
                pageLink: { pageSize: 10, page: 0, sortOrder: { key: { type: 'ENTITY_FIELD', key: 'name' }, direction: 'ASC' } },
                entityFields: [{ type: 'ENTITY_FIELD', key: 'name' }],
                latestValues: keys
              },
              latestCmd: { keys: keys }
            }]
          }));
        };
        ws.onmessage = function (ev) {
          var m;
          try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m && m.update) onChange();
        };
        ws.onclose = function () {
          if (closed) return;
          self._wsTimer = setTimeout(open, delay);
          delay = Math.min(delay * 2, 30000);
        };
        ws.onerror = function () { try { ws.close(); } catch (e) { /* ignore */ } };
      }

      self._stopWs = function () {
        closed = true;
        clearTimeout(self._wsTimer);
        if (self._ws) { try { self._ws.close(); } catch (e) { /* ignore */ } }
        self._ws = null;
      };
      open();
    },

    unsubscribe: function () {
      if (this._stopWs) this._stopWs();
      this._stopWs = null;
    }
  };

  window.TBApi = TBApi;
})();

/*
 * โหมดตัวอย่าง: ข้อมูลจำลองในเบราว์เซอร์ ไม่ต่อ ThingsBoard
 * ใช้ทดลองหน้าเว็บก่อนบอร์ดจริงพร้อม ข้อมูลหายเมื่อปิดหน้า
 */
(function () {
  'use strict';

  var D = window.PillboxData;
  var MIN = 60000;
  var DAY = 24 * 60 * MIN;

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function at(dayStart, hhmm, plusMin) {
    var p = hhmm.split(':');
    return dayStart + (Number(p[0]) * 60 + Number(p[1]) + (plusMin || 0)) * MIN;
  }

  var schedule = {
    morning: { time: '08:00', med: '' },
    noon: { time: '12:00', med: '' },
    evening: { time: '18:00', med: '' },
    bedtime: { time: '21:00', med: '' }
  };

  // ผลย้อนหลัง 29 วัน + วันนี้ (มื้อที่ลืมกำหนดไว้ตายตัว ตัวเลขสถิติจึงคงที่)
  var missed = { 1: 'noon', 2: 'evening', 3: 'bedtime', 5: 'noon', 9: 'noon', 12: 'evening',
    15: 'noon', 18: 'bedtime', 21: 'noon', 25: 'evening', 27: 'noon', 29: 'bedtime' };

  function buildRecords() {
    var today = D.startOfDay(Date.now());
    var out = [];
    for (var d = 29; d >= 1; d--) {
      var start = today - d * DAY;
      D.MEALS.forEach(function (k, i) {
        if (missed[d] === k) {
          out.push({ ts: at(start, schedule[k].time, 45), meal: k, dose: 'missed', reminders: 3 });
        } else {
          var off = ((d * 7 + i * 5) % 25) + 1;
          out.push({ ts: at(start, schedule[k].time, off), meal: k, dose: 'taken', reminders: off > 15 ? 2 : 1 });
        }
      });
    }
    [['morning', '08:12', 'taken', 1], ['noon', '12:45', 'missed', 3],
      ['evening', '18:09', 'taken', 1], ['bedtime', '21:07', 'taken', 1]].forEach(function (r) {
      var ts = at(today, r[1], 0);
      if (ts <= Date.now()) out.push({ ts: ts, meal: r[0], dose: r[2], reminders: r[3] });
    });
    return out;
  }

  var records = buildRecords();
  var sos = { id: 'demo-sos', createdTime: Date.now() - 6 * MIN };
  var received = D.startOfDay(Date.now()) - DAY + (20 * 60 + 15) * MIN;
  var profile = { fullName: 'ผู้ดูแล (ตัวอย่าง)', phone: '', email: 'demo@example.com' };

  window.DemoApi = {
    isDemo: true,
    ready: function () { return true; },
    logout: function () { /* nothing to clear */ },

    getStatus: async function () {
      await wait(120);
      return { name: 'ผู้สูงอายุ (ตัวอย่าง)', online: true, last: Date.now() - 2 * MIN };
    },

    getToday: async function () {
      await wait(120);
      return D.buildToday(schedule, records);
    },

    getRecords: async function (fromTs, toTs) {
      await wait(150);
      return records.filter(function (r) { return r.ts >= fromTs && r.ts <= toTs; });
    },

    getSchedule: async function () {
      await wait(120);
      return { schedule: JSON.parse(JSON.stringify(schedule)), savedTs: received - 5 * MIN, received: received, online: true };
    },

    saveSchedule: async function (s) {
      await wait(300);
      schedule = JSON.parse(JSON.stringify(s));
    },

    getSos: async function () {
      await wait(120);
      return sos;
    },

    ackSos: async function () {
      await wait(300);
      sos = null;
      return { ackTs: Date.now(), warn: null };
    },

    getProfile: async function () {
      await wait(100);
      return Object.assign({}, profile);
    },

    saveProfile: async function (p) {
      await wait(250);
      profile.fullName = p.fullName;
      profile.phone = p.phone;
    },

    changePassword: async function () {
      await wait(250);
    },

    subscribe: function () { /* โหมดตัวอย่างไม่มีข้อมูลสด */ },
    unsubscribe: function () { /* nothing */ }
  };
})();

/*
 * หน้าเว็บผู้ดูแล Smart Pillbox (Single Page App แบบ hash route ใช้บน GitHub Pages ได้)
 * หน้า: #/login #/home #/schedule #/history #/stats #/emergency #/profile
 */
(function () {
  'use strict';

  var D = window.PillboxData;
  var cfg = window.APP_CONFIG || {};
  var DAY = 24 * 60 * 60 * 1000;
  var $app = document.getElementById('app');
  var $toast = document.getElementById('toast');

  function session(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v);
    } catch (e) { return null; }
    return null;
  }

  var api = session('pb_demo') === '1' ? window.DemoApi : window.TBApi;

  /* ---------- ไอคอนและตัวช่วย ---------- */

  var PATHS = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    chart: '<path d="M5 20v-8M12 20V5M19 20v-11"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    send: '<path d="M4 12h12M12 6l6 6-6 6"/>'
  };

  function icon(name, size) {
    var s = size || 24;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PATHS[name] + '</svg>';
  }

  function logo(size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 36 36" aria-hidden="true">' +
      '<rect x="2" y="2" width="32" height="32" rx="9" fill="#1E2C55"/>' +
      '<path d="M18 7v22M7 18h22" stroke="#F6EFE2" stroke-width="2.5" fill="none"/>' +
      '<path d="M21 26l3 3 6-7" stroke="#F6EFE2" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hhmm(ts) { return new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }); }
  function dateShort(ts) { return new Date(ts).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function dateLong(ts) { return new Date(ts).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }); }
  function dayHead(ts) { return new Date(ts).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'short' }); }
  function dateTime(ts) { return dateShort(ts) + ' ' + hhmm(ts); }
  function isoDate(ts) { return D.dayKey(ts); }
  function byId(id) { return document.getElementById(id); }

  var toastTimer = null;
  function toast(msg, kind) {
    $toast.textContent = msg;
    $toast.className = 'toast' + (kind ? ' ' + kind : '');
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 3500);
  }

  /* ---------- โครงหน้า ---------- */

  function nav(tab) {
    var items = [['home', 'วันนี้', 'home'], ['schedule', 'ตารางยา', 'clock'], ['history', 'ประวัติ', 'calendar'], ['stats', 'สถิติ', 'chart']];
    return '<nav class="nav" aria-label="เมนูหลัก"><div class="nav-inner">' + items.map(function (it) {
      return '<a href="#/' + it[0] + '"' + (tab === it[0] ? ' aria-current="page"' : '') + '><span class="ic">' +
        icon(it[2]) + '</span>' + it[1] + '</a>';
    }).join('') + '</div></nav>';
  }

  function shell(main, tab) {
    return '<header class="topbar">' + logo(36) + '<span class="brand">Smart Pillbox</span>' +
      (api.isDemo ? '<span class="demo-badge">ข้อมูลตัวอย่าง</span>' : '') +
      '<a class="icon-btn" href="#/profile" aria-label="ข้อมูลส่วนตัว">' + icon('user') + '</a></header>' +
      '<main class="content">' + main + '</main>' + nav(tab);
  }

  function pageShell(title, main) {
    return '<div class="page"><div class="page-head"><a class="back" href="#/home" aria-label="กลับหน้าหลัก">' +
      icon('left') + '</a><h1>' + title + '</h1></div>' + main + '</div>';
  }

  function emerShell(red, inner) {
    return '<div class="emer' + (red ? '' : ' done') + '"><a class="emer-back" href="#/home">' + icon('left', 22) +
      'หน้าหลัก</a>' + inner + '</div>';
  }

  var LOADING = '<p class="loading">กำลังโหลด…</p>';

  /* ---------- หน้าเข้าสู่ระบบ ---------- */

  function pageLogin() {
    $app.innerHTML = '<div class="login"><div class="login-head">' + logo(72) +
      '<h1>Smart Pillbox</h1><p class="muted">เว็บไซต์สำหรับผู้ดูแล</p></div>' +
      '<form class="card form" id="loginForm" novalidate>' +
      '<label for="email">อีเมล</label>' +
      '<input class="input" id="email" type="email" autocomplete="username" inputmode="email" required>' +
      '<label for="password">รหัสผ่าน</label>' +
      '<input class="input" id="password" type="password" autocomplete="current-password" required>' +
      '<p class="alert" id="loginErr" role="alert" hidden></p>' +
      '<button class="btn primary" type="submit">เข้าสู่ระบบ</button></form>' +
      '<button class="btn ghost" id="demoBtn" type="button">ดูตัวอย่างด้วยข้อมูลจำลอง</button>' +
      '<p class="muted center">ยังไม่มีบัญชี ติดต่อผู้ดูแลระบบ</p></div>';

    var form = byId('loginForm');
    var err = byId('loginErr');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var email = byId('email').value.trim();
      var pw = byId('password').value;
      if (!email || !pw) { err.textContent = 'กรุณากรอกอีเมลและรหัสผ่าน'; err.hidden = false; return; }
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'กำลังเข้าสู่ระบบ…';
      err.hidden = true;
      try {
        await window.TBApi.login(email, pw);
        session('pb_demo', null);
        api = window.TBApi;
        startLive();
        go('home');
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = 'เข้าสู่ระบบ';
      }
    });
    byId('demoBtn').addEventListener('click', function () {
      stopLive();
      session('pb_demo', '1');
      api = window.DemoApi;
      go('home');
    });
  }

  /* ---------- หน้าหลัก (วันนี้) ---------- */

  function mealCard(m) {
    var right;
    if (m.status === 'taken') {
      right = '<div class="meal-right"><span class="pill taken">' + icon('check', 18) + 'กินแล้ว</span>' +
        '<span class="small muted">ยืนยัน ' + hhmm(m.at) + ' · เตือน ' + (m.reminders || 1) + ' ครั้ง</span></div>';
    } else if (m.status === 'missed') {
      right = '<div class="meal-right"><span class="pill missed">' + icon('alert', 18) + 'ลืมกินยา</span>' +
        '<span class="small muted">เตือนครบ ' + (m.reminders || 3) + ' ครั้ง</span></div>';
    } else {
      right = '<span class="pill wait">' + icon('clock', 18) + 'รอเวลา</span>';
    }
    var sub = [m.time || 'ยังไม่ตั้งเวลา', m.med].filter(Boolean).map(esc).join(' · ');
    return '<article class="card meal' + (m.status === 'missed' ? ' is-missed' : '') + '">' +
      '<div class="grow"><span class="meal-name">' + m.label + '</span><span class="small muted">' + sub + '</span></div>' +
      right + '</article>';
  }

  async function pageHome(seq, quiet) {
    if (!quiet) $app.innerHTML = shell(LOADING, 'home');
    var r = await Promise.all([api.getStatus(), api.getToday(), api.getSos()]);
    if (seq !== renderSeq) return;
    var st = r[0], meals = r[1], sos = r[2];
    var taken = meals.filter(function (m) { return m.status === 'taken'; }).length;
    var html = '';
    if (sos) {
      html += '<a class="sos-banner" href="#/emergency">' + icon('alert', 28) +
        '<span class="grow"><strong>มีคำขอความช่วยเหลือ</strong><span class="sos-sub">เมื่อ ' + hhmm(sos.createdTime) +
        ' น. กดเพื่อดูและรับทราบ</span></span>' + icon('right', 22) + '</a>';
    }
    var lastText = st.last ? (st.online ? 'อัปเดตล่าสุด ' + hhmm(st.last) : 'ข้อมูลล่าสุด ' + dateTime(st.last)) : '';
    html += '<section class="card elder"><span class="small muted">ผู้สูงอายุที่ดูแล</span>' +
      '<span class="elder-name">' + esc(st.name) + '</span>' +
      '<span class="conn"><span class="dot' + (st.online ? ' on' : '') + '" aria-hidden="true"></span>' +
      '<strong>' + (st.online ? 'ตู้ออนไลน์' : 'ตู้ออฟไลน์') + '</strong>' +
      (lastText ? '<span class="muted">' + lastText + '</span>' : '') + '</span></section>';
    html += '<div class="row-between"><h1>วันนี้</h1><span class="muted small">' + dateLong(Date.now()) + '</span></div>';
    html += meals.map(mealCard).join('');
    html += '<p class="muted center">วันนี้กินแล้ว ' + taken + ' จาก 4 มื้อ</p>';
    $app.innerHTML = shell(html, 'home');
  }

  /* ---------- หน้าตั้งตารางยา ---------- */

  function offlineNote() {
    return '<p class="note warn">' + icon('alert', 20) + 'ตู้ออฟไลน์อยู่ ระบบจะส่งตารางยาให้เมื่อตู้กลับมาออนไลน์</p>';
  }

  function scheduleStatus(d) {
    if (!d.online) return offlineNote();
    if (d.received && (!d.savedTs || d.received >= d.savedTs)) {
      return '<p class="note ok">' + icon('check', 20) + 'ตู้ได้รับตารางยาล่าสุด ' + dateTime(d.received) + '</p>';
    }
    if (d.schedule) return '<p class="note info">' + icon('send', 20) + 'รอตู้ยืนยันการรับตารางยาที่บันทึกล่าสุด</p>';
    return '<p class="note info">' + icon('clock', 20) + 'ยังไม่มีตารางยา กรอกแล้วกดบันทึก</p>';
  }

  function readSchedule(showAll) {
    var out = {};
    var ok = true;
    var seen = {};
    D.MEALS.forEach(function (k) {
      var t = byId('t-' + k).value.trim();
      var m = byId('m-' + k).value.trim();
      var err = '';
      if (!t) err = 'กรุณากรอกเวลา';
      else if (seen[t]) err = 'เวลาซ้ำกับ' + D.LABELS[seen[t]] + ' เลือกเวลาใหม่';
      else seen[t] = k;
      var box = byId('e-' + k);
      var card = box.parentNode;
      if (err && (showAll || t)) {
        box.textContent = err;
        box.hidden = false;
        card.classList.add('is-missed');
      } else {
        box.hidden = true;
        card.classList.remove('is-missed');
      }
      if (err) ok = false;
      out[k] = { time: t, med: m };
    });
    return ok ? out : null;
  }

  async function pageSchedule(seq) {
    $app.innerHTML = shell(LOADING, 'schedule');
    var data = await api.getSchedule();
    if (seq !== renderSeq) return;
    var s = data.schedule || {};
    var fields = D.MEALS.map(function (k) {
      var v = s[k] || {};
      return '<div class="card meal-form">' +
        '<div class="row"><label class="meal-name grow" for="t-' + k + '">' + D.LABELS[k] + '</label>' +
        '<input class="input time" id="t-' + k + '" type="time" value="' + esc(v.time || '') + '" required></div>' +
        '<div class="row"><label class="small muted label-w" for="m-' + k + '">ชื่อยา</label>' +
        '<input class="input grow-input" id="m-' + k + '" type="text" maxlength="60" placeholder="ชื่อยาและจำนวนเม็ด" value="' +
        esc(v.med || '') + '"></div>' +
        '<p class="field-err" id="e-' + k + '" role="alert" hidden></p></div>';
    }).join('');
    $app.innerHTML = shell('<div><h1>ตารางยา</h1><p class="muted">ตั้งเวลาและชื่อยาของ 4 มื้อ</p></div>' +
      '<div id="schedStatus">' + scheduleStatus(data) + '</div>' +
      '<form id="schedForm" class="stack" novalidate>' + fields +
      '<button class="btn primary" type="submit">บันทึกและส่งไปที่ตู้</button></form>', 'schedule');

    var form = byId('schedForm');
    form.addEventListener('input', function () { readSchedule(false); });
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var sched = readSchedule(true);
      if (!sched) { toast('ยังมีช่องที่ต้องแก้', 'err'); return; }
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'กำลังบันทึก…';
      try {
        await api.saveSchedule(sched);
        toast('บันทึกแล้ว กำลังส่งตารางยาไปที่ตู้', 'ok');
        byId('schedStatus').innerHTML = data.online
          ? '<p class="note info">' + icon('send', 20) + 'บันทึกแล้ว รอตู้ยืนยันการรับตารางยา</p>'
          : offlineNote();
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = 'บันทึกและส่งไปที่ตู้';
      }
    });
  }

  /* ---------- หน้าประวัติ ---------- */

  var hist = { range: '7d', from: '', to: '' };

  function historyRange() {
    var now = Date.now();
    if (hist.range === '7d') return { from: D.startOfDay(now) - 6 * DAY, to: now };
    if (hist.range === '30d') return { from: D.startOfDay(now) - 29 * DAY, to: now };
    if (!hist.from || !hist.to) return null;
    var f = new Date(hist.from + 'T00:00:00').getTime();
    var t = new Date(hist.to + 'T23:59:59').getTime();
    if (isNaN(f) || isNaN(t) || f > t) return null;
    return { from: f, to: Math.min(t, now) };
  }

  function dayCard(key, day) {
    var recs = D.MEALS.map(function (m) { return day[m]; }).filter(Boolean);
    var takenN = recs.filter(function (r) { return r.dose === 'taken'; }).length;
    var cells = D.MEALS.map(function (m) {
      var r = day[m];
      if (!r) return '<div class="cell none"><span>' + D.SHORT[m] + '</span><strong>–</strong><span>ไม่มีข้อมูล</span></div>';
      if (r.dose === 'missed') {
        return '<div class="cell missed"><span>' + D.SHORT[m] + '</span><strong>ลืมกินยา</strong><span>เตือน ' + (r.reminders || 3) + '</span></div>';
      }
      return '<div class="cell taken"><span>' + D.SHORT[m] + '</span><strong>' + hhmm(r.ts) + '</strong><span>เตือน ' + (r.reminders || 1) + '</span></div>';
    }).join('');
    return '<section class="card day"><div class="row-between"><h2>' + dayHead(new Date(key + 'T00:00:00').getTime()) +
      '</h2><span class="small muted">กิน ' + takenN + ' จาก ' + recs.length + ' มื้อ</span></div><div class="cells">' + cells + '</div></section>';
  }

  async function pageHistory(seq) {
    var chips = [['7d', '7 วันล่าสุด'], ['30d', '30 วัน'], ['custom', 'เลือกช่วงวันที่']].map(function (o) {
      return '<button type="button" class="chip" data-range="' + o[0] + '" aria-pressed="' + (hist.range === o[0]) + '">' + o[1] + '</button>';
    }).join('');
    var custom = hist.range !== 'custom' ? '' :
      '<form id="rangeForm" class="card range-form" novalidate>' +
      '<div class="row"><label class="small label-w" for="from">ตั้งแต่</label><input class="input grow-input" type="date" id="from" value="' + esc(hist.from) + '" required></div>' +
      '<div class="row"><label class="small label-w" for="to">ถึง</label><input class="input grow-input" type="date" id="to" value="' + esc(hist.to) + '" required></div>' +
      '<button class="btn primary" type="submit">ดูประวัติ</button></form>';
    $app.innerHTML = shell('<h1>ประวัติการกินยา</h1><div class="chips" role="group" aria-label="ช่วงวันที่">' + chips + '</div>' +
      custom + '<div id="pageBody" class="stack">' + LOADING + '</div>', 'history');

    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (b) {
      b.addEventListener('click', function () {
        hist.range = b.getAttribute('data-range');
        if (hist.range === 'custom' && !hist.from) {
          hist.from = isoDate(Date.now() - 6 * DAY);
          hist.to = isoDate(Date.now());
        }
        render();
      });
    });
    if (byId('rangeForm')) {
      byId('rangeForm').addEventListener('submit', function (ev) {
        ev.preventDefault();
        hist.from = byId('from').value;
        hist.to = byId('to').value;
        render();
      });
    }

    var rng = historyRange();
    if (!rng) {
      byId('pageBody').innerHTML = '<p class="card empty">เลือกวันที่เริ่มต้นและวันที่สิ้นสุดให้ถูกต้อง แล้วกด "ดูประวัติ"</p>';
      return;
    }
    var recs = await api.getRecords(rng.from, rng.to);
    if (seq !== renderSeq) return;
    var byDay = D.latestPerDayMeal(recs);
    var keys = Object.keys(byDay).sort().reverse();
    var body = '<p class="muted small">' + dateShort(rng.from) + ' – ' + dateShort(rng.to) + ' · ตัวเลขใต้ผลคือจำนวนครั้งที่ตู้เตือน</p>';
    body += keys.length ? keys.map(function (k) { return dayCard(k, byDay[k]); }).join('')
      : '<p class="card empty">ไม่พบข้อมูลในช่วงวันที่เลือก</p>';
    byId('pageBody').innerHTML = body;
  }

  /* ---------- หน้าสถิติ ---------- */

  var statsPeriod = 'week';

  async function pageStats(seq) {
    var days = statsPeriod === 'week' ? 7 : 30;
    var from = D.startOfDay(Date.now()) - (days - 1) * DAY;
    var to = Date.now();
    var seg = [['week', 'รายสัปดาห์'], ['month', 'รายเดือน']].map(function (o) {
      return '<button type="button" data-period="' + o[0] + '" aria-pressed="' + (statsPeriod === o[0]) + '">' + o[1] + '</button>';
    }).join('');
    $app.innerHTML = shell('<div><h1>สถิติการกินยา</h1><p class="muted">ใช้ประกอบการพบแพทย์</p></div>' +
      '<div class="seg" role="group" aria-label="ช่วงเวลา">' + seg + '</div>' +
      '<div id="pageBody" class="stack">' + LOADING + '</div>', 'stats');
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
      b.addEventListener('click', function () { statsPeriod = b.getAttribute('data-period'); render(); });
    });

    var recs = await api.getRecords(from, to);
    if (seq !== renderSeq) return;
    var byDay = D.latestPerDayMeal(recs);
    var per = {};
    D.MEALS.forEach(function (m) { per[m] = { taken: 0, total: 0 }; });
    Object.keys(byDay).forEach(function (k) {
      D.MEALS.forEach(function (m) {
        var r = byDay[k][m];
        if (!r) return;
        per[m].total++;
        if (r.dose === 'taken') per[m].taken++;
      });
    });
    var total = 0, taken = 0, worst = null, worstMissed = 0;
    D.MEALS.forEach(function (m) {
      total += per[m].total;
      taken += per[m].taken;
      var miss = per[m].total - per[m].taken;
      if (miss > worstMissed) { worstMissed = miss; worst = m; }
    });
    var range = '<p class="muted small">' + dateShort(from) + ' – ' + dateShort(to) + ' (' + days + ' วัน)</p>';
    if (!total) {
      byId('pageBody').innerHTML = range + '<p class="card empty">ยังไม่มีข้อมูลการกินยาในช่วงนี้</p>';
      return;
    }
    var bars = D.MEALS.map(function (m) {
      var p = per[m];
      var w = p.total ? Math.round(p.taken / p.total * 100) : 0;
      return '<div class="bar-row"><span class="bar-label">' + D.SHORT[m] + '</span>' +
        '<span class="bar-track" aria-hidden="true"><span class="bar-fill' + (m === worst ? ' worst' : '') + '" style="width:' + w + '%"></span></span>' +
        '<span class="bar-val">' + p.taken + '/' + p.total + '</span></div>';
    }).join('');
    byId('pageBody').innerHTML = range +
      '<section class="big-card"><span>กินยาครบ</span><span class="big-num">' + Math.round(taken / total * 100) + '%</span>' +
      '<span>' + taken + ' จาก ' + total + ' มื้อที่มีข้อมูล</span></section>' +
      '<div class="two"><section class="card metric"><span class="small muted">ลืมกินยา</span><strong class="text-orange">' + (total - taken) + ' มื้อ</strong></section>' +
      '<section class="card metric"><span class="small muted">มื้อที่ลืมบ่อยที่สุด</span><strong>' + (worst ? D.LABELS[worst] : 'ไม่มี') + '</strong></section></div>' +
      '<section class="card bars"><h2>กินครบแยกตามมื้อ</h2>' + bars + '</section>';
  }

  /* ---------- หน้าแจ้งเหตุฉุกเฉิน ---------- */

  var emergencyBusy = false;

  function bigIcon(name) { return '<div class="emer-icon">' + icon(name, 48) + '</div>'; }

  async function pageEmergency(seq, quiet) {
    if (emergencyBusy) return;
    if (!quiet) $app.innerHTML = emerShell(true, '<p class="loading light">กำลังโหลด…</p>');
    var r = await Promise.all([api.getSos(), api.getStatus()]);
    if (seq !== renderSeq || emergencyBusy) return;
    var sos = r[0], st = r[1];
    if (!sos) {
      $app.innerHTML = emerShell(false, '<div class="emer-body">' + bigIcon('check') +
        '<h1>ไม่มีเหตุฉุกเฉินตอนนี้</h1><p>ถ้าผู้สูงอายุกดปุ่มค้างที่ตู้ หน้านี้จะแสดงคำขอทันที</p></div>' +
        '<a class="btn white" href="#/home">กลับหน้าหลัก</a>');
      return;
    }
    $app.innerHTML = emerShell(true, '<div class="emer-body">' + bigIcon('bell') +
      '<span class="emer-kicker">แจ้งเหตุฉุกเฉิน</span><h1>' + esc(st.name) + ' ขอความช่วยเหลือ</h1>' +
      '<p>กดปุ่มค้างที่ตู้เมื่อ ' + hhmm(sos.createdTime) + ' น.</p>' +
      '<p class="emer-note">ระบบส่ง LINE ซ้ำทุก 5 นาทีจนกว่าจะกดรับทราบ</p></div>' +
      '<button class="btn white red-text" id="ackBtn" type="button">รับทราบ</button>' +
      '<p class="emer-foot">กดแล้วตู้จะขึ้นข้อความให้ผู้สูงอายุรู้ว่ามีคนรับเรื่องแล้ว</p>');
    byId('ackBtn').addEventListener('click', async function () {
      var btn = this;
      emergencyBusy = true;
      btn.disabled = true;
      btn.textContent = 'กำลังส่ง…';
      try {
        var res = await api.ackSos(sos.id);
        $app.innerHTML = emerShell(false, '<div class="emer-body">' + bigIcon('check') +
          '<h1>รับทราบแล้ว</h1><p>เมื่อ ' + hhmm(res.ackTs) + ' น.</p>' +
          '<p class="emer-note">หยุดส่ง LINE ซ้ำ และตู้จะขึ้นข้อความว่าผู้ดูแลรับทราบแล้ว ติดต่อหรือไปหาผู้สูงอายุได้เลย</p>' +
          (res.warn ? '<p class="emer-note">' + esc(res.warn) + '</p>' : '') + '</div>' +
          '<a class="btn white" href="#/home">กลับหน้าหลัก</a>');
      } catch (e) {
        toast(e.message, 'err');
        btn.disabled = false;
        btn.textContent = 'รับทราบ';
      } finally {
        emergencyBusy = false;
      }
    });
  }

  /* ---------- หน้าข้อมูลส่วนตัว ---------- */

  async function pageProfile(seq) {
    $app.innerHTML = pageShell('ข้อมูลส่วนตัว', LOADING);
    var p = await api.getProfile();
    if (seq !== renderSeq) return;
    $app.innerHTML = pageShell('ข้อมูลส่วนตัว',
      '<form class="card form" id="profileForm" novalidate>' +
      '<label for="fullname">ชื่อ-นามสกุล</label><input class="input" id="fullname" type="text" autocomplete="name" value="' + esc(p.fullName) + '">' +
      '<label for="phone">เบอร์โทรศัพท์</label><input class="input" id="phone" type="tel" autocomplete="tel" inputmode="tel" value="' + esc(p.phone) + '">' +
      '<span class="label-like">อีเมล</span><span>' + esc(p.email) + '</span><span class="small muted">ใช้เข้าสู่ระบบ แก้ไขไม่ได้</span>' +
      '<button class="btn primary" type="submit">บันทึก</button></form>' +
      '<details class="card"><summary>เปลี่ยนรหัสผ่าน' + icon('right', 20) + '</summary>' +
      '<form class="form flat" id="pwForm" novalidate>' +
      '<label for="pwCur">รหัสผ่านเดิม</label><input class="input" id="pwCur" type="password" autocomplete="current-password">' +
      '<label for="pwNew">รหัสผ่านใหม่</label><input class="input" id="pwNew" type="password" autocomplete="new-password">' +
      '<label for="pwNew2">พิมพ์รหัสผ่านใหม่อีกครั้ง</label><input class="input" id="pwNew2" type="password" autocomplete="new-password">' +
      '<p class="alert" id="pwErr" role="alert" hidden></p>' +
      '<button class="btn primary" type="submit">เปลี่ยนรหัสผ่าน</button></form></details>' +
      '<section class="card stack"><h2>แจ้งเตือนทาง LINE</h2>' +
      '<p class="small">ผู้ดูแลระบบเป็นคนตั้งค่า ต้องเพิ่มเพื่อน LINE Official Account ของระบบไว้ จึงจะได้รับข้อความเมื่อผู้สูงอายุลืมกินยาหรือกดขอความช่วยเหลือ</p></section>' +
      '<button class="btn outline" id="logoutBtn" type="button">ออกจากระบบ</button>');

    byId('profileForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var btn = this.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api.saveProfile({ fullName: byId('fullname').value, phone: byId('phone').value.trim() });
        toast('บันทึกข้อมูลแล้ว', 'ok');
      } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
    });

    byId('pwForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var cur = byId('pwCur').value, nw = byId('pwNew').value, nw2 = byId('pwNew2').value;
      var err = byId('pwErr');
      err.hidden = true;
      if (!cur || !nw) { err.textContent = 'กรุณากรอกรหัสผ่านให้ครบ'; err.hidden = false; return; }
      if (nw !== nw2) { err.textContent = 'รหัสผ่านใหม่ที่กรอก 2 ครั้งไม่ตรงกัน'; err.hidden = false; return; }
      var btn = this.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api.changePassword(cur, nw);
        this.reset();
        toast('เปลี่ยนรหัสผ่านแล้ว', 'ok');
      } catch (e) {
        err.textContent = e.status === 400 ? 'รหัสผ่านเดิมไม่ถูกต้อง หรือรหัสผ่านใหม่สั้นเกินไป' : e.message;
        err.hidden = false;
      } finally { btn.disabled = false; }
    });

    byId('logoutBtn').addEventListener('click', function () {
      stopLive();
      api.logout();
      session('pb_demo', null);
      api = window.TBApi;
      go('login');
    });
  }

  /* ---------- ตัวสลับหน้า ---------- */

  var ROUTES = {
    login: pageLogin, home: pageHome, schedule: pageSchedule, history: pageHistory,
    stats: pageStats, emergency: pageEmergency, profile: pageProfile
  };
  var renderSeq = 0;

  function currentRoute() {
    var r = location.hash.replace(/^#\/?/, '').split('?')[0];
    if (ROUTES[r]) return r;
    return api.ready() ? 'home' : 'login';
  }

  function go(r) {
    if (location.hash === '#/' + r) render(); else location.hash = '#/' + r;
  }

  function showError(e, r) {
    if (e && e.status === 401) { go('login'); return; }
    var box = '<div class="card error-card" role="alert"><strong>โหลดข้อมูลไม่สำเร็จ</strong><p>' +
      esc((e && e.message) || 'เกิดข้อผิดพลาด') + '</p><button class="btn primary" id="retryBtn" type="button">ลองใหม่</button></div>';
    if (r === 'emergency') $app.innerHTML = emerShell(false, '<div class="emer-body">' + box + '</div><a class="btn white" href="#/home">กลับหน้าหลัก</a>');
    else if (r === 'profile') $app.innerHTML = pageShell('ข้อมูลส่วนตัว', box);
    else $app.innerHTML = shell(box, r);
    byId('retryBtn').addEventListener('click', function () { render(); });
  }

  async function render() {
    var r = currentRoute();
    if (r !== 'login' && !api.ready()) { go('login'); return; }
    $toast.hidden = true;
    var seq = ++renderSeq;
    try {
      await ROUTES[r](seq, false);
    } catch (e) {
      if (seq === renderSeq) showError(e, r);
    }
  }

  /* ---------- ข้อมูลสด: WebSocket + ดึงซ้ำเป็นระยะ ---------- */

  var pollTimer = null;
  var liveTimer = null;

  function liveRefresh() {
    var r = currentRoute();
    if ((r !== 'home' && r !== 'emergency') || emergencyBusy || document.hidden || !api.ready()) return;
    var seq = ++renderSeq;
    ROUTES[r](seq, true).catch(function () { /* เก็บหน้าจอเดิมไว้ ลองใหม่รอบหน้า */ });
  }

  function startLive() {
    if (api.isDemo || !api.ready()) return;
    stopLive();
    api.subscribe(function () {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(liveRefresh, 800);
    });
    pollTimer = setInterval(liveRefresh, Number(cfg.POLL_MS) || 30000);
  }

  function stopLive() {
    clearInterval(pollTimer);
    clearTimeout(liveTimer);
    pollTimer = null;
    window.TBApi.unsubscribe();
  }

  window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) liveRefresh(); });

  if (!location.hash) history.replaceState(null, '', '#/' + currentRoute());
  startLive();
  render();
})();