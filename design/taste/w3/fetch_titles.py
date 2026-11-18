#!/usr/bin/env python3
"""Большой список аниме для анкеты вкусов, волна 3: то, чего не было в волне 1. Берёт из Shikimori самые популярные ТВ-тайтлы,
выкидывает уже отмеченные в волне 1, анонсы и продолжения (2nd Season, Part 2, II…), раскладывает по спискам и пишет design/taste/w3/titles.json.

Списки: сначала по жанрам, которые ему ближе (фэнтези и исэкай, романтика, этти и гарем, повседневность и комедия, по ответам волн 1–2),
потом всё остальное по годам. Тайтл попадает в первый подходящий список. id = номер MAL, как в таблице `anime` бота.
Запуск: python -I design/taste/w3/fetch_titles.py  (около минуты: у Shikimori предел ~90 запросов в минуту).
Личного здесь нет: только публичные данные каталога и список уже использованных номеров из волны 1.
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "titles.json"
W1 = HERE.parent / "titles.json"
API = "https://shikimori.io/api/animes"
CACHE = HERE / "titles.cache.json"  # номер -> франшиза (в git не попадает)
UA = "MeidoBot/1.0 (personal reminder bot)"  # как в src/anime/sources.ts: без личных данных
PAUSE = 0.75

# (id, заголовок, [(жанры Shikimori через запятую или "", сезоны фильтра)], сколько взять)
GENRE_LISTS = [
    ("g-fan", "Исэкай и фэнтези (ещё)", [("10", "2012_2026")], 75),
    ("g-rom", "Романтика и школа (ещё)", [("22", "2012_2026")], 75),
    ("g-ecchi", "Этти и гарем (ещё)", [("35", "2010_2026"), ("9", "2010_2026")], 60),
    ("g-sol", "Повседневность и комедия (ещё)", [("36", "2010_2026"), ("4", "2010_2026")], 65),
]
# списки по годам для остального: (id, заголовок, от, до, сколько)
YEAR_LISTS = [
    ("y-2021", "2021–2026: всё остальное", 2021, 2026, 100),
    ("y-2018", "2018–2020: всё остальное", 2018, 2020, 90),
    ("y-2015", "2015–2017: всё остальное", 2015, 2017, 90),
    ("y-2010", "2010–2014: всё остальное", 2010, 2014, 85),
    ("y-2006", "2006–2009: всё остальное", 2006, 2009, 60),
    ("y-old", "До 2006: всё остальное", 1960, 2005, 40),
]
SEQUEL = [
    r"\b(2nd|3rd|[4-9]th)\s+Season\b", r"\bSeason\s*\d+\b", r"\b(Second|Third|Fourth|Fifth)\s+(Season|Part)\b", r"\bPart\s*\d+\b", r"\bThe Final\b",
    r"\b(II|III|IV|V|VI)\s*$", r"\b(II|III|IV)\s*[:\-!]", r"\s[2-9]$", r"\bS[2-9]\b", r"\bFinal Season\b", r"\bNew Season\b", r"\bFollow-up\b",
    r"\b(Zoku|Kai|Ni|San)\b\s*$", r"\bSpecial\b", r"\bRecap\b", r"\bMovie\b",
]
SEQ_RE = [re.compile(p, re.I) for p in SEQUEL]


def get(params: dict) -> list:
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = json.loads(r.read().decode("utf-8"))
            time.sleep(PAUSE)
            return data
        except Exception as e:  # 429, сеть: ждём и повторяем
            print(f"  повтор {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(3 + 3 * attempt)
    raise SystemExit("Shikimori не отвечает: " + url)


def pages(params: dict, n: int) -> list:
    out = []
    for p in range(1, n + 1):
        chunk = get({**params, "kind": "tv", "limit": 50, "page": p, "order": "popularity", "censored": "true"})
        out += chunk
        if len(chunk) < 50:
            break
    return out


def item(a: dict) -> dict:
    on = a.get("aired_on") or ""
    year = int(on[:4]) if len(on) >= 4 and on[:4].isdigit() else None
    return {"id": a["id"], "ru": (a.get("russian") or a.get("name") or "").strip(), "orig": (a.get("name") or "").strip(), "year": year}


FR: dict = {}


def franchise(i: int) -> str:
    """Франшиза тайтла по карточке Shikimori: одна франшиза — один раз, продолжения выкидываем."""
    k = str(i)
    if k not in FR:
        req = urllib.request.Request(f"{API}/{i}", headers={"User-Agent": UA})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    FR[k] = (json.loads(r.read().decode("utf-8")).get("franchise") or f"id{i}")
                time.sleep(PAUSE)
                break
            except Exception as e:
                print(f"  повтор {attempt + 1}: {e}", file=sys.stderr)
                time.sleep(3 + 3 * attempt)
        else:
            FR[k] = f"id{i}"
        if len(FR) % 25 == 0:
            CACHE.write_text(json.dumps(FR), encoding="utf-8")
    return FR[k]


def base(name: str) -> str:
    n = re.sub(r"\s+", " ", name).strip().lower()
    head = re.split(r"[:：]", n)[0].strip()
    n = head if len(head) >= 8 else n
    n = re.sub(r"\b(2nd|3rd|\d+th)?\s*season\b|\bpart\s*\d+\b|\b(ii|iii|iv)\b|\s\d+$", "", n).strip()
    return n


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    global FR
    FR = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    used: set[int] = {i["id"] for l in json.loads(W1.read_text(encoding="utf-8"))["lists"] for i in l["items"]}
    print("франшизы волны 1…")
    frs: set[str] = {franchise(i) for i in sorted(used)}  # их продолжения тоже не берём

    def ok(a: dict) -> bool:
        if a["id"] in used or a.get("status") == "anons" or not (a.get("russian") or a.get("name")):
            return False
        if any(r.search(a.get("name") or "") for r in SEQ_RE):
            return False
        return franchise(a["id"]) not in frs

    def take(src: list, n: int, lo=0, hi=9999) -> list:
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
    for lid, title, parts, n in GENRE_LISTS:
        print("жанры:", lid)
        parts_pool = [pages({"genre": genre, "season": season}, 3) for genre, season in parts]
        # части (жанры) чередуются, внутри каждой порядок по популярности
        merged, seen = [], set()
        for k in range(max(len(x) for x in parts_pool)):
            for x in parts_pool:
                if k < len(x) and x[k]["id"] not in seen:
                    seen.add(x[k]["id"])
                    merged.append(x[k])
        lists.append({"id": lid, "t": title, "items": take(merged, n)})
    print("общий пул по популярности…")
    big = pages({}, 40)
    for lid, title, lo, hi, n in YEAR_LISTS:
        lists.append({"id": lid, "t": title, "items": take(big, n, lo, hi)})
    CACHE.write_text(json.dumps(FR), encoding="utf-8")
    OUT.write_text(json.dumps({"source": "shikimori.io", "fetched": time.strftime("%Y-%m-%d"), "lists": lists}, ensure_ascii=False, indent=1), encoding="utf-8")
    for l in lists:
        print(f"{l['id']}: {len(l['items'])}  {l['t']}")
        print("   " + "; ".join(f"{i['ru'][:34]} ({i['year']})" for i in l["items"][:12]))
    print("Всего:", sum(len(l["items"]) for l in lists))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
