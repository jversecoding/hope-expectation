# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

KOBIS(영화관입장권통합전산망) 데이터를 근거로 영화 '호프(HOPE)'의 최종 누적 관객수를
worst/base/best 세 시나리오로 예측하는 **로컬 정적 리포트**다. 실시간 대시보드
(`../hope-dashboard`)와는 완전히 분리된 별도 프로젝트이며 코드/폴더를 공유하지 않는다.

- GitHub(퍼블릭): https://github.com/jversecoding/hope-expectation
- Vercel(프로덕션): https://hopeexpectation.vercel.app

## 명령어

```bash
# 1) KOBIS 일별 박스오피스(top20) 수집 — 2023-01-01~오늘, 최초 1회 몇 분 소요
node --env-file=.env collect.js

# 2) 비교군 추출·예측 계산 → data/analysis.json 생성 + index.html에 데이터 내장
node --env-file=.env analyze.js

# 3) 리포트 확인 — index.html 더블클릭 (file://로 바로 열림, 서버 불필요)
```

`collect.js`는 idempotent하다: 이미 캐시된 날짜는 건너뛰고 실패한 날짜만 재시도하므로 언제든
안전하게 재실행할 수 있다. 데이터를 최신화하려면 `collect.js` → `analyze.js` 순서로 재실행하고
`index.html`을 다시 열면 된다(별도 빌드 단계 없음).

배포 갱신은 `git add -A && git commit && git push`(GitHub) + `vercel --prod --yes`(Vercel)로 한다.
정적 사이트라 Vercel 쪽은 환경변수·서버리스 함수 설정이 필요 없다.

## 아키텍처

### 데이터 파이프라인 (3단계, 전부 오프라인 배치)

1. **`collect.js`** — KOBIS `boxoffice/searchDailyBoxOfficeList.json`을 날짜별로 순회 호출해
   `data/boxoffice-cache.json`(gitignore, 재생성 가능)에 원본 캐시. KOBIS 무료 API에는 "특정 영화의
   일자별 시계열" 엔드포인트가 없어서, 톱20 랭킹을 전체 기간 긁어모은 뒤 movieCd로 역추출하는
   방식이다. 이 캐시가 이후 모든 분석의 유일한 데이터 소스다.
2. **`analyze.js`** — 캐시를 읽어:
   - movieCd별로 그룹핑해 누적 500만+ & "흥행 종료"(마지막 관측일로부터 14일 이상 공백,
     `FINISHED_GAP_DAYS`) 한국영화만 비교군으로 추출
   - 각 비교군에 장르(45%)·개봉 스크린 규모(35%)·개봉 시기(20%) 가중치를 매겨 유사도 산정
   - "호프의 현재 경과일(D일) 누적 대비 최종 누적" 배수를 비교군별로 계산, 유사도 가중 배수 분포의
     P25/P50/P75를 worst/base/best로 사용
   - 유사도 상위 비교군들의 정규화(0~1) 흥행 곡선을 가중 평균해 D일 이후 60일까지의 예측 궤적 산출
   - 결과를 `data/analysis.json`에 쓰고, **`index.html` 안의 `<script id="embedded-analysis-data">`
     태그 내용도 정규식으로 직접 치환**한다(`embedDataIntoIndexHtml()`)
3. **`index.html`** — 단일 파일 반응형 리포트(Chart.js). `main()`이 `#embedded-analysis-data`
   태그를 먼저 찾아 파싱하고, 없을 때만 `fetch('data/analysis.json')`으로 폴백한다. 그래서
   `file://`로 더블클릭해도 정상 동작한다(폴백 경로는 서버로 열었을 때만 유효).

### 겪었던 함정 (재발 방지용)

1. **`#embedded-analysis-data` `<script>` 태그는 반드시 `main()`을 호출하는 `<script>`보다
   앞에 있어야 한다.** 브라우저는 `<script>`를 문서 순서대로 실행하므로, 데이터 태그가 뒤에 있으면
   `main()` 실행 시점에 아직 DOM에 없어 `fetch` 폴백으로 새면서 `file://`에서는 CORS로 실패한다.
   `index.html` 구조를 바꿀 때 이 순서를 유지할 것.
2. **트래커별 "마지막 유효 포인트"에 마커/라벨을 찍을 때 배열의 물리적 끝(`data.length-1`)을
   쓰지 말 것.** 궤적 차트의 데이터셋들은 앞/뒤가 `null`로 패딩되어 있어(아래 3번 참고), 실제
   마지막 값은 `endPointRadius()`처럼 "뒤에서부터 널이 아닌 첫 인덱스"를 찾아야 한다.
3. **Chart.js `interaction.mode: 'index'`는 데이터셋 간 배열 인덱스(위치)를 그대로 맞춰서
   비교한다 — x값이 아니다.** 실측 시리즈(호프, D일까지)와 예측 시리즈(D일~60일)의 배열 길이가
   다르면 호버 시 날짜가 어긋나 중간 구간을 건너뛰는 버그가 생긴다(실제 발생했던 버그). 해결책은
   4개 시리즈 모두 day 1~60에 대해 동일한 인덱스를 갖도록 값이 없는 구간을 `null`로 채우는 것
   (`renderTrajectoryChart()`의 `actualPoints`/`bestPoints`/`basePoints`/`worstPoints` 생성부 참고).
   이 차트에 새 시리즈를 추가하거나 구조를 바꿀 때 이 정렬을 깨지 말 것.
4. **KOBIS API에는 특정 영화의 일자별 시계열 엔드포인트가 없다.** 톱20(`itemPerPage=20`) 랭킹을
   전체 기간 긁어서 movieCd로 역추출하는 방식이 유일한 방법이고, 순위권 밖으로 밀려난 날짜는
   구조적으로 결측된다(`analyze.js`의 carry-forward 처리, 리포트의 "데이터 커버리지" 컬럼 참고).
   더 나은 API가 있는지 다시 찾아보려 하지 말 것 — 이미 확인됨.
5. **비교군 "흥행 종료" 판정 기준(`FINISHED_GAP_DAYS = 14`)을 낮추면 최근 개봉작(예: 아직
   장기 흥행 중인 영화)이 최종치 미확정 상태로 비교군에 섞여 들어가 예측이 왜곡된다.** 임의로
   낮추지 말 것 — 늘리는 것(더 보수적으로)은 안전하다.
6. **`data/boxoffice-cache.json`은 gitignore 대상이라 저장소를 새로 clone하면 없다.** 리포트를
   최신화하려면 반드시 `collect.js`부터 다시 돌려야 하며, `data/analysis.json`과
   `index.html` 내장 데이터만으로는 재분석이 불가능하다(원본 일별 데이터가 없으므로).
