// Сайты чтения, на которых хозяин читает по-русски (разведка 2026-11-19 — docs/RECON-READING-SITES.md): чистые данные без сети и базы.
// counts: true — страница тайтла открыта для программ, число глав бот читает сам; false — «ручной режим»: сайт закрыт защитой от программ
// или не отдаёт числа, бот хранит ссылку, подставляет её в сообщения и честно говорит, что глав там не видит.
import type { ReadingSourceId } from "../sources.ts";

export type SiteId = "senkuro" | "remanga" | "renovels" | "ranobehub" | "mangalib" | "ranobelib" | "comx";

export interface SiteDef {
  id: SiteId;
  /** как называем сайт в сообщениях */
  name: string;
  /** домены (без «www.») */
  hosts: string[];
  counts: boolean;
  /** строка «Паспорта источников» (экран «Состояние»); только у сайтов с чтением */
  source: ReadingSourceId | null;
  /** почему сайт в ручном режиме (простыми словами, для ответа хозяину) */
  why: string | null;
}

export const SITES: Record<SiteId, SiteDef> = {
  senkuro: { id: "senkuro", name: "Senkuro", hosts: ["senkuro.com"], counts: true, source: "rd_senkuro", why: null },
  remanga: { id: "remanga", name: "ReManga", hosts: ["remanga.org"], counts: true, source: "rd_remanga", why: null },
  renovels: { id: "renovels", name: "ReNovels", hosts: ["renovels.org"], counts: true, source: "rd_renovels", why: null },
  ranobehub: { id: "ranobehub", name: "RanobeHub", hosts: ["ranobehub.org"], counts: true, source: "rd_ranobehub", why: null },
  mangalib: { id: "mangalib", name: "MangaLib", hosts: ["mangalib.me"], counts: false, source: null, why: "сайт закрывает список глав от программ" },
  ranobelib: { id: "ranobelib", name: "RanobeLib", hosts: ["ranobelib.me"], counts: false, source: null, why: "сайт закрывает список глав от программ" },
  comx: { id: "comx", name: "Com-X", hosts: ["com-x.life"], counts: false, source: null, why: "сайт проверяет, что к нему пришёл человек в браузере" },
};

const ALL = Object.values(SITES);

/** Сайт по id из базы; null — ссылки нет или id незнакомый. */
export const siteById = (id: string | null | undefined): SiteDef | null => (id && id in SITES ? SITES[id as SiteId] : null);

/** Сайт по домену из ссылки. */
export function siteByHost(host: string): SiteDef | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  return ALL.find((s) => s.hosts.includes(h)) ?? null;
}

/** Домены всех сайтов (для разбора фраз). */
export const SITE_HOSTS: string[] = ALL.flatMap((s) => s.hosts);

/** Число глав у этого тайтла считает сам бот по сайту (а не только хранит ссылку). */
export const siteCounts = (id: string | null | undefined): boolean => !!siteById(id)?.counts;
