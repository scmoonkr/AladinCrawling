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
# ALADIN
#############################################################
# author list
node src/index.js listCategoryAll 1230 10 

# detail
node src\index.js detailLinkClassAll 2551

# author list
node src/index.js authorList 1 1

# author detail
node src/index.js authorDetail
