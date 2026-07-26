'use strict';

// data/boxoffice-cache.json을 분석해 비교군, 배수 분포, 정규화 곡선, 예측치를 계산하고
// data/analysis.json을 생성한다. 동시에 index.html에도 같은 데이터를 내장해
// 정적 서버 없이 file://로 더블클릭해도 열리도록 한다.
// 실행: node --env-file=.env analyze.js

const fs = require('fs');
const path = require('path');

const KOBIS_API_KEY = process.env.KOBIS_API_KEY || '';
const KOBIS_BASE = 'http://kobis.or.kr/kobisopenapi/webservice/rest';
const CACHE_PATH = path.join(__dirname, 'data', 'boxoffice-cache.json');
const OUTPUT_PATH = path.join(__dirname, 'data', 'analysis.json');
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

const MOVIE_NAME = '호프';
const DIRECTOR_NAME = '나홍진';
const HOPE_GENRES = ['SF', '스릴러', '액션'];
const MIN_FINAL_AUDIENCE = 5_000_000;
const FINISHED_GAP_DAYS = 14; // 마지막 관측 후 이만큼 지나면 흥행 종료(최종치 확정)로 간주
const CURVE_MAX_DAY = 60;
const TOP_N_FOR_CURVES = 10;
const REQUEST_DELAY_MS = 100;

if (!KOBIS_API_KEY) {
  console.error('KOBIS_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normDate(s) {
  const digits = String(s).replace(/-/g, '');
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function parseDate(isoDash) {
  return new Date(`${isoDash}T00:00:00`);
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(isoDash, n) {
  const d = parseDate(isoDash);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function diffDays(aIso, bIso) {
  return Math.round((parseDate(aIso) - parseDate(bIso)) / 86400000);
}

async function kobisGet(endpoint, params) {
  const qs = new URLSearchParams({ key: KOBIS_API_KEY, ...params });
  const res = await fetch(`${KOBIS_BASE}/${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.faultInfo) throw new Error(`KOBIS fault: ${json.faultInfo.message || JSON.stringify(json.faultInfo)}`);
  return json;
}

async function resolveHopeMovieCd() {
  const json = await kobisGet('movie/searchMovieList.json', {
    movieNm: MOVIE_NAME,
    openStartDt: '2026',
    openEndDt: '2026',
  });
  const list = json?.movieListResult?.movieList || [];
  const match = list.find((m) => (m.directors || []).some((d) => d.peopleNm === DIRECTOR_NAME));
  if (!match) throw new Error('호프 movieCd를 찾지 못했습니다.');
  return match.movieCd;
}

async function fetchMovieInfo(movieCd) {
  const json = await kobisGet('movie/searchMovieInfo.json', { movieCd });
  return json?.movieInfoResult?.movieInfo || null;
}

function loadCache() {
  return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
}

// movieCd -> { movieCd, movieNm, openDt(iso), byDate: Map(iso -> record) }
function buildMovieIndex(cache) {
  const index = new Map();
  const dates = Object.keys(cache).sort();
  for (const dt of dates) {
    const isoDate = normDate(dt);
    for (const rec of cache[dt]) {
      let entry = index.get(rec.movieCd);
      if (!entry) {
        entry = {
          movieCd: rec.movieCd,
          movieNm: rec.movieNm,
          openDt: normDate(rec.openDt),
          byDate: new Map(),
        };
        index.set(rec.movieCd, entry);
      }
      entry.byDate.set(isoDate, {
        audiCnt: Number(rec.audiCnt),
        audiAcc: Number(rec.audiAcc),
        scrnCnt: Number(rec.scrnCnt),
        showCnt: Number(rec.showCnt),
        salesAcc: Number(rec.salesAcc),
      });
    }
  }
  return index;
}

function sortedDates(entry) {
  return [...entry.byDate.keys()].sort();
}

function maxAudiAcc(entry) {
  let max = 0;
  for (const v of entry.byDate.values()) if (v.audiAcc > max) max = v.audiAcc;
  return max;
}

function isFinished(entry, todayIso) {
  const dates = sortedDates(entry);
  if (dates.length === 0) return false;
  const last = dates[dates.length - 1];
  return diffDays(todayIso, last) >= FINISHED_GAP_DAYS;
}

function seasonScore(openDtIso) {
  const month = Number(openDtIso.slice(5, 7));
  // 여름 성수기(7월) 중심, 6/8월은 다음으로, 그 외는 거리에 따라 감소
  const table = { 1: 0.1, 2: 0.15, 3: 0.2, 4: 0.25, 5: 0.4, 6: 0.75, 7: 1.0, 8: 0.75, 9: 0.35, 10: 0.25, 11: 0.2, 12: 0.3 };
  return table[month] ?? 0.2;
}

function genreScore(genreNms) {
  if (!genreNms || genreNms.length === 0) return 0;
  const set = new Set(genreNms);
  const matched = HOPE_GENRES.filter((g) => set.has(g)).length;
  return matched / HOPE_GENRES.length;
}

function scaleScore(candidateScrn, hopeScrn) {
  if (!candidateScrn || !hopeScrn) return 0.3;
  const ratio = Math.min(candidateScrn, hopeScrn) / Math.max(candidateScrn, hopeScrn);
  return ratio;
}

function weightedPercentile(items, percentile) {
  // items: [{value, weight}], percentile: 0~100
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((s, it) => s + it.weight, 0);
  if (totalWeight === 0) return null;
  const target = (percentile / 100) * totalWeight;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const prevCum = cum;
    cum += sorted[i].weight;
    if (cum >= target) {
      if (i === 0) return sorted[i].value;
      const prevVal = sorted[i - 1].value;
      const span = cum - prevCum;
      const frac = span > 0 ? (target - prevCum) / span : 0;
      return prevVal + (sorted[i].value - prevVal) * frac;
    }
  }
  return sorted[sorted.length - 1].value;
}

function ratioSeriesForEntry(entry, finalAudience, maxDay) {
  const openDt = entry.openDt;
  const series = [];
  let lastRatio = null;
  for (let day = 1; day <= maxDay; day++) {
    const iso = addDays(openDt, day - 1);
    const rec = entry.byDate.get(iso);
    if (rec) {
      lastRatio = rec.audiAcc / finalAudience;
    }
    series.push(lastRatio); // 관측 전이면 null, 이후엔 마지막 관측치를 이월(carry-forward)
  }
  return series;
}

async function main() {
  console.log('캐시 로드 중...');
  const cache = loadCache();
  const cachedDates = Object.keys(cache).sort();
  const todayIso = normDate(cachedDates[cachedDates.length - 1]);
  console.log(`캐시 범위: ${normDate(cachedDates[0])} ~ ${todayIso} (${cachedDates.length}일)`);

  const index = buildMovieIndex(cache);
  console.log(`고유 영화 수: ${index.size}`);

  console.log('호프 movieCd 확인 중...');
  const hopeMovieCd = await resolveHopeMovieCd();
  const hopeEntry = index.get(hopeMovieCd);
  if (!hopeEntry) throw new Error('캐시에서 호프 데이터를 찾을 수 없습니다.');

  const hopeDates = sortedDates(hopeEntry);
  const hopeOpenDt = hopeEntry.openDt;
  const hopeLastDate = hopeDates[hopeDates.length - 1];
  const anchorDay = diffDays(hopeLastDate, hopeOpenDt) + 1;
  const anchorAudiAcc = hopeEntry.byDate.get(hopeLastDate).audiAcc;
  const hopeOpenRec = hopeEntry.byDate.get(hopeOpenDt);
  const hopeOpenScrnCnt = hopeOpenRec ? hopeOpenRec.scrnCnt : null;

  console.log(`호프 개봉일 ${hopeOpenDt}, 앵커일 D=${anchorDay} (${hopeLastDate}), 누적관객 ${anchorAudiAcc.toLocaleString()}명`);

  const hopeDailySeries = [];
  for (let day = 1; day <= anchorDay; day++) {
    const iso = addDays(hopeOpenDt, day - 1);
    const rec = hopeEntry.byDate.get(iso);
    hopeDailySeries.push({
      day,
      date: iso,
      audiCnt: rec ? rec.audiCnt : null,
      audiAcc: rec ? rec.audiAcc : null,
    });
  }

  // 1) 500만+ 후보 추출 (흥행 종료된 영화만, 호프 자신 제외)
  const candidates = [];
  for (const entry of index.values()) {
    if (entry.movieCd === hopeMovieCd) continue;
    const final = maxAudiAcc(entry);
    if (final < MIN_FINAL_AUDIENCE) continue;
    if (!isFinished(entry, todayIso)) continue;
    const openIso = entry.openDt;
    if (openIso < '2023-01-01' || openIso > todayIso) continue;
    candidates.push({ entry, finalAudience: final });
  }
  console.log(`500만+ 흥행종료 후보 (국적 확인 전): ${candidates.length}편`);

  // 2) 국적/장르 확인 (KOBIS movieInfo 호출)
  const comparableMovies = [];
  let i = 0;
  for (const { entry, finalAudience } of candidates) {
    i++;
    let info = null;
    try {
      info = await fetchMovieInfo(entry.movieCd);
    } catch (e) {
      console.warn(`  [${i}/${candidates.length}] ${entry.movieNm} movieInfo 조회 실패: ${e.message}`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }
    await sleep(REQUEST_DELAY_MS);

    const nations = (info?.nations || []).map((n) => n.nationNm);
    const isKorean = nations.includes('한국');
    if (!isKorean) continue;

    const genres = (info?.genres || []).map((g) => g.genreNm);
    const openRec = entry.byDate.get(entry.openDt);
    const openScrnCnt = openRec ? openRec.scrnCnt : null;

    const gScore = genreScore(genres);
    const sScore = scaleScore(openScrnCnt, hopeOpenScrnCnt);
    const seScore = seasonScore(entry.openDt);
    const similarityWeight = 0.45 * gScore + 0.35 * sScore + 0.2 * seScore;

    const anchorIso = addDays(entry.openDt, anchorDay - 1);
    const anchorRec = entry.byDate.get(anchorIso);
    const audiAccAtAnchor = anchorRec ? anchorRec.audiAcc : null;
    const multipleAtAnchorDay = audiAccAtAnchor ? finalAudience / audiAccAtAnchor : null;

    const obsDates = sortedDates(entry);
    const observedDays = obsDates.length;
    // 시사회 등으로 공식 개봉일 이전부터 차트에 등장하는 경우가 있어, 실제 관측 시작일과
    // 개봉일 중 더 이른 날짜를 커버리지 계산의 시작점으로 사용한다(100% 초과 방지).
    const coverageStart = obsDates[0] < entry.openDt ? obsDates[0] : entry.openDt;
    const elapsedDays = diffDays(obsDates[obsDates.length - 1], coverageStart) + 1;
    const coverage = elapsedDays > 0 ? Math.min(1, observedDays / elapsedDays) : 0;

    comparableMovies.push({
      movieNm: entry.movieNm,
      movieCd: entry.movieCd,
      openDt: entry.openDt,
      genres,
      finalAudience,
      similarityWeight: Number(similarityWeight.toFixed(4)),
      multipleAtAnchorDay: multipleAtAnchorDay ? Number(multipleAtAnchorDay.toFixed(4)) : null,
      coverage: Number(coverage.toFixed(3)),
    });

    console.log(`  [${i}/${candidates.length}] ${entry.movieNm} — 최종 ${finalAudience.toLocaleString()}명, 가중치 ${similarityWeight.toFixed(3)}, 배수 ${multipleAtAnchorDay ? multipleAtAnchorDay.toFixed(2) : 'N/A'}`);
  }

  console.log(`최종 비교군(한국영화): ${comparableMovies.length}편`);

  // 3) 가중 배수 분포 → worst/base/best
  const multipleSamples = comparableMovies
    .filter((m) => m.multipleAtAnchorDay != null && m.similarityWeight > 0)
    .map((m) => ({ value: m.multipleAtAnchorDay, weight: m.similarityWeight }));

  if (multipleSamples.length === 0) {
    throw new Error('배수를 계산할 수 있는 비교군이 없습니다. FINISHED_GAP_DAYS나 앵커일 설정을 확인하세요.');
  }

  const pWorst = weightedPercentile(multipleSamples, 25);
  const pBase = weightedPercentile(multipleSamples, 50);
  const pBest = weightedPercentile(multipleSamples, 75);
  const p10 = weightedPercentile(multipleSamples, 10);
  const p90 = weightedPercentile(multipleSamples, 90);

  const prediction = {
    worst: { multiple: Number(pWorst.toFixed(4)), finalAudience: Math.round(anchorAudiAcc * pWorst) },
    base: { multiple: Number(pBase.toFixed(4)), finalAudience: Math.round(anchorAudiAcc * pBase) },
    best: { multiple: Number(pBest.toFixed(4)), finalAudience: Math.round(anchorAudiAcc * pBest) },
    p10: { multiple: Number(p10.toFixed(4)), finalAudience: Math.round(anchorAudiAcc * p10) },
    p90: { multiple: Number(p90.toFixed(4)), finalAudience: Math.round(anchorAudiAcc * p90) },
  };

  console.log(`예측: worst=${prediction.worst.finalAudience.toLocaleString()} base=${prediction.base.finalAudience.toLocaleString()} best=${prediction.best.finalAudience.toLocaleString()}`);

  // 4) 정규화 곡선 (유사도 상위 N개)
  const topForCurves = [...comparableMovies]
    .filter((m) => m.similarityWeight > 0)
    .sort((a, b) => b.similarityWeight - a.similarityWeight)
    .slice(0, TOP_N_FOR_CURVES);

  const normalizedCurves = topForCurves.map((m) => {
    const entry = index.get(m.movieCd);
    const series = ratioSeriesForEntry(entry, m.finalAudience, CURVE_MAX_DAY);
    return {
      movieNm: m.movieNm,
      similarityWeight: m.similarityWeight,
      curve: series.map((ratio, idx) => ({ day: idx + 1, ratio: ratio == null ? null : Number(ratio.toFixed(4)) })),
    };
  });

  // 평균(가중) 정규화 곡선
  const avgCurve = [];
  for (let day = 1; day <= CURVE_MAX_DAY; day++) {
    let wSum = 0;
    let vSum = 0;
    for (const c of normalizedCurves) {
      const point = c.curve[day - 1];
      if (point && point.ratio != null) {
        vSum += point.ratio * c.similarityWeight;
        wSum += c.similarityWeight;
      }
    }
    avgCurve.push(wSum > 0 ? vSum / wSum : null);
  }

  // 5) 예측 궤적 (D+1 ~ 60일차), 앵커에서의 실제값과 연속되도록 shape 함수로 보정
  const avgAtAnchor = avgCurve[anchorDay - 1];
  const avgAt60 = avgCurve[CURVE_MAX_DAY - 1];
  const denom = avgAtAnchor != null && avgAt60 != null ? avgAt60 - avgAtAnchor : null;

  function shapeAt(day) {
    if (denom == null || denom <= 0) return 1;
    const v = avgCurve[day - 1];
    if (v == null) return 1;
    const raw = (v - avgAtAnchor) / denom;
    return Math.max(0, Math.min(1, raw));
  }

  const projectedTrajectory = [];
  for (let day = anchorDay + 1; day <= CURVE_MAX_DAY; day++) {
    const s = shapeAt(day);
    projectedTrajectory.push({
      day,
      date: addDays(hopeOpenDt, day - 1),
      worst: Math.round(anchorAudiAcc + (prediction.worst.finalAudience - anchorAudiAcc) * s),
      base: Math.round(anchorAudiAcc + (prediction.base.finalAudience - anchorAudiAcc) * s),
      best: Math.round(anchorAudiAcc + (prediction.best.finalAudience - anchorAudiAcc) * s),
    });
  }

  const analysis = {
    generatedAt: new Date().toISOString(),
    dataAsOf: todayIso,
    hope: {
      movieCd: hopeMovieCd,
      openDate: hopeOpenDt,
      anchorDay,
      anchorDate: hopeLastDate,
      anchorAudiAcc,
      dailySeries: hopeDailySeries,
    },
    prediction,
    comparableMovies: comparableMovies.sort((a, b) => b.similarityWeight - a.similarityWeight),
    normalizedCurves,
    projectedTrajectory,
    methodology: {
      minFinalAudience: MIN_FINAL_AUDIENCE,
      finishedGapDays: FINISHED_GAP_DAYS,
      curveMaxDay: CURVE_MAX_DAY,
      weights: { genre: 0.45, scale: 0.35, season: 0.2 },
      note: 'KOBIS 일별 박스오피스(top20)만 관측 가능하므로, 순위권 밖으로 밀려난 구간은 결측되어 마지막 관측치를 이월(carry-forward)했다. 배수는 각 비교군의 개봉 후 D일차 누적관객수 대비 최종 누적관객수 비율이며, 유사도 가중 백분위(25/50/75)로 worst/base/best를 산출했다.',
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(analysis, null, 2), 'utf-8');
  console.log(`분석 완료 → ${OUTPUT_PATH}`);

  embedDataIntoIndexHtml(analysis);
}

function embedDataIntoIndexHtml(analysis) {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.warn('index.html이 없어 데이터 내장을 건너뜁니다.');
    return;
  }
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
  const marker = /(<script id="embedded-analysis-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
  if (!marker.test(html)) {
    console.warn('index.html에서 embedded-analysis-data 스크립트 태그를 찾지 못해 데이터 내장을 건너뜁니다.');
    return;
  }
  const jsonForEmbed = JSON.stringify(analysis).replace(/</g, '\\u003c'); // </script> 조기 종료 방지
  const updated = html.replace(marker, `$1${jsonForEmbed}$3`);
  fs.writeFileSync(INDEX_HTML_PATH, updated, 'utf-8');
  console.log(`index.html에 분석 데이터 내장 완료 → ${INDEX_HTML_PATH} (서버 없이 더블클릭으로 열 수 있음)`);
}

main().catch((e) => {
  console.error('치명적 오류:', e);
  process.exit(1);
});
