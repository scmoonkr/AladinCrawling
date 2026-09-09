#############################################################
# MYRANKING
#############################################################
# Turnstile 검증을 위해 기본적으로 브라우저 창을 표시합니다.
# 보안 검증 및 검색 결과 이동은 기본 10분 동안 기다립니다.
# 자동 검색이 거절되더라도 브라우저를 닫지 않으므로 열린 창에서 직접 검색하고 검증을 완료하세요.
# 검색 완료 후에도 브라우저가 유지되며, 확인이 끝나면 창을 직접 닫으세요.
# 화면의 기록은 이미지이므로 tesseract.js 숫자 OCR로 time을 읽습니다.
# 보안 검증 쿠키는 .myranking-profile에 저장되어 다음 실행에서도 재사용됩니다.
pnpm myranking -- "문성중 남자 평영 50M"

# 검색 완료 직후 브라우저 자동 종료
pnpm myranking -- "문성중 남자 평영 50M" --auto-close

# 30분 동안 기다리기
pnpm myranking -- "문성중 남자 평영 50M" --timeout=1800

# CI 등에서 브라우저 창 없이 실행 (사이트 보안 정책에 따라 차단될 수 있음)
pnpm myranking -- "문성중 남자 평영 50M" --headless

# 연속 처리 API 서버 (브라우저 1개를 계속 재사용)
npm run myranking:server

# 요청 예시
# http://localhost:3001/api/myranking?q=문성중%20남자%20평영%2050M

#############################################################
# NLCY
#############################################################
# NLCY list
# node src/index.js nlcyCrawl kdc // 000~900
node src/index.js nlcyCrawl 300

# MARC
# node src/index.js nlcyDetailAll limit skip
node src/index.js nlcyDetailAll 10000 0

# 신착도서
# node src/index.js nlcyNew yyyymm
node src/index.js nlcyNew 202606

#############################################################
# 독서로 KDC
#############################################################
node src/index.js read365 <isbn>

#############################################################
# ALADIN
#############################################################
# book list
node src/index.js listCategoryAll 1230 10 

# detail
# limit skip
node src\index.js detailLinkClassAll 100000 0
# crawling deail ISBN
node src\index.js detailByIsbn 9791193904435
# author list
node src/index.js authorList 1 1

# author detail
node src/index.js authorDetail

#############################################################
# KYOBO (도매 가격)
#############################################################
# .env: KYOBO_URL, KYOBO_ID, KYOBO_PASSWORD
# 브라우저로 로그인(프로세스당 1회)한 뒤, 그 세션 쿠키로 검색 API를 직접 호출합니다.
#   POST /bscm/btco/findBksSrchMain.do  { dma_srch: { findName: <isbn> } }
# 응답에는 정가(wncrPrce)와 출고율(byngRate)만 있고, 화면의 출고가는 둘을 곱한 값입니다.
# 상품코드(cmdtCode)가 검색한 ISBN과 일치하는 행만 결과로 인정합니다.
# 조회는 한 건씩 순차로만 보냅니다(동시 실행 없음).
#   동시에 여러 건을 보내면 서버가 "시스템 과부하로 검색이 제한됩니다"(E9999)로
#   검색을 막습니다. 재로그인이나 세션 교체로는 풀리지 않고 한동안 기다려야 합니다.
#   제한이 감지되면 배치를 즉시 중단하고 결과의 stopped 필드에 사유를 남기며,
#   처리하지 못한 항목은 그대로 남아 다음 실행에서 이어서 처리합니다.
# KYOBO_REQUEST_INTERVAL로 요청 간 최소 간격을 조절합니다(기본 400ms).
# 기본은 headless 실행이며, 화면을 보려면 KYOBO_HEADLESS=false 로 실행하세요.
# books에 저장되는 필드:
#   price(정가), wholesale_price(출고가), supply_rate(출고율)
#   kyobo_title, kyobo_found, kyobo_checked_at, kyobo_updated_at
#   * price는 교보 정가로 직접 덮어씁니다.

# ISBN 1건 조회 후 books 저장
node src/index.js kyobo 9788934972464

# books에서 isbn이 있고 아직 조회하지 않은(kyobo_checked_at 없음) 문서 일괄 처리
# node src/index.js kyoboAll <limit> <skip>
node src/index.js kyoboAll 1000 0

# 서버 실행 시 API
# http://localhost:3000/api/kyobo?isbn=9788934972464

# kyobo 조회
# limit skip
node src/index.js kyoboAll 100 0