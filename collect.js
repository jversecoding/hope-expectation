'use strict';

// KOBIS 일별 박스오피스(top20)를 2023-01-01부터 오늘까지 수집해 data/boxoffice-cache.json에 캐시한다.
// 실행: node --env-file=.env collect.js
// 재실행 시 이미 캐시된 날짜는 건너뛰고, 실패했던 날짜만 재시도한다(idempotent).

const fs = require('fs');
const path = require('path');

const KOBIS_API_KEY = process.env.KOBIS_API_KEY || '';
const KOBIS_BASE = 'http://kobis.or.kr/kobisopenapi/webservice/rest';
const CACHE_PATH = path.join(__dirname, 'data', 'boxoffice-cache.json');
const START_DATE = '2023-01-01';
const REQUEST_DELAY_MS = 90;
const MAX_RETRIES = 3;
const CHECKPOINT_EVERY = 20;

if (!KOBIS_API_KEY) {
  console.error('KOBIS_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}${m}${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function loadCache() {
  if (fs.existsSync(CACHE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    } catch (e) {
      console.warn('기존 캐시 파싱 실패, 새로 시작합니다:', e.message);
      return {};
    }
  }
  return {};
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf-8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDailyBoxOffice(targetDt) {
  const qs = new URLSearchParams({
    key: KOBIS_API_KEY,
    targetDt,
    itemPerPage: '20',
  });
  const url = `${KOBIS_BASE}/boxoffice/searchDailyBoxOfficeList.json?${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.faultInfo) {
    throw new Error(`KOBIS fault: ${json.faultInfo.message || JSON.stringify(json.faultInfo)}`);
  }
  const list = json?.boxOfficeResult?.dailyBoxOfficeList;
  if (!Array.isArray(list)) {
    throw new Error('예상치 못한 응답 형식');
  }
  return list;
}

async function main() {
  const end = todayStr();
  const allDates = dateRange(START_DATE, end);
  const cache = loadCache();

  const pending = allDates.filter((d) => !(d in cache));
  console.log(`전체 ${allDates.length}일 중 ${allDates.length - pending.length}일은 이미 캐시됨. ${pending.length}일 수집 시작.`);

  let done = 0;
  let failed = 0;
  let sinceCheckpoint = 0;

  for (const targetDt of pending) {
    let lastErr = null;
    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const list = await fetchDailyBoxOffice(targetDt);
        cache[targetDt] = list;
        success = true;
        break;
      } catch (e) {
        lastErr = e;
        await sleep(REQUEST_DELAY_MS * attempt);
      }
    }
    if (!success) {
      failed++;
      console.warn(`[실패] ${targetDt}: ${lastErr?.message || '알 수 없는 오류'} (다음 실행 시 재시도됨)`);
    } else {
      done++;
    }

    sinceCheckpoint++;
    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      saveCache(cache);
      sinceCheckpoint = 0;
      console.log(`진행: ${done + failed}/${pending.length} (성공 ${done}, 실패 ${failed})`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  saveCache(cache);
  console.log(`완료. 성공 ${done}건, 실패 ${failed}건. 캐시 총 ${Object.keys(cache).length}일치 저장됨 → ${CACHE_PATH}`);
  if (failed > 0) {
    console.log('실패한 날짜는 스크립트를 다시 실행하면 자동으로 재시도됩니다.');
  }
}

main().catch((e) => {
  console.error('치명적 오류:', e);
  process.exit(1);
});
