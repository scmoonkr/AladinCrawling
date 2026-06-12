import { chromium } from "playwright";

function parseAuthors(authorText = "") {
  return String(authorText)
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const match = value.match(/^(.+?)\s*(글|그림|옮김|지음|저|편|엮음|감수)$/);

      if (!match) {
        return {
          name: value,
          role: ""
        };
      }

      return {
        name: match[1].trim(),
        role: match[2].trim()
      };
    });
}

function parseCallNbr(callNbr = "") {
  const parts = String(callNbr)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length >= 3) {
    return {
      prefix: parts[0],
      class_no: parts[1],
      author_no: parts.slice(2).join(" ")
    };
  }

  if (parts.length === 2) {
    return {
      prefix: "",
      class_no: parts[0],
      author_no: parts[1]
    };
  }

  return {
    prefix: "",
    class_no: "",
    author_no: ""
  };
}

function parseRead365Text(text, isbn = "") {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

  const regex = /자세히보기\s+단행본\s+(.*?)\s+저자:\s+(.*?)\s+출판사:\s+(.*?)\s+출판년도:\s+(\d{4})\s+소장학교:\s+(.*?)\s+청구기호:\s+(.*?)\s+소장처:\s+(.*?)\s+등록번호:\s+([0-9]+)/g;
  const results = [];

  for (const match of normalized.matchAll(regex)) {
    const [, title, authorText, publisher, pubYear, school, callNbr, location, regNo] = match;
    const callInfo = parseCallNbr(callNbr);

    results.push({
      isbn,
      title: title.trim(),
      authors: parseAuthors(authorText),
      publisher: publisher.trim(),
      pub_year: Number(pubYear),
      call_nbr: callNbr.trim(),
      prefix: callInfo.prefix,
      class_no: callInfo.class_no,
      author_no: callInfo.author_no,
      school: school.trim(),
      location: location.trim(),
      reg_no: regNo.trim()
    });
  }

  return results;
}

function buildCallNumberStats(results) {
  return Object.values(
    results.reduce((accumulator, item) => {
      const key = item.class_no || item.call_nbr;

      if (!key) {
        return accumulator;
      }

      if (!accumulator[key]) {
        accumulator[key] = {
          call_nbr: item.call_nbr,
          prefix: item.prefix,
          class_no: item.class_no,
          author_no: item.author_no,
          count: 0
        };
      }

      accumulator[key].count += 1;
      return accumulator;
    }, {})
  ).sort((left, right) => right.count - left.count);
}

export async function fetchCallNumberByIsbn(isbn) {
  const normalizedIsbn = String(isbn ?? "").trim();

  if (!normalizedIsbn) {
    throw new Error("isbn is required.");
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    const url = `https://read365.edunet.net/SchoolSearchResult?isbn=${encodeURIComponent(normalizedIsbn)}`;

    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60000
    });

    const text = await page.locator("body").innerText();
    const results = parseRead365Text(text, normalizedIsbn);

    if (results.length === 0) {
      throw new Error(`No Read365 results found for isbn ${normalizedIsbn}.`);
    }

    const callNbrStats = buildCallNumberStats(results);
    const first = results[0];

    return {
      isbn: first.isbn,
      title: first.title,
      authors: first.authors,
      publisher: first.publisher,
      class_no: callNbrStats.map((item) => item.class_no).filter(Boolean)
    };
  } finally {
    await browser.close();
  }
}
