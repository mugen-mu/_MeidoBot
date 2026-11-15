#!/usr/bin/env python3
"""Собирает design/retro/page.html (страница «Ретроспектива Meido» для claude.ai) из шаблона design/template.html.

Данные — data1.js … data4.js (группы и вопросы, склеиваются по порядку). Остальное (стили, сохранение ответов в базу страницы)
берётся из шаблона. Запуск: python design/retro/build.py. Проверки: синтаксис скриптов (node), уникальные id,
2–5 вариантов (у выбора нескольких до 6), рекомендованный первым, число вопросов 150–200.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # D:\_MeidoBot
TEMPLATE = ROOT / "design" / "template.html"
OUT = HERE / "page.html"
PARTS = ["data1.js", "data2.js", "data3.js", "data4.js"]


def sub1(text: str, pattern: str, repl: str, flags: int = 0) -> str:
    new, n = re.subn(pattern, lambda m: repl, text, count=1, flags=flags)
    if n != 1:
        raise SystemExit(f"Не нашёл в шаблоне: {pattern[:60]}")
    return new


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    page = TEMPLATE.read_text(encoding="utf-8")
    data = "\n".join((HERE / p).read_text(encoding="utf-8") for p in PARTS)

    page = sub1(page, r"<title>.*?</title>", "<title>Ретроспектива Meido</title>")
    page = sub1(page, r"<h1>Вопросы к NEXT-STEPS</h1>", "<h1>Ретроспектива Meido</h1>")
    page = page.replace("в NEXT-STEPS пометим отказ", "пометим отказ")
    page = sub1(page, r"<details class=\"more\">.*</details>\s*(?=</div>\s*<div id=\"toast\")", "", re.S)
    # первый блок <script> — данные
    m = re.search(r"<script>(.*?)</script>", page, re.S)
    page = page[: m.start(1)] + "\n" + data + "\n" + page[m.end(1):]
    page = page.replace('"nsq-answers"', '"retro-answers"')
    sub_text = "Ретроспектива Discord-бота Meido, 8 ноября 2026: что сделали, что упростить, чего не хватает. Всё в пределах бесплатных лимитов Cloudflare. Отвечайте кнопками и комментариями, потом напишите в чате «ответил»."
    page = sub1(page, r"\$\(\"sub\"\)\.textContent = `[^`]*`;", '$("sub").textContent = ' + json.dumps(sub_text, ensure_ascii=False) + ";")
    page = page.replace('q.proj || "OnePassQA"', '"Meido"')
    OUT.write_text(page, encoding="utf-8")

    # --- проверки ---
    problems = []
    probe = (
        "const vm=require('vm');const fs=require('fs');"
        "const src=fs.readFileSync(0,'utf8');const ctx={};vm.createContext(ctx);"
        "vm.runInContext(src+';this.__r={Q,GROUPS}',ctx);"
        "console.log(JSON.stringify({Q:ctx.__r.Q,GROUPS:ctx.__r.GROUPS}))"
    )
    r = subprocess.run(["node", "-e", probe], input=data, text=True, encoding="utf-8", capture_output=True)
    if r.returncode != 0:
        print("Не вычислилась data:", r.stderr.strip()[:400])
        return 1
    obj = json.loads(r.stdout)
    Q, G = obj["Q"], {g["id"] for g in obj["GROUPS"]}
    ids = [q["id"] for q in Q]
    if len(ids) != len(set(ids)):
        problems.append("повторяются id вопросов")
    for q in Q:
        n = len(q["opts"])
        if not 2 <= n <= (6 if q["multi"] else 5):
            problems.append(f"{q['id']}: вариантов {n}")
        if not q["opts"][0]["rec"]:
            problems.append(f"{q['id']}: рекомендованный не первый")
        flags = [x["rec"] for x in q["opts"]]
        if flags != sorted(flags, reverse=True):
            problems.append(f"{q['id']}: рекомендованные идут не подряд с начала")
        if q["g"] not in G:
            problems.append(f"{q['id']}: нет такой группы")
        if "`" in q["title"] or len(q["title"]) > 150:
            problems.append(f"{q['id']}: заголовок слишком длинный ({len(q['title'])})")
    for g in sorted(G):
        print(f"  группа {g}: {sum(1 for q in Q if q['g'] == g)}")
    if not 150 <= len(Q) <= 200:
        problems.append(f"вопросов {len(Q)}, нужно 150–200")
    for blk in re.finditer(r"<script>(.*?)</script>", page, re.S):
        rr = subprocess.run(["node", "-e", "new (require('vm').Script)(require('fs').readFileSync(0,'utf8'))"], input=blk.group(1), text=True, encoding="utf-8", capture_output=True)
        if rr.returncode != 0:
            problems.append("синтаксис скрипта: " + rr.stderr.strip().splitlines()[0])
    print(f"Вопросов: {len(Q)}; страница: {OUT} ({OUT.stat().st_size // 1024} КБ)")
    for p in problems:
        print("ПРОБЛЕМА:", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
