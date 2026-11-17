#!/usr/bin/env python3
"""Списки манги и ранобэ для анкеты вкусов, волна 2: названия подбирает человек (LISTS), Shikimori подставляет
русское название, год и номер MyAnimeList (у манги и ранобэ общее пространство номеров MAL). Пишет design/taste/w2/titles.json.

Два списка («новое») берутся из Shikimori по популярности за 2021–2026. Найденное запоминается в titles.cache.json:
повторный запуск ходит только за новыми запросами. Запуск: python -I design/taste/w2/fetch_titles.py
Печатает «запрос -> что нашлось», чтобы глазами проверить подбор; спорное правится в OVERRIDE (kind|запрос -> [раздел, id]).
Личного здесь нет: только публичные данные каталога.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "titles.json"
CACHE = HERE / "titles.cache.json"
API = "https://shikimori.io/api/"
UA = "MeidoBot/1.0 (personal reminder bot)"  # как в src/anime/sources.ts: без личных данных
PAUSE = 0.75
TAG = {"manga": "манга", "manhwa": "манхва", "manhua": "маньхуа", "light_novel": "ранобэ", "novel": "новелла", "one_shot": "ваншот", "doujin": "додзинси"}

# Из ваших ответов волны 1: то, что владелец смотрит или ждёт, в оригинале. Номера лежат вне git (личное, правило проекта):
# data/taste/w2-own.json вида {"fixed": [["manga", 130498], ["ranobe", 126172]]}; нет файла — этого списка нет.
OWN = HERE.parent.parent.parent / "data" / "taste" / "w2-own.json"
FIXED = [tuple(x) for x in json.loads(OWN.read_text(encoding="utf-8"))["fixed"]] if OWN.exists() else []

# (id списка, заголовок, [(раздел, запрос)]). Раздел: manga | manhwa | manhua | ranobe.
M = "manga"; R = "ranobe"; W = "manhwa"; C = "manhua"
LISTS = [
    ("r-man1", "Манга: самое известное", [(M, q) for q in [
        "Berserk", "One Piece", "Naruto", "Bleach", "Fullmetal Alchemist", "Death Note", "Shingeki no Kyojin", "Tokyo Ghoul", "Hunter x Hunter",
        "Vagabond", "Vinland Saga", "One Punch-Man", "Kimetsu no Yaiba", "Jujutsu Kaisen", "Chainsaw Man", "Boku no Hero Academia", "Fairy Tail",
        "Black Clover", "Dr. Stone", "Haikyuu!!", "Slam Dunk", "Monster", "20th Century Boys", "Oyasumi Punpun", "Nana", "Fruits Basket", "Spy x Family",
        "Blue Lock", "Dandadan", "Sakamoto Days", "Dragon Ball", "Gintama", "Hajime no Ippo", "JoJo no Kimyou na Bouken", "Soul Eater", "Noragami",
        "Mushishi", "Made in Abyss", "Sousou no Frieren", "Dungeon Meshi", "Kingdom", "Golden Kamuy", "Oshi no Ko", "Kaijuu 8-gou",
        "Kaguya-sama wa Kokurasetai", "Tokyo Revengers", "Jigokuraku", "Mob Psycho 100"]]),
    ("r-man2", "Манга: фэнтези, исэкай, приключения", [(M, q) for q in [
        "Mushoku Tensei: Isekai Ittara Honki Dasu", "Tensei shitara Slime Datta Ken", "Overlord", "Kono Subarashii Sekai ni Shukufuku wo!",
        "Tate no Yuusha no Nariagari", "No Game No Life", "Log Horizon", "Goblin Slayer", "Magi: The Labyrinth of Magic", "Nanatsu no Taizai",
        "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka", "Sword Art Online", "Hataraku Maou-sama!", "Mahoutsukai no Yome", "Kumo desu ga, Nani ka?",
        "Shangri-La Frontier", "Arifureta Shokugyou de Sekai Saikyou", "Gate: Jieitai Kanochi nite, Kaku Tatakaeri", "Mashle", "Akatsuki no Yona",
        "Ookami to Koushinryou", "Kino no Tabi", "Tongari Boushi no Atelier", "Maoyuu Maou Yuusha", "Kage no Jitsuryokusha ni Naritakute!",
        "Death March kara Hajimaru Isekai Kyousoukyoku", "Tsuki ga Michibiku Isekai Douchuu", "Genjitsu Shugi Yuusha no Oukoku Saikenki",
        "Isekai Shokudou", "Kusuriya no Hitorigoto", "Eiyuu Kyoushitsu", "Saijaku Muhai no Bahamut", "Magic Knight Rayearth", "Fushigi Yuugi", "Slayers",
        "Shuumatsu no Valkyrie", "Rokudenashi Majutsu Koushi to Akashic Records", "Otome Game no Hametsu Flag shika Nai Akuyaku Reijou ni Tensei shiteshimatta",
        "Kuma Kuma Kuma Bear", "Akuyaku Reijou Level 99"]]),
    ("r-man3", "Манга: романтика, повседневность, комедия", [(M, q) for q in [
        "Horimiya", "Komi-san wa, Komyushou desu.", "Nisekoi", "Gotoubun no Hanayome", "Kanojo, Okarishimasu", "Ao Haru Ride", "Kimi ni Todoke",
        "Itazura na Kiss", "Lovely Complex", "Orange", "Sukitte Ii na yo.", "Tonari no Kaibutsu-kun", "Kaichou wa Maid-sama!", "Ouran Koukou Host Club",
        "Skip to Loafer", "Yotsuba to!", "Azumanga Daioh", "Nichijou", "Barakamon", "Yuru Camp", "Non Non Biyori", "Natsume Yuujinchou", "Aria",
        "Bocchi the Rock!", "Grand Blue", "Tonikaku Kawaii", "Ijiranaide, Nagatoro-san", "Karakai Jouzu no Takagi-san", "Wotaku ni Koi wa Muzukashii",
        "Domestic na Kanojo", "Boku no Kokoro no Yabai Yatsu", "Shikimori-san wa Kawaii dake ja Nai", "Sewayaki Kitsune no Senko-san",
        "Kobayashi-san Chi no Maidragon", "Gabriel DropOut", "Saiki Kusuo no Psi-nan", "Danshi Koukousei no Nichijou", "Gekkan Shoujo Nozaki-kun",
        "Ore Monogatari!!", "Yagate Kimi ni Naru", "Maison Ikkoku", "Ranma 1/2", "Urusei Yatsura", "Love Hina", "Seishun Buta Yarou wa Bunny Girl Senpai no Yume wo Minai",
        "Chihayafuru", "Nodame Cantabile", "Fumetsu no Anata e", "3-gatsu no Lion", "Shigatsu wa Kimi no Uso"]]),
    ("r-man4", "Манга: этти и гарем", [(M, q) for q in [
        "To LOVE-Ru", "Prison School", "Ichigo 100%", "Kanojo mo Kanojo", "Monster Musume no Iru Nichijou", "Sekirei", "Rosario to Vampire", "Hyakkano",
        "High School DxD", "Shokugeki no Souma", "Date A Live", "Bokutachi wa Benkyou ga Dekinai", "Yamada-kun to 7-nin no Majo", "Tenchi Muyo!",
        "Shuumatsu no Harem", "Seitokai Yakuindomo", "Mahoromatic", "Hanaukyo Maid Tai", "Ichiban Ushiro no Daimaou", "Kono Subarashii Sekai ni Bakuen wo!"]]),
    ("r-man5", "Манга: экшен, сёнэн, сэйнэн, мистика", [(M, q) for q in [
        "Kengan Ashura", "Enen no Shouboutai", "Akame ga Kill!", "Claymore", "Kiseijuu", "Dorohedoro", "Ao no Exorcist", "Bungou Stray Dogs", "Ajin",
        "Platinum End", "Tomodachi Game", "Liar Game", "Kaiji", "Kakegurui", "Yakusoku no Neverland", "Terra Formars", "Btooom!", "Deadman Wonderland",
        "Yuukoku no Moriarty", "Detective Conan", "Boku dake ga Inai Machi", "Kuroko no Basket", "Blue Period", "Yowamushi Pedal", "Ao Ashi", "Giant Killing",
        "Baki", "Akira", "Koukaku Kidoutai", "Planetes", "Blame!", "Knights of Sidonia", "Black Lagoon", "Gunnm", "Trigun", "Gantz", "Rurouni Kenshin",
        "Yu Yu Hakusho", "Eyeshield 21", "Shaman King", "Bakuman."]]),
    ("r-man6", "Манхва, маньхуа и вебтуны", [(W, q) for q in [
        "Solo Leveling", "Tower of God", "The God of High School", "Noblesse", "Sweet Home", "Lookism", "Eleceed", "The Beginning After the End",
        "Omniscient Reader's Viewpoint", "Return of the Mount Hua Sect", "Second Life Ranker", "True Beauty", "Cheese in the Trap", "Girls of the Wild's",
        "Bastard", "Wind Breaker", "Unordinary", "The Remarried Empress", "Who Made Me a Princess", "The Villainess Lives Twice", "I'll Be the Matriarch in This Life",
        "The Abandoned Empress", "Beware of the Villainess!", "Legend of the Northern Blade", "Kubera", "Duty after School", "Hardcore Leveling Warrior"]]
        + [(C, q) for q in ["Tales of Demons and Gods", "Battle Through the Heavens", "Soul Land", "Quanzhi Fashi", "Quanzhi Gaoshou"]]),
    ("r-ran1", "Ранобэ: самое известное", [(R, q) for q in [
        "Sword Art Online", "Ookami to Koushinryou", "Toradora!", "Re:Zero kara Hajimeru Isekai Seikatsu", "Kono Subarashii Sekai ni Shukufuku wo!", "Overlord",
        "Mushoku Tensei: Isekai Ittara Honki Dasu", "Tensei shitara Slime Datta Ken", "Tate no Yuusha no Nariagari", "No Game No Life", "Log Horizon",
        "Suzumiya Haruhi no Yuuutsu", "Bakemonogatari", "Baccano!", "Durarara!!", "Full Metal Panic!", "Toaru Majutsu no Index",
        "Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e", "Yahari Ore no Seishun Love Comedy wa Machigatteiru.", "Seishun Buta Yarou wa Bunny Girl Senpai no Yume wo Minai",
        "Hyouka", "86: Eighty Six", "Honzuki no Gekokujou", "Kusuriya no Hitorigoto", "Goblin Slayer", "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka",
        "Kage no Jitsuryokusha ni Naritakute!", "Date A Live", "Kino no Tabi", "Ginga Eiyuu Densetsu", "Fate/Zero", "Boogiepop wa Warawanai", "Slayers",
        "Shakugan no Shana", "Hataraku Maou-sama!", "Boku wa Tomodachi ga Sukunai", "Ore no Imouto ga Konna ni Kawaii Wake ga Nai", "Chuunibyou demo Koi ga Shitai!",
        "Another", "Gosick", "Hige wo Soru. Soshite Joshikousei wo Hirou.", "Otonari no Tenshi-sama ni Itsunomanika Dame Ningen ni Sareteita Ken"]]),
    ("r-ran2", "Ранобэ: исэкай и фэнтези", [(R, q) for q in [
        "Kumo desu ga, Nani ka?", "Arifureta Shokugyou de Sekai Saikyou", "Death March kara Hajimaru Isekai Kyousoukyoku", "Isekai wa Smartphone to Tomo ni.",
        "Saijaku Muhai no Bahamut", "Tondemo Skill de Isekai Hourou Meshi", "Re:Monster", "Fate/Apocrypha", "Zero no Tsukaima", "Shinmai Maou no Testament",
        "Tsukimichi: Moonlit Fantasy", "Gate: Jieitai Kanochi nite, Kaku Tatakaeri", "Genjitsu Shugi Yuusha no Oukoku Saikenki", "Maoyuu Maou Yuusha",
        "Hai to Gensou no Grimgar", "Seirei no Moribito", "Eiyuu Kyoushitsu", "Mahouka Koukou no Rettousei", "Mondaiji-tachi ga Isekai kara Kuru Sou Desu yo?",
        "Kuma Kuma Kuma Bear", "Otome Game no Hametsu Flag shika Nai Akuyaku Reijou ni Tensei shiteshimatta", "Tsuki ga Michibiku Isekai Douchuu",
        "Akuyaku Reijou Level 99", "Seijo no Maryoku wa Bannou desu", "Tensei Oujo to Tensai Reijou no Mahou Kakumei", "Kono Sekai ga Game Dato Ore Dake ga Shitteiru",
        "Shin no Nakama ja Nai to Yuusha no Party wo Oidasareta node, Henkyou de Slow Life suru Koto ni Shimashita", "Lv1 kara Hajimaru Shoukan Musou"]]),
    ("r-ran3", "Ранобэ: романтика, комедия, повседневность", [(R, q) for q in [
        "Sakurasou no Pet na Kanojo", "Kokoro Connect", "Gamers!", "Hentai Ouji to Warawanai Neko.", "Kanojo ga Flag wo Oraretara",
        "Ore no Kanojo to Osananajimi ga Shuraba Sugiru", "Kimi no Suizou wo Tabetai", "Mamahaha no Tsurego ga Motokano datta", "Tokidoki Bosotto Russia-go de Dereru Tonari no Alya-san",
        "Mayo Chiki!", "Rokujouma no Shinryakusha!?", "Shuumatsu Nani Shitemasu ka? Isogashii desu ka? Sukutte Moratte Ii desu ka?", "Kimi no Na wa.", "Tenki no Ko",
        "Suzume no Tojimari", "Koi to Uso", "Tsuki ga Kirei", "Bokura no Hentai", "Kimi to Boku no Saigo no Senjou, Aruiwa Sekai ga Hajimaru Seisen", "Yagate Kimi ni Naru",
        "Hayate no Gotoku!", "Kaichou wa Maid-sama!", "Himawari no Chiisana Kyoukai"]]),
    ("r-ran4", "Ранобэ: детектив, мистика, фантастика", [(R, q) for q in [
        "No. 6", "Kyoukai no Kanata", "Kizumonogatari", "Zaregoto", "Kyokou Suiri", "Lord of the Mysteries", "Shinsekai yori", "Zero kara Hajimeru Mahou no Sho",
        "Kimi no Todoke"]]),
]
# Два списка «новое»: берутся по популярности за 2021–2026, всё, чего нет в списках выше.
NEW_LISTS = [("r-man7", "Манга: новое (2021 и новее)", "mangas", {"kind": "manga"}, 40), ("r-ran5", "Ранобэ: новое (2021 и новее)", "ranobe", {}, 35)]

OVERRIDE: dict[str, list] = {}

# Правки по первому прогону (проверено глазами): неверные совпадения убраны или переписаны. Ключ: «раздел|запрос».
DROP = {
    "manga|JoJo no Kimyou na Bouken", "manga|Hyakkano", "manga|Yagate Kimi ni Naru", "manga|Kaiji", "manga|Blue Period", "manga|Baki",
    "manga|Koukaku Kidoutai", "manga|Rurouni Kenshin", "manga|Tenchi Muyo!", "manhwa|Beware of the Villainess!", "manhua|Tales of Demons and Gods",
    "manhwa|Duty after School", "ranobe|Tensei Oujo to Tensai Reijou no Mahou Kakumei", "ranobe|Lv1 kara Hajimaru Shoukan Musou", "ranobe|Kimi no Na wa.",
    "ranobe|Tenki no Ko", "ranobe|Tsuki ga Kirei", "ranobe|Bokura no Hentai", "ranobe|Yagate Kimi ni Naru", "ranobe|Kaichou wa Maid-sama!",
    "ranobe|Himawari no Chiisana Kyoukai", "ranobe|No. 6", "ranobe|Kimi no Todoke", "ranobe|Honzuki no Gekokujou",
}
SWAP = {
    "manga|Oshi no Ko": "Ребёнок идола",
    "manga|Kaguya-sama wa Kokurasetai": "Kaguya-sama wa Kokurasetai: Tensai-tachi no Renai Zunousen",
    "manga|Yuru Camp": "Laid-Back Camp",
    "manga|Sword Art Online": "Sword Art Online: Aincrad",
    "manga|Kobayashi-san Chi no Maidragon": "Miss Kobayashi's Dragon Maid",
    "ranobe|Seishun Buta Yarou wa Bunny Girl Senpai no Yume wo Minai": "Rascal Does Not Dream of Bunny Girl Senpai",
}


def get(path: str, params: dict):
    url = API + path + "?" + urllib.parse.urlencode(params)
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


def endpoint(section: str) -> str:
    return "ranobe" if section == "ranobe" else "mangas"


def item(a: dict) -> dict:
    on = a.get("aired_on") or ""
    year = int(on[:4]) if len(on) >= 4 and on[:4].isdigit() else None
    return {"id": a["id"], "ru": (a.get("russian") or a.get("name") or "").strip(), "orig": (a.get("name") or "").strip(), "year": year, "tag": TAG.get(a.get("kind", ""), "")}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {"ids": {}, "rec": {}}
    ids, rec = cache["ids"], cache["rec"]

    def save():
        CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")

    plan = [("r-own", "Из ваших ответов: смотрите или ждёте (в оригинале)", [("fixed", "", s, i) for s, i in FIXED])] if FIXED else []
    for lid, title, queries in LISTS:
        got = []
        for section, q in queries:
            if f"{section}|{q}" in DROP:
                continue
            q = SWAP.get(f"{section}|{q}", q)
            key = f"{section}|{q}"
            if key in OVERRIDE:
                got.append((section, q, OVERRIDE[key][0], OVERRIDE[key][1]))
                continue
            if key not in ids:
                params = {"search": q, "limit": 3, "order": "popularity", "censored": "true"}
                if section in ("manga", "manhwa", "manhua"):
                    params["kind"] = section
                res = get(endpoint(section), params)
                if not res and section != "ranobe":
                    params.pop("kind", None)
                    res = get("mangas", params)
                if not res:
                    print(f"  ?? {section}|{q}: не нашлось")
                    continue
                ids[key] = [endpoint(section), res[0]["id"]]
                rec[f"{endpoint(section)}:{res[0]['id']}"] = item(res[0])
                save()
            got.append((section, q, ids[key][0], ids[key][1]))
        plan.append((lid, title, got))
    # недостающие записи (FIXED и т. п.) — пакетами по 50 id
    for ep in ("mangas", "ranobe"):
        need = sorted({i for _, _, g in plan for _, _, e, i in g if ("ranobe" if e == "ranobe" else "mangas") == ep and f"{ep}:{i}" not in rec})
        for k in range(0, len(need), 50):
            for a in get(ep, {"ids": ",".join(map(str, need[k:k + 50])), "limit": 50}):
                rec[f"{ep}:{a['id']}"] = item(a)
    save()

    used: set[int] = set()
    out_lists = []

    def emit(lid, title, got):
        items = []
        print(f"## {lid} {title}")
        for section, q, ep, i in got:
            ep = "ranobe" if ep == "ranobe" else "mangas"
            it = rec.get(f"{ep}:{i}")
            if not it:
                print(f"  ?? {q or i}: id {i} не загрузился")
                continue
            dup = i in used
            print(f"  {q or '#' + str(i)} -> {it['ru']} ({it['year']}) {it['tag']} [{i}]" + ("  ДУБЛЬ, пропущен" if dup else ""))
            if dup:
                continue
            used.add(i)
            items.append(it)
        out_lists.append({"id": lid, "t": title, "items": items})

    for lid, title, got in plan:
        emit(lid, title, got)
    for lid, title, ep, base, n in NEW_LISTS:
        key = f"new|{ep}"
        if key not in ids:
            pool = []
            for p in (1, 2, 3):
                pool += get(ep, {**base, "season": "2021_2026", "order": "popularity", "censored": "true", "limit": 50, "page": p})
            for a in pool:
                rec[f"{ep}:{a['id']}"] = item(a)
            ids[key] = [[ep, a["id"]] for a in pool]
            save()
        got = []
        for e, i in ids[key]:
            if i in used:
                continue
            got.append(("new", "", e, i))
            if len(got) >= n + 12:  # запас на дубли внутри эмиссии
                break
        emit(lid, title, got[:n + 8])
        out_lists[-1]["items"] = out_lists[-1]["items"][:n]
    OUT.write_text(json.dumps({"source": "shikimori.io", "fetched": time.strftime("%Y-%m-%d"), "lists": out_lists}, ensure_ascii=False, indent=1), encoding="utf-8")
    print()
    for l in out_lists:
        print(f"{l['id']}: {len(l['items'])}  {l['t']}")
    print("Всего:", sum(len(l["items"]) for l in out_lists))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
