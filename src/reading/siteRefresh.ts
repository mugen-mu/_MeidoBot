// Ночная проверка тайтла со ссылкой на сайт (Senkuro, ReManga, ReNovels, RanobeHub): один запрос на тайтл, число русских глав и томов с сайта.
// Что говорить хозяину по росту числа, решает applyObs (src/reading/refresh.ts): первая цифра — отправная точка, рост — новость, скачок больше 100 — мусор.
import type { Obs } from "./refresh.ts";
import type { Reading } from "./core.ts";
import { siteById } from "./siteIds.ts";
import { readSite } from "./sites.ts";
import type { FetchFn } from "./sources.ts";
import type { Patch } from "./store.ts";

/** Прочитать сайт тайтла. null — сайт не ответил или страница не распозналась (проверка повторится): ничего не меняем. */
export async function readSiteObs(r: Reading, f: FetchFn, now: number): Promise<{ obs: Obs; patch: Patch } | null> {
  const site = siteById(r.site);
  if (!site || !r.site_url || !r.site_key) return null;
  const t = await readSite(site, r.site_url, r.site_key, f, { q: r.site_q, ru: r.title_ru });
  if (!t) return null;
  const patch: Patch = { site_at: now };
  if (t.q && t.q !== r.site_q) patch.site_q = t.q;
  // в «вышло» идёт русский счётчик сайта; общий счётчик (src_*) тоже подтягиваем: по нему считается «прочитал последнюю главу»
  return { obs: { ch: t.ch, vol: t.vol, ruCh: t.ch, ruVol: t.vol }, patch };
}
