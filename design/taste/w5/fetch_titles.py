#!/usr/bin/env python3
"""Большой список аниме для анкеты вкусов, волна 5: «ещё один забег» по тайтлам, которых не было в волнах 1 и 3.
Берёт из Shikimori следующих по популярности ТВ-сериалы и ONA, выкидывает уже спрошенное (волны 1 и 3, необязательно ещё номера из SQL загрузки отметок),
анонсы, продолжения (2nd Season, Part 2, II…) и целые франшизы, из которых что-то уже было, раскладывает по спискам и пишет design/taste/w5/titles.json.

Списки: сначала жанры, которые ему ближе (романтика, фэнтези и исэкай, этти и гарем, комедия, повседневность, юри, сэйнэн и дзёсэй, горничные),
потом всё остальное по годам, потом детское, в самом конце красные линии и нелюбимое (ужасы, меха, космос, BL), чтобы не мешало.
В ранних списках красные жанры исключены фильтром сайта (`!14,!18,…`), поэтому они попадают только в конец. Тайтл попадает в первый подходящий список.
id = номер MAL, как в таблице `anime` бота. Фильмы не берём (kind только tv и ona).

Запуск: python -X utf8 -I design/taste/w5/fetch_titles.py [--sql D:/_MeidoBot/data/taste/import-anime.sql]
(около 30–40 минут: у Shikimori предел ~90 запросов в минуту; кэш франшиз w5/titles.cache.json ускоряет повторные запуски и в git не попадает;
можно положить в него кэш волны 3 `w3/titles.cache.json`: он уже знает тысячи франшиз).
Личного здесь нет: только публичные данные каталога и номера уже использованных тайтлов.
"""
import datetime
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "titles.json"
USED_PAGES = [HERE.parent / "titles.json", HERE.parent / "w3" / "titles.json"]  # волны 1 и 3: всё, что уже спрашивали
API = "https://shikimori.io/api/animes"
CACHE = HERE / "titles.cache.json"  # номер -> франшиза (в git не попадает)
UA = "MeidoBot/1.0 (personal reminder bot)"  # как в src/anime/sources.ts: без личных данных
PAUSE = 0.75
KINDS = "tv,ona"
TODAY = datetime.date.today().isoformat()

# красные линии и нелюбимое (номера жанров Shikimori): ужасы, меха, космос, яой, сёнен-ай. В ранних списках исключаются, в конце берутся отдельно.
RED = ["14", "18", "29", "33", "28"]
ADULT = ["12", "539"]  # хентай, эротика: не берём никогда
KIDS = "15"
NEG = ",".join("!" + g for g in RED + ADULT + [KIDS])

# (id, заголовок, подпись, [(жанры через запятую, сезоны фильтра)], сколько взять, страниц в пуле на каждую часть)
GENRE_LISTS = [
    ("g-rom", "Романтика и школа (ещё)", "", [("22," + NEG, "2006_2026")], 100, 14),
    ("g-fan", "Фэнтези и исэкай (ещё)", "", [("10," + NEG, "2006_2026")], 100, 14),
    ("g-ecchi", "Этти и гарем (ещё)", "", [("9," + NEG, "2006_2026"), ("35," + NEG, "2006_2026")], 70, 10),
    ("g-com", "Комедия (ещё)", "", [("4," + NEG, "2006_2026")], 80, 30),
    ("g-sol", "Повседневность (ещё)", "", [("36," + NEG, "2006_2026")], 50, 10),
    ("g-yuri", "Юри и девичьи истории", "На сайте это жанры «Юри» и «Сёдзё-ай»: от нежного до откровенного без ужасов.", [("26," + NEG, "2006_2026"), ("34," + NEG, "2006_2026")], 35, 6),
    ("g-sj", "Сэйнэн и дзёсэй", "Взрослые истории: для мужской и женской взрослой аудитории.", [("42," + NEG, "2006_2026"), ("43," + NEG, "2006_2026")], 80, 14),
]
# поиск по слову в названии: горничные и слуги (жанра на сайте нет). (id, заголовок, подпись, [слова поиска], что должно быть в названии, сколько)
SEARCH_LISTS = [
    ("g-maid", "Горничные, дворецкие и слуги", "Ваши любимые типажи: поиск по слову в названии, поэтому список небольшой.", ["maid", "butler", "горничн", "дворецк"],
     r"maids?|butler|горничн|дворецк|слуг", 18),
]
# списки по годам для остального (без красных жанров и детского): (id, заголовок, от, до, сколько, страниц)
YEAR_LISTS = [
    ("y-2021", "2021–2026: всё остальное", 2021, 2026, 100, 25),
    ("y-2018", "2018–2020: всё остальное", 2018, 2020, 75, 20),
    ("y-2015", "2015–2017: всё остальное", 2015, 2017, 65, 20),
    ("y-2010", "2010–2014: всё остальное", 2010, 2014, 65, 25),
    ("y-2006", "2006–2009: всё остальное", 2006, 2009, 35, 15),
    ("y-old", "До 2006: всё остальное", 1960, 2005, 20, 8),
]
# детское и красные линии (берутся в конце): (id, заголовок, подпись, [(жанры, сезоны)], сколько, страниц)
TAIL_LISTS = [
    ("t-kids", "Детское", "Знакомое с детства или по мемам: отметьте быстро.", [("15,!12,!539", "")], 15, 6),
    ("t-horror", "Ужасы (красная линия)", "Вы ужасы не любите: если не смотрели, нажмите «Не смотрел» и идите дальше.", [("14,!12,!539", "")], 40, 8),
    ("t-mecha", "Меха (красная линия)", "Тоже красная линия: быстро отметьте «Не смотрел», если не знакомо.", [("18,!12,!539,!14", "")], 40, 8),
    ("t-space", "Космос и BL (не любите)", "Тоже можно быстро пролистать.", [("29,!12,!539,!14,!18", ""), ("33,!12,!539", ""), ("28,!12,!539", "")], 25, 6),
]
SEQUEL = [
    r"\b(2nd|3rd|[4-9]th)\s+Season\b", r"\bSeason\s*\d+\b", r"\b(Second|Third|Fourth|Fifth)\s+(Season|Part)\b", r"\bPart\s*\d+\b", r"\bThe Final\b",
    r"\b(II|III|IV|V|VI)\s*$", r"\b(II|III|IV)\s*[:\-!]", r"\s[2-9]$", r"\bS[2-9]\b", r"\bFinal Season\b", r"\bNew Season\b", r"\bFollow-up\b",
    r"\b(Zoku|Kai|Ni|San)\b\s*$", r"\bSpecial\b", r"\bRecap\b", r"\bMovie\b",
]
SEQ_RE = [re.compile(p, re.I) for p in SEQUEL]


def get(params: dict) -> list:
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = json.loads(r.read().decode("utf-8"))
            time.sleep(PAUSE)
            return data
        except Exception as e:  # 429, сеть: ждём и повторяем
            print(f"  повтор {attempt + 1}: {e}", file=sys.stderr, flush=True)
            time.sleep(3 + 4 * attempt)
    raise SystemExit("Shikimori не отвечает: " + url)


def stream(params: dict, maxpages: int):
    """Тайтлы по популярности, страница за страницей (следующая страница запрашивается, только когда прочитана предыдущая)."""
    for p in range(1, maxpages + 1):
        chunk = get({**params, "kind": KINDS, "limit": 50, "page": p, "order": "popularity", "censored": "true"})
        yield from chunk
        if len(chunk) < 50:
            return


def interleave(streams: list):
    """Части (жанры) чередуются, внутри каждой порядок по популярности; повторы одного тайтла пропускаются."""
    seen: set = set()
    live = [iter(s) for s in streams]
    while live:
        nxt = []
        for it in live:
            try:
                a = next(it)
            except StopIteration:
                continue
            nxt.append(it)
            if a["id"] not in seen:
                seen.add(a["id"])
                yield a
        live = nxt


def item(a: dict) -> dict:
    on = a.get("aired_on") or ""
    year = int(on[:4]) if len(on) >= 4 and on[:4].isdigit() else None
    ep = a.get("episodes") or 0
    out = {"id": a["id"], "ru": (a.get("russian") or a.get("name") or "").strip(), "orig": (a.get("name") or "").strip(), "year": year}
    if a.get("status") == "released" and ep > 0:
        out["episodes"] = ep
    tag = []
    if a.get("kind") == "ona":
        tag.append("ONA")
    if a.get("status") == "ongoing" and on and on >= (datetime.date.today() - datetime.timedelta(days=450)).isoformat():
        tag.append("идёт сейчас")
    if tag:
        out["tag"] = ", ".join(tag)
    return out


FR: dict = {}


def franchise(i: int) -> str:
    """Франшиза тайтла по карточке Shikimori: одна франшиза — один раз, продолжения выкидываем."""
    k = str(i)
    if k not in FR:
        req = urllib.request.Request(f"{API}/{i}", headers={"User-Agent": UA})
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    FR[k] = (json.loads(r.read().decode("utf-8")).get("franchise") or f"id{i}")
                time.sleep(PAUSE)
                break
            except Exception as e:
                print(f"  повтор {attempt + 1}: {e}", file=sys.stderr, flush=True)
                time.sleep(3 + 4 * attempt)
        else:
            FR[k] = f"id{i}"
        if len(FR) % 25 == 0:
            CACHE.write_text(json.dumps(FR), encoding="utf-8")
    return FR[k]


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    global FR
    args = sys.argv[1:]
    sql = Path(args[args.index("--sql") + 1]) if "--sql" in args else None
    FR = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    used: set[int] = set()
    for page in USED_PAGES:
        used |= {i["id"] for l in json.loads(page.read_text(encoding="utf-8"))["lists"] for i in l["items"]}
    if sql and sql.exists():
        used |= {int(m) for m in re.findall(r"VALUES \((\d+),", sql.read_text(encoding="utf-8"))}
    n_before = len(used)
    print(f"уже спрошено или загружено: {n_before} тайтлов; их франшизы…", flush=True)
    frs: set[str] = {franchise(i) for i in sorted(used)}  # их продолжения тоже не берём

    def ok(a: dict) -> bool:
        on = a.get("aired_on") or ""
        if a["id"] in used or a.get("status") == "anons" or not (a.get("russian") or a.get("name")) or not on or on > TODAY:
            return False
        if a.get("kind") not in ("tv", "ona"):
            return False
        ep = a.get("episodes") or 0
        if a.get("kind") == "ona" and a.get("status") == "released" and ep < 6:
            return False  # короткие ONA-ролики
        if a.get("kind") == "tv" and a.get("status") == "released" and 0 < ep < 4:
            return False
        if any(r.search(a.get("name") or "") for r in SEQ_RE):
            return False
        return franchise(a["id"]) not in frs

    def take(src, n: int, lo=0, hi=9999) -> list:
        out = []
        for a in src:
            it = item(a)
            if not ok(a) or not (lo <= (it["year"] or 0) <= hi):
                continue
            used.add(a["id"])
            frs.add(franchise(a["id"]))
            out.append(it)
            if len(out) >= n:
                break
        return out

    lists = []
    for lid, title, sub, parts, n, mp in GENRE_LISTS:
        print("жанры:", lid, flush=True)
        src = interleave([stream({"genre": genre, "season": season}, mp) for genre, season in parts])
        lists.append({"id": lid, "t": title, "sub": sub, "items": take(src, n)})
        CACHE.write_text(json.dumps(FR), encoding="utf-8")
        print(f"   {len(lists[-1]['items'])}", flush=True)
    for lid, title, sub, words, pat, n in SEARCH_LISTS:
        print("поиск:", lid, flush=True)
        rx = re.compile(pat, re.I)
        src = (a for a in interleave([stream({"search": w}, 3) for w in words]) if rx.search((a.get("name") or "") + " " + (a.get("russian") or "")))
        lists.append({"id": lid, "t": title, "sub": sub, "items": take(src, n)})
        print(f"   {len(lists[-1]['items'])}", flush=True)
    for lid, title, lo, hi, n, mp in YEAR_LISTS:
        print("годы:", lid, flush=True)
        src = stream({"genre": NEG, "season": f"{lo}_{hi}"}, mp)
        lists.append({"id": lid, "t": title, "sub": "", "items": take(src, n, lo, hi)})
        CACHE.write_text(json.dumps(FR), encoding="utf-8")
        print(f"   {len(lists[-1]['items'])}", flush=True)
    for lid, title, sub, parts, n, mp in TAIL_LISTS:
        print("конец:", lid, flush=True)
        src = interleave([stream({"genre": genre, **({"season": season} if season else {})}, mp) for genre, season in parts])
        lists.append({"id": lid, "t": title, "sub": sub, "items": take(src, n)})
        CACHE.write_text(json.dumps(FR), encoding="utf-8")
        print(f"   {len(lists[-1]['items'])}", flush=True)
    CACHE.write_text(json.dumps(FR), encoding="utf-8")
    OUT.write_text(json.dumps({"source": "shikimori.io", "fetched": time.strftime("%Y-%m-%d"), "lists": lists}, ensure_ascii=False, indent=1), encoding="utf-8")
    for l in lists:
        print(f"{l['id']}: {len(l['items'])}  {l['t']}")
        print("   " + "; ".join(f"{i['ru'][:34]} ({i['year']})" for i in l["items"][:12]))
    print("Всего:", sum(len(l["items"]) for l in lists), "; исключено заранее:", n_before)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
