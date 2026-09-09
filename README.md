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
