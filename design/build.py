#!/usr/bin/env python3
"""Собирает design/page.html (страница решений для claude.ai) из шаблона tools/questions-page/template.html.

Берёт из шаблона стили и скрипт сохранения ответов (второй блок <script>), подставляет свои:
extra.css, body.html и data.js (группы и вопросы). Запуск: python design/build.py
Проверка без браузера: синтаксис скриптов через node, уникальные id вопросов, не больше шести вариантов,
рекомендованный вариант первым.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # D:\_Automation
TEMPLATE = ROOT / "tools" / "questions-page" / "template.html"
OUT = HERE / "page.html"

SUB = "Черновик дизайна от 7 ноября 2026. Бесплатный Cloudflare и личный Discord, всё внутри Discord. Сначала как работает и как выглядит, потом что умеет и чего нельзя, в конце 23 вопроса."


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    tpl =TEMPLATE.read_text(encoding="utf-8")
    style_end = tpl.index("</style>")
    head = tpl[:style_end]
    head = re.sub(r"<title>.*?</title>", "<title>Проект Discord-бота</title>", head, count=1)
    scripts = list(re.finditer(r"<script>(.*?)</script>", tpl, re.S))
    if len(scripts) != 2:
        print("В шаблоне ожидалось два блока <script>", file=sys.stderr)
        return 1
    app = scripts[1].group(1)
    # свой ключ localStorage и свой подзаголовок вместо строки про NEXT-STEPS
    app = app.replace('"nsq-answers"', '"bot-answers"')
    app, n = re.subn(r"\$\(\"sub\"\)\.textContent = `[^`]*`;", lambda m: '$("sub").textContent = ' + json.dumps(SUB, ensure_ascii=False) + ";", app)
    if n != 1:
        print("Не нашёл строку подзаголовка в шаблоне", file=sys.stderr)
        return 1
    app = app.replace('q.proj || "OnePassQA"', 'q.proj || "Бот"')

    extra = (HERE / "extra.css").read_text(encoding="utf-8")
    body = (HERE / "body.html").read_text(encoding="utf-8")
    data = (HERE / "data.js").read_text(encoding="utf-8")
    tabs = """
const tabBtns = [...document.querySelectorAll('[data-tab]')];
tabBtns.forEach(b => b.addEventListener('click', () => {
  tabBtns.forEach(x => { const on = x === b; x.setAttribute('aria-selected', String(on)); const p = document.getElementById(x.dataset.tab); if (p) p.hidden = !on; });
}));
"""
    page = head + "\n" + extra + "\n</style>\n\n" + body + "\n<script>\n" + data + "\n</script>\n\n<script>" + app + "</script>\n\n<script>" + tabs + "</script>\n"
    OUT.write_text(page, encoding="utf-8")

    # --- проверки ---
    ids = re.findall(r"\{ id: `([A-Z]\d+)`", data)
    problems = []
    if len(ids) != len(set(ids)):
        problems.append("повторяются id вопросов")
    for m in re.finditer(r"\{ id: `([A-Z]\d+)`.*?opts: \[(.*?)\]\s*\}", data, re.S):
        lines = [ln for ln in m.group(2).split("\n") if ln.strip().startswith("o(")]
        if len(lines) > 6:
            problems.append(f"{m.group(1)}: больше шести вариантов ({len(lines)})")
        if len(lines) < 2:
            problems.append(f"{m.group(1)}: меньше двух вариантов")
        flags = [bool(re.search(r",\s*true\)", ln)) for ln in lines]
        if flags and not flags[0]:
            problems.append(f"{m.group(1)}: рекомендованный вариант не первый")
        if flags and flags != sorted(flags, reverse=True):
            problems.append(f"{m.group(1)}: рекомендованные варианты идут не подряд с начала")
    # id в каталоге ведут на существующие вопросы
    for ref in set(re.findall(r'href="#q-([A-Z]\d+)"', body)):
        if ref not in ids:
            problems.append(f"в каталоге ссылка на несуществующий вопрос {ref}")
    for blk in re.finditer(r"<script>(.*?)</script>", page, re.S):
        r = subprocess.run(["node", "-e", "new (require('vm').Script)(require('fs').readFileSync(0,'utf8'))"], input=blk.group(1), text=True, encoding="utf-8", capture_output=True)
        if r.returncode != 0:
            problems.append("синтаксис скрипта: " + r.stderr.strip().splitlines()[0])
    print(f"Вопросов: {len(ids)}; страница: {OUT} ({OUT.stat().st_size // 1024} КБ)")
    for p in problems:
        print("ПРОБЛЕМА:", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
