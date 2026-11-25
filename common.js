// =====================================================================
// 맞춤법 탐정단 · common.js
// 연결 · 서버 시계 · 실시간 구독과 대비책 · 작은 도우미들
// teacher.html 과 student.html 이 함께 씁니다.
// =====================================================================

// ---------- 1. Supabase 연결 ----------
const CFG = window.APP_CONFIG || {};
const CONFIG_READY = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(CFG.SUPABASE_URL || '') && !!CFG.SUPABASE_KEY;
const db = window.supabase.createClient(
  CONFIG_READY ? CFG.SUPABASE_URL : 'https://config-not-set.supabase.co',
  CONFIG_READY ? CFG.SUPABASE_KEY : 'config-not-set', {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 20 } }
});

// DB 함수 부르기. 오류는 짧은 코드(err.code)로 바꿔 던짐
async function call(fn, args = {}) {
  if (!CONFIG_READY) {
    const e = new Error('config.js 에 Supabase 주소(https://….supabase.co)와 publishable key 를 넣어 주세요.');
    e.code = 'config'; throw e;
  }
  let data, error;
  try {
    ({ data, error } = await db.rpc(fn, args));
  } catch (ex) { error = ex; }
  if (error) {
    const msg = String(error.message || error) + ' ' + String(error.hint || '') + ' ' + String(error.code || '');
    const known = Object.keys(ERROR_TEXT).find(k => msg.includes(k));
    const e = new Error(known ? ERROR_TEXT[known] : setupHint(msg, fn));
    e.code = known || 'unknown';
    e.raw = msg;
    console.warn('[맞춤법 탐정단]', fn, msg);
    throw e;
  }
  return data;
}

// 설치 문제를 알아보기 쉬운 안내로 바꾸기
function setupHint(msg, fn) {
  if (/Could not find the function|PGRST202|does not exist/i.test(msg))
    return `DB 함수(${fn})를 찾지 못했어요. Supabase SQL Editor 에서 01 → 02 → 03 SQL 을 실행했는지 확인해 주세요.`;
  if (/Invalid API key|No API key|apikey|JWT|401|PGRST301/i.test(msg))
    return 'Supabase 키가 맞지 않아요. config.js 의 SUPABASE_KEY 에 publishable key 를 다시 붙여 넣어 주세요.';
  if (/permission denied|42501/i.test(msg))
    return 'DB 함수 권한이 없어요. 02_functions.sql 을 다시 실행해 주세요.';
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(msg))
    return 'Supabase 에 연결하지 못했어요. config.js 의 SUPABASE_URL 이 맞는지, 인터넷이 되는지 확인해 주세요.';
  return '연결에 문제가 생겼어요: ' + msg.trim().slice(0, 120);
}

const ERROR_TEXT = {
  wrong_password: '선생님 비밀번호가 맞지 않아요.',
  not_allowed: '이 방을 바꿀 권한이 없어요.',
  no_room: '그런 방이 없어요. 방 번호를 확인해 주세요.',
  room_closed: '이미 끝난 방이에요.',
  bad_name: '별명은 1~10자로 써 주세요.',
  duplicate_name: '같은 이름이 이미 있어요. 다른 별명을 써 주세요.',
  bad_animal: '동물 친구를 골라 주세요.',
  too_few_words: '낱말을 6개 이상 골라 주세요.',
  bad_duration: '게임 시간을 골라 주세요.',
  not_waiting: '이미 시작했거나 끝난 방이에요.',
  no_players: '학생이 1명 이상 들어와야 시작할 수 있어요.'
};

// ---------- 2. 서버 시계 ----------
// 차이 = S − (t0 + t1) ÷ 2  (요청 보낸 시각 t0, 답 받은 시각 t1, 서버가 적어 준 시각 S)
let clockOffset = 0;      // 서버 시계 − 내 시계 (ms)
let clockBestRtt = Infinity;

async function syncClock(times = 3) {
  for (let i = 0; i < times; i++) {
    try {
      const t0 = Date.now();
      const s = await call('server_time');
      const t1 = Date.now();
      const rtt = t1 - t0;
      // 왕복이 가장 짧았던 측정이 가장 정확함 (오래된 기록은 조금씩 덜 믿기)
      if (rtt <= clockBestRtt * 1.5 || i === 0) {
        clockOffset = new Date(s).getTime() - (t0 + t1) / 2;
        clockBestRtt = Math.min(rtt, clockBestRtt);
      }
    } catch (e) { /* 다음 번에 다시 */ }
  }
}
function serverNow() { return Date.now() + clockOffset; }
function secondsLeft(endsAt) {
  if (!endsAt) return 0;
  return Math.max(0, (new Date(endsAt).getTime() - serverNow()) / 1000);
}
function mmss(sec) {
  const s = Math.ceil(sec);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
setInterval(() => { clockBestRtt *= 1.2; syncClock(1); }, 30000);

// ---------- 3. 실시간 구독 + 자동 대비책 ----------
// 구독(푸시)을 먼저 시도하고, 6초 안에 연결되지 않으면 1.5~2초마다 가져오기(폴링)로 바꿈.
// 놓친 알림이 있을 수 있으니 10초마다 전체를 다시 맞춤.
const watchers = new Set();

function watch({ table, filter, refresh, onEvent }) {
  let mode = 'connecting';
  let pollTimer = null;
  let stopped = false;
  let running = false, again = false;

  // refresh 가 겹쳐 돌지 않게
  const safeRefresh = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try { await refresh(); } catch (e) { /* 다음 번에 */ }
    running = false;
    if (again) { again = false; safeRefresh(); }
  };

  const w = { get mode() { return mode; } };
  watchers.add(w);
  const setMode = m => { mode = m; updateBadge(); };

  const startPolling = () => {
    if (pollTimer || stopped) return;
    setMode('poll');
    const tick = () => {
      safeRefresh();
      pollTimer = setTimeout(tick, 1500 + Math.random() * 500);
    };
    pollTimer = setTimeout(tick, 300);
  };
  const stopPolling = () => { clearTimeout(pollTimer); pollTimer = null; };

  const channel = db.channel(`${table}-${filter}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table, filter }, payload => {
      if (onEvent) onEvent(payload);
      safeRefresh();
    })
    .subscribe(status => {
      if (stopped) return;
      if (status === 'SUBSCRIBED') { stopPolling(); setMode('live'); safeRefresh(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') startPolling();
    });

  const fallback = setTimeout(() => { if (mode !== 'live') startPolling(); }, 6000);
  const full = setInterval(safeRefresh, 10000);
  safeRefresh();

  w.stop = () => {
    stopped = true;
    clearTimeout(fallback); clearInterval(full); stopPolling();
    db.removeChannel(channel);
    watchers.delete(w);
    updateBadge();
  };
  w.refresh = safeRefresh;
  return w;
}

// 화면 오른쪽 아래: 초록 "실시간 연결됨" / 노랑 "자동 새로고침 중"
function updateBadge() {
  let b = document.getElementById('net-badge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'net-badge';
    b.setAttribute('role', 'status');
    document.body.appendChild(b);
  }
  if (watchers.size === 0) { b.hidden = true; return; }
  b.hidden = false;
  const modes = [...watchers].map(w => w.mode);
  if (modes.every(m => m === 'live')) { b.className = 'live'; b.textContent = '● 실시간 연결됨'; }
  else if (modes.includes('poll')) { b.className = 'poll'; b.textContent = '● 자동 새로고침 중'; }
  else { b.className = 'connecting'; b.textContent = '● 연결하는 중…'; }
}

// ---------- 4. 데이터 도우미 ----------
const ANIMALS = [
  { id: 'dog', emoji: '🐶', name: '강아지' },
  { id: 'cat', emoji: '🐱', name: '고양이' },
  { id: 'rabbit', emoji: '🐰', name: '토끼' },
  { id: 'fox', emoji: '🦊', name: '여우' },
  { id: 'panda', emoji: '🐼', name: '판다' },
  { id: 'tiger', emoji: '🐯', name: '호랑이' },
  { id: 'koala', emoji: '🐨', name: '코알라' },
  { id: 'frog', emoji: '🐸', name: '개구리' }
];
const animalEmoji = id => (ANIMALS.find(a => a.id === id) || ANIMALS[0]).emoji;

const CATEGORY = {
  A: '헷갈리는 짝말',
  B: '짧은 말',
  C: '자주 틀리는 낱말',
  D: '소리와 표기가 다른 말'
};

// 순위: 점수 → 맞힌 수 → 먼저 들어온 순서
function rankPlayers(list) {
  return [...list].sort((a, b) =>
    b.score - a.score ||
    b.correct_count - a.correct_count ||
    new Date(a.joined_at) - new Date(b.joined_at));
}

async function fetchRoom(roomId) {
  const { data, error } = await db.from('rooms').select('*').eq('id', roomId).maybeSingle();
  if (error) throw error;
  return data; // 없으면 null
}
async function fetchPlayers(roomId) {
  const { data, error } = await db.from('players')
    .select('id,nickname,animal,score,correct_count,bonus_total,answered,joined_at')
    .eq('room_id', roomId);
  if (error) throw error;
  return data || [];
}

// "가리키다 · 가르치다" 또는 "며칠 (✕ 몇일)"
function wordPairText(w) {
  return (w.category === 'A' || w.category === 'B')
    ? `${w.correct} · ${w.wrong}`
    : `${w.correct} (✕ ${w.wrong})`;
}

// ---------- 5. 화면 도우미 (사용자 글자는 항상 textContent 로) ----------
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return n;
}
const $ = sel => document.querySelector(sel);

// 문장 그리기: ___ → 빈칸 상자, [[말]] → 밑줄
function renderSentence(container, text) {
  container.replaceChildren();
  if (!text) return;
  const parts = String(text).split(/(___|\[\[[^\]]*\]\])/);
  for (const part of parts) {
    if (part === '___') container.appendChild(el('span', { class: 'blank', 'aria-label': '빈칸' }, ' ? '));
    else if (part.startsWith('[[') && part.endsWith(']]')) container.appendChild(el('u', { class: 'mark' }, part.slice(2, -2)));
    else if (part) container.appendChild(document.createTextNode(part));
  }
}

// 화면 전환: <section data-view="이름"> 중 하나만 보이기
function showView(name) {
  document.querySelectorAll('[data-view]').forEach(s => { s.hidden = s.dataset.view !== name; });
  document.body.dataset.current = name;
}

function toast(msg, ms = 2600) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', role: 'alert' });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// 브라우저 저장소 (막혀 있어도 게임은 돌아가게)
const store = {
  get(area, key) {
    try { const v = window[area].getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  },
  set(area, key, value) { try { window[area].setItem(key, JSON.stringify(value)); } catch (e) {} },
  del(area, key) { try { window[area].removeItem(key); } catch (e) {} }
};

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function confettiBurst() {
  if (reduceMotion() || typeof window.confetti !== 'function') return;
  window.confetti({ particleCount: 90, spread: 75, origin: { y: 0.6 },
    colors: ['#e9b422', '#1f2a4d', '#e5604f', '#2fae8c', '#5aa9e6'] });
}

// 설정이 비어 있으면 알려 주기
if (!CONFIG_READY) {
  document.addEventListener('DOMContentLoaded', () =>
    toast('config.js 에 내 Supabase 주소와 키를 먼저 넣어 주세요.', 8000));
}
