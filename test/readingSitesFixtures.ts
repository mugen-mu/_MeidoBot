// Куски настоящих ответов сайтов чтения (проба 2026-11-19, с честным заголовком «MeidoBot (personal, 0.1)»): короткие, описания и картинки вырезаны,
// имена полей и значения — как у сайтов. Нужны, чтобы тесты ловили изменение разметки, а не выдуманную.

// ---------- Senkuro ----------
// Страница тайтла встраивает состояние: window.__SENKURO__=({… graphql:{"хеш":{hasNext:false,data:"<JSON строкой>"}}}).

export const SENKURO_SLUG = "bil-eomeogeul-hwansaeng";

export const senkuroManga = (o: Record<string, unknown> = {}) => ({
  id: "TUFOR0E6NTcyNTIyODgxMjA1MTI5MDc",
  applicationId: "4026531840100",
  malId: 149438,
  muId: "j7x0kkd",
  slug: SENKURO_SLUG,
  originalName: { lang: "KO", content: "Bil-eomeogeul hwansaeng", __typename: "I18nTitle" },
  titles: [
    { lang: "EN", content: "My Blasted Reincarnated Life", __typename: "I18nTitle" },
    { lang: "RU", content: "Чёртова реинкарнация", __typename: "I18nTitle" },
  ],
  alternativeNames: [{ lang: "EN", content: "Damn Reincarnation", __typename: "I18nTitle" }],
  type: "MANHWA",
  status: "ONGOING",
  translitionStatus: "IN_PROGRESS",
  chapters: 82,
  isLicensed: false,
  branches: [{ id: "TUFOR0FfQlJBTkNIOjU3MjUyMjg4MTIwNTc4NDQz", lang: "RU", chapters: 82, translitionStatus: "IN_PROGRESS", manageRestriction: "ALL", primaryBranch: true, completed: false, __typename: "MangaBranch" }],
  __typename: "Manga",
  ...o,
});

/** Страница Senkuro: как у сайта, состояние — внутри <script> строкой JSON в строке JS. */
export const senkuroPage = (manga: Record<string, unknown> = senkuroManga()): string =>
  `<!DOCTYPE html><html lang="ru"><head><title>Читать Чёртова реинкарнация</title><meta property="og:site_name" content="Senkuro"></head><body><div id="app"></div>` +
  `<script>window.__SENKURO__=({state:{},error:void 0,SENKURO_SSR:true,graphql:{"-98309847":{hasNext:false,data:${JSON.stringify(JSON.stringify({ viewerUnreadNotifications: 0 }))}},` +
  `"-4596314336":{hasNext:false,data:${JSON.stringify(JSON.stringify({ manga }))}}}})</script></body></html>`;

// ---------- ReManga и ReNovels (один движок) ----------
// Данные тайтла лежат в странице объектом с "main_name", "dir", "count_chapters"; адрес /manga/<имя>/main.

export const REMANGA_DIR = "%3C17.06.2026%3Ei-want-to-end-the-game-that-i-love";

/** Объект тайтла, как в странице ReManga (описание и картинки вырезаны). `dir` — как кодирует сайт (< вместо «<»). */
export const remangaObject = (o: { id?: number; main?: string; secondary?: string; dir?: string; count?: number } = {}): string =>
  String.raw`{"meta":{"is_subscribed_cards":false,"can_upload_chapters":false,"can_update":false},"id":${o.id ?? 62548},"secondary_name":"${o.secondary ?? "I want to end the game that I love"}",` +
  String.raw`"main_name":"${o.main ?? "Я хочу закончить эту игру любви"}","another_name":"愛してるゲームを終わらせたい / I Want to End the Game of Love.","type":{"id":1,"name":"Манга"},` +
  String.raw`"age_limit":{"id":0,"name":"Для всех"},"status":{"id":2,"name":"Продолжается"},"translate_status":{"id":2,"name":"Продолжается"},` +
  String.raw`"dir":"${o.dir ?? "\\u003c17.06.2026\\u003ei-want-to-end-the-game-that-i-love"}","description":"<p dir=\"ltr\">Друзья детства</p>","issue_year":2022,"avg_rating":"10.0",` +
  String.raw`"total_votes":302,"total_views":1884,"count_rating":4,"count_bookmarks":340,"count_comments":9,"count_cards":0,"count_characters":0,"count_posts":0,"count_chapters":${o.count ?? 48},` +
  String.raw`"count_collections":0,"count_moments":0,"fresh_rating":"10.00","first_chapter":{"id":2821317,"tome":1,"chapter":"1"},"bookmark_type":null,` +
  String.raw`"branches":[{"id":41811,"img":{},"subscribed":false,"total_votes":162,"count_chapters":${o.count ?? 48},"new_chapter_date":null}],"start_reading":{"id":2821317,"tome":1,"chapter":"1"}}`;

/** Страница ReManga/ReNovels: данные тайтла в начале, дальше длинный хвост (чтобы проверить, что бот не читает страницу целиком). */
export const remangaPage = (objects: string[] = [remangaObject()], tail = 0): string =>
  `<!DOCTYPE html><html lang="ru"><head><title>Читать Я хочу закончить эту игру любви — Манга — ReManga</title></head><body><script>window["__RQ_R_5b_"].push({"queries":[` +
  objects.map((o) => `{"state":{"data":{"json":${o}}},"queryKey":["title"]}`).join(",") +
  `]})</script>${"<div>хвост</div>".repeat(tail)}</body></html>`;

// ---------- RanobeHub ----------

/** Начало страницы тайтла: русское название и оригинал рядом (дальше идёт 600 КБ разметки). */
export const rhPage = (ru = "Повелитель", orig = "Overlord"): string =>
  `<!DOCTYPE html><html lang="ru"><head><title>${ru} — RanobeHub</title></head><body><div class="book-cover-copy"><strong>${ru}</strong><small>${orig}</small></div>` +
  `<h1 class="book-title-cyrillic">${ru}</h1><p class="book-original-title">${orig}</p>${"<div>разметка</div>".repeat(60)}</body></html>`;

/** Ответ `/api/search`: книги с томами и главами по-русски (значения Overlord на 2026-11-19). */
export const rhSearchJson = (books: Record<string, unknown>[] = [rhBook()]) => ({ books, entities: {} });
export const rhBook = (o: Record<string, unknown> = {}) => ({
  id: 206,
  slug: "overlord",
  title: "Повелитель",
  originalTitle: "Overlord",
  year: 2010,
  status: "В процессе",
  rating: 8.7,
  views: 1000000,
  chapters: 177,
  volumes: 19,
  updatedAt: "2026-11-17T18:57:22.000Z",
  ...o,
});

// ---------- MangaLib и RanobeLib: только разметка для поисковиков ----------

/** Блок `CreativeWorkSeries` из страницы тайтла (названия и жанры есть, числа глав нет). */
export const ldPage = (o: { name: string; alt: string[]; site: "mangalib" | "ranobelib" }): string =>
  `<!DOCTYPE html><html lang="ru"><head><title>${o.name} читать онлайн</title>` +
  `<script type="application/ld+json" data-seo-server>{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"${o.site === "mangalib" ? "MangaLib" : "RanobeLib"}"}]}</script>` +
  `<script type="application/ld+json" data-seo-server>${JSON.stringify({ "@context": "https://schema.org", "@type": "CreativeWorkSeries", name: o.name, alternateName: o.alt, inLanguage: "ru", genre: ["Драма"], datePublished: "2026" })}</script>` +
  `</head><body></body></html>`;

export const MANGALIB_PAGE = ldPage({ name: "Нулевые пациенты", alt: ["Zero patients"], site: "mangalib" });
export const RANOBELIB_PAGE = ldPage({ name: "Я думал, это история про охотников, а оказалось — про прачечную", alt: ["Heonteomurinjul Aratneunde, Setakmurieotda.", "I Thought It Was a Hunter Story, But It Was Laundry"], site: "ranobelib" });

// ---------- Com-X ----------

/** Что видит не-браузер вместо страницы: проверка на JavaScript (код 404 после перенаправления на /_c). */
export const COMX_CHECK = `<!DOCTYPE html><html><head><meta name="robots" content="noindex,nofollow"><title></title></head><body><div class="x18839"><div class="x36102"></div></div><script> (function(){ if(!window||!navigator||!document){return;} var p = { mode: "modern", caps: { webdriver: navigator.webdriver===true } }; })(); </script><noscript><p>Для доступа к сайту необходимо включить JavaScript.</p></noscript></body></html>`;
