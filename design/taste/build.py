#!/usr/bin/env python3
"""Собирает design/taste/page.html (анкета вкусов для публикации артефактом) из template.html, questions.js и titles.json.

Запуск: python -I design/taste/build.py [--wave N] [путь_для_предпросмотра.html]
  1) python -I design/taste/fetch_titles.py   — один раз (или чтобы обновить списки аниме) → titles.json
     (волна 2, манга и ранобэ: python -I design/taste/w2/fetch_titles.py → w2/titles.json)
  2) python -I design/taste/build.py          — сборка и проверки (волна 1); --wave 2 берёт файлы из design/taste/w2/
     (волна 5, большой забег по аниме: python -X utf8 -I design/taste/w5/fetch_titles.py → w5/titles.json; сборка: build.py --wave 5)
Проверки: вычисляется questions.js (node), уникальные id, группы существуют, варианты у one/many (2–18), у text вариантов нет,
у списков уникальные id строк, синтаксис скрипта страницы (node --check), нет «</script» в данных.
Необязательный аргумент — куда положить копию с doctype для просмотра в браузере (в публикации оболочку добавляет платформа).
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ARGS = sys.argv[1:]
WAVE_N = 1
if "--wave" in ARGS:  # python -I design/taste/build.py --wave 2 [предпросмотр.html]
    _i = ARGS.index("--wave")
    WAVE_N = int(ARGS[_i + 1])
    del ARGS[_i:_i + 2]
BASE = HERE if WAVE_N == 1 else HERE / f"w{WAVE_N}"  # волна 1 лежит в design/taste/, остальные — в design/taste/w<N>/
TEMPLATE = HERE / "template.html"
QUESTIONS = BASE / "questions.js"
TITLES = BASE / "titles.json"
OUT = BASE / "page.html"
LIST_PREFIX, LIST_KIND, LIST_GROUP = {1: ("a-", "title", "H"), 2: ("", "read", "L"), 3: ("", "anime2", "A"), 4: ("", "title", "P"), 5: ("", "anime2", "A")}[WAVE_N]
# тайтлы аниме, которых в этой волне быть не должно: уже спрашивали (проверка пересечений при сборке)
EARLIER = {5: [HERE / "titles.json", HERE / "w3" / "titles.json"]}


def clip(s: str, n: int = 90) -> str:
    """Слишком длинные названия (у новых исэкаев бывает по 200 знаков) в строке обрезаются по слову; в titles.json остаются целиком."""
    s = s.strip()
    if len(s) <= n:
        return s
    return s[:n].rsplit(" ", 1)[0].rstrip(" ,:;—-") + "…"


def fail(msg: str) -> None:
    print("ОШИБКА:", msg)
    raise SystemExit(1)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    src = QUESTIONS.read_text(encoding="utf-8")
    probe = ("const vm=require('vm');const fs=require('fs');const src=fs.readFileSync(0,'utf8');const ctx={};vm.createContext(ctx);"
             "vm.runInContext(src+';this.__r={WAVE,GROUPS,Q,LISTS}',ctx);console.log(JSON.stringify(ctx.__r))")
    r = subprocess.run(["node", "-e", probe], input=src, text=True, encoding="utf-8", capture_output=True)
    if r.returncode != 0:
        fail("questions.js не вычислился: " + r.stderr.strip()[:500])
    d = json.loads(r.stdout)
    groups = {g["id"] for g in d["GROUPS"]}

    problems = []
    ids = [q["id"] for q in d["Q"]]
    if len(ids) != len(set(ids)):
        problems.append("повторяются id вопросов")
    for q in d["Q"]:
        if q["g"] not in groups:
            problems.append(f"{q['id']}: нет группы {q['g']}")
        n = len(q["opts"])
        if q["type"] in ("one", "many") and not 2 <= n <= 18:
            problems.append(f"{q['id']}: вариантов {n}")
        if q["type"] == "text" and n:
            problems.append(f"{q['id']}: у текстового вопроса есть варианты")
        if q["type"] not in ("one", "many", "text"):
            problems.append(f"{q['id']}: тип {q['type']}")
        if len(set(q["opts"])) != len(q["opts"]):
            problems.append(f"{q['id']}: повторяются варианты")

    lists = []
    for l in d["LISTS"]:
        lists.append({"id": l["id"], "g": l["g"], "kind": l["kind"], "pos": l.get("pos", "last"), "t": l["t"], "sub": l.get("sub", ""),
                      "items": [{"id": it[0], "t": it[1], "d": it[2] if len(it) > 2 else ""} for it in l["items"]]})
    if not TITLES.exists():
        fail("нет titles.json: сначала python -I design/taste/fetch_titles.py")
    tj = json.loads(TITLES.read_text(encoding="utf-8"))
    for l in tj["lists"]:
        items = [{"id": str(it["id"]), "t": clip(re.sub(r"\s*\(\d{4}\)\s*$", "", it["ru"])),
                  "d": " · ".join(x for x in [clip(it["orig"]) if it["orig"] != it["ru"] else "", str(it["year"] or ""), it.get("tag", "")] if x)} for it in l["items"]]
        lists.append({"id": LIST_PREFIX + l["id"], "g": LIST_GROUP, "kind": LIST_KIND, "pos": "last", "t": l["t"], "sub": l.get("sub", ""), "items": items})
    for page in EARLIER.get(WAVE_N, []):
        old = {str(it["id"]) for l in json.loads(page.read_text(encoding="utf-8"))["lists"] for it in l["items"]}
        for l in lists:
            for it in l["items"]:
                if it["id"] in old and l["kind"] in ("title", "read", "anime2"):
                    problems.append(f"тайтл {it['id']} уже был в {page.relative_to(HERE)}")
    lids = [l["id"] for l in lists]
    if len(lids) != len(set(lids)):
        problems.append("повторяются id списков")
    seen_titles: set[str] = set()
    for l in lists:
        if l["g"] not in groups:
            problems.append(f"список {l['id']}: нет группы {l['g']}")
        ii = [it["id"] for it in l["items"]]
        if len(ii) != len(set(ii)):
            problems.append(f"список {l['id']}: повторяются id строк")
        if l["kind"] in ("title", "read", "anime2"):
            for it in l["items"]:
                if it["id"] in seen_titles:
                    problems.append(f"тайтл {it['id']} в двух списках")
                seen_titles.add(it["id"])
        if any(not it["t"] for it in l["items"]):
            problems.append(f"список {l['id']}: пустое название")

    data = {"wave": d["WAVE"], "groups": d["GROUPS"], "questions": d["Q"], "lists": lists}
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    tpl = TEMPLATE.read_text(encoding="utf-8")
    if tpl.count("/*DATA*/") != 1:
        fail("в шаблоне должно быть ровно одно /*DATA*/")
    page = tpl.replace("/*DATA*/", blob)
    if d["WAVE"].get("pageTitle"):
        page = page.replace("<title>Анкета вкусов</title>", "<title>" + d["WAVE"]["pageTitle"] + "</title>", 1)
    OUT.write_text(page, encoding="utf-8")

    scripts = re.findall(r"<script>(.*?)</script>", page, re.S)
    if len(scripts) != 2:
        problems.append(f"скриптов {len(scripts)}, ожидалось 2")
    for i, s in enumerate(scripts):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(s)
        c = subprocess.run(["node", "--check", f.name], capture_output=True, text=True, encoding="utf-8")
        Path(f.name).unlink(missing_ok=True)
        if c.returncode != 0:
            problems.append(f"синтаксис скрипта {i + 1}: {c.stderr.strip()[:300]}")

    nq = len(d["Q"]); nl = sum(len(l["items"]) for l in lists)
    print(f"Вопросов: {nq}; списков: {len(lists)}; строк в списках: {nl} (тайтлов аниме: {len(seen_titles)}); страница: {len(page) // 1024} КБ")
    if problems:
        print("ПРОБЛЕМЫ:")
        for p in problems:
            print(" -", p)
        return 1
    if ARGS:
        Path(ARGS[0]).write_text('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + page + "</body></html>", encoding="utf-8")
        print("Копия для просмотра:", ARGS[0])
    print("Проверки пройдены.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
