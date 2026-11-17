#!/usr/bin/env python3
"""Собирает списки аниме для анкеты вкусов: названия подбирает человек (раздел LISTS), а Shikimori подставляет
русское название, год и номер MyAnimeList. Пишет design/taste/titles.json.

Зачем: отметки «понравилось / бросил / в планах» по готовому списку быстрее вопросов, а id = номер MAL, тот же, что в
таблице `anime` бота (migrations/0006_anime.sql): ответы потом грузятся в коллекцию без ручного переноса.
Запуск: python -I design/taste/fetch_titles.py  (первый раз минут 10: у Shikimori предел ~90 запросов в минуту;
найденное запоминается в titles.cache.json, повторный запуск берёт из него и ходит только за новыми запросами).
Печатает «запрос -> что нашлось», чтобы глазами проверить подбор; спорное правится в OVERRIDE (запрос -> id MAL).
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
API = "https://shikimori.io/api/animes"
UA = "MeidoBot/1.0 (personal reminder bot)"  # как в src/anime/sources.ts: без личных данных
PAUSE = 0.75

# (id списка, заголовок, вид, [запросы]). Запрос — название тайтла по-английски/ромадзи; берётся самый популярный результат.
# Порядок важен: тайтл попадает в первый список, где встретился (поэтому «new» стоит раньше жанровых).
LISTS = [
    ("cls", "Вехи и классика", "tv", [
        "Cowboy Bebop", "Neon Genesis Evangelion", "Fullmetal Alchemist: Brotherhood", "Death Note", "Code Geass: Hangyaku no Lelouch",
        "Steins;Gate", "Hunter x Hunter 2011", "Berserk 1997", "Monster", "Trigun", "Tengen Toppa Gurren Lagann",
        "Serial Experiments Lain", "Ghost in the Shell: Stand Alone Complex", "Samurai Champloo", "Rurouni Kenshin", "Dragon Ball Z",
        "Slam Dunk", "Great Teacher Onizuka", "Fruits Basket 2001", "Hellsing Ultimate", "Planetes", "Mushishi", "Bleach", "Naruto",
        "One Piece", "Inuyasha", "Bishoujo Senshi Sailor Moon", "Cardcaptor Sakura", "Shoujo Kakumei Utena", "Ginga Eiyuu Densetsu",
        "Paranoia Agent", "Honey and Clover", "Welcome to the N.H.K.", "Suzumiya Haruhi no Yuuutsu", "Lucky Star", "Clannad",
        "Toradora!", "Higurashi no Naku Koro ni", "Ookami to Koushinryou", "K-On!"]),
    ("new", "Последние годы (2021 и новее)", "tv", [
        "Sousou no Frieren", "Chainsaw Man", "Bocchi the Rock!", "Lycoris Recoil", "Cyberpunk: Edgerunners", "Oshi no Ko", "Dandadan",
        "Ore dake Level Up na Ken", "Kaijuu 8-gou", "Dungeon Meshi", "Kusuriya no Hitorigoto", "Jigokuraku", "Kage no Jitsuryokusha ni Naritakute!",
        "Bleach: Sennen Kessen-hen", "Sono Bisque Doll wa Koi wo Suru", "Zom 100: Zombie ni Naru made ni Shitai 100 no Koto", "Shangri-La Frontier",
        "Mashle", "Undead Unluck", "Tengoku Daimakyou", "Ousama Ranking", "Wind Breaker", "Ao no Hako", "Sakamoto Days", "Mission: Yozakura Family",
        "Medalist", "Gachiakuta", "Kowloon Generic Romance", "Boku no Kokoro no Yabai Yatsu", "Girls Band Cry", "Spy x Family", "Blue Lock",
        "Skip to Loafer", "Yofukashi no Uta", "Spy Kyoushitsu", "Tomo-chan wa Onnanoko!", "Orb: On the Movements of the Earth"]),
    ("act", "Экшен и сёнэн", "tv", [
        "Shingeki no Kyojin", "Kimetsu no Yaiba", "Jujutsu Kaisen", "Boku no Hero Academia", "One Punch Man", "Fairy Tail", "Black Clover",
        "Dr. Stone", "Mob Psycho 100", "Soul Eater", "Ao no Exorcist", "Enen no Shouboutai", "Nanatsu no Taizai",
        "Tokyo Revengers", "Kill la Kill", "Akame ga Kill!", "Ansatsu Kyoushitsu", "JoJo no Kimyou na Bouken 2012",
        "Vinland Saga", "Claymore", "Fate/Zero", "Fate/stay night: Unlimited Blade Works", "Black Lagoon",
        "Baccano!", "Durarara!!", "Gintama", "Bungou Stray Dogs", "Noragami", "Dorohedoro",
        "Sword Art Online", "Overlord", "Naruto: Shippuuden", "Dragon Ball Super", "Shaman King 2021", "Fullmetal Alchemist 2003",
        "Hajime no Ippo", "Yu Yu Hakusho", "Kekkai Sensen", "Hataraku Maou-sama!"]),
    ("fan", "Фэнтези и исэкай", "tv", [
        "Re:Zero kara Hajimeru Isekai Seikatsu", "Kono Subarashii Sekai ni Shukufuku wo!", "Tensei shitara Slime Datta Ken",
        "Mushoku Tensei: Isekai Ittara Honki Dasu", "Tate no Yuusha no Nariagari", "No Game No Life", "Log Horizon", "Made in Abyss",
        "Magi: The Labyrinth of Magic", "Violet Evergarden", "Mahoutsukai no Yome", "Goblin Slayer",
        "Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka", "Honzuki no Gekokujou: Shisho ni Naru Tame ni wa Shudan wo Erandeiraremasen",
        "Little Witch Academia (TV)", "Natsume Yuujinchou", "Mononoke", "Kino no Tabi 2003", "Yakusoku no Neverland", "Akatsuki no Yona",
        "Fushigi Yuugi", "Maoyuu Maou Yuusha", "Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e", "Fate/Apocrypha", "Arslan Senki",
        "Seirei no Moribito", "Kemono no Souja Erin", "Kumo desu ga, Nani ka?", "Sewayaki Kitsune no Senko-san", "Flying Witch", "Hakumei to Mikochi"]),
    ("sci", "Фантастика, детектив, психология", "tv", [
        "Psycho-Pass", "Kidou Senshi Gundam: Tekketsu no Orphans", "Kidou Senshi Gundam 00", "Macross Frontier", "Koukyoushihen Eureka Seven",
        "Darling in the FranXX", "86: Eighty Six", "Vivy: Fluorite Eye's Song", "Ergo Proxy", "Texhnolyze", "Dimension W", "Knights of Sidonia",
        "Parasyte: The Maxim", "Tokyo Ghoul", "Another", "Death Parade", "Boku dake ga Inai Machi", "Ajin", "Zankyou no Terror", "Re:Creators",
        "Kakegurui", "Gyakkyou Burai Kaiji: Ultimate Survivor", "Tatami Galaxy", "Mawaru Penguindrum", "Puella Magi Madoka Magica", "Mirai Nikki", "Odd Taxi",
        "Summer Time Rendering", "Bakemonogatari", "Ping Pong the Animation", "Shinsekai yori", "Hyouka", "Ghost Hunt",
        "Space Dandy", "Outlaw Star", "Mobile Suit Gundam", "Aldnoah.Zero", "Full Metal Panic!", "Bokurano", "Uchuu Kyoudai", "Detective Conan",
        "Black Butler", "Hell Girl", "Shiki", "Elfen Lied", "Devilman Crybaby", "Gantz", "Pluto", "Boogiepop wa Warawanai"]),
    ("sol", "Повседневность и комедия", "tv", [
        "Nichijou", "Azumanga Daioh", "Kaguya-sama wa Kokurasetai: Tensai-tachi no Renai Zunousen", "Grand Blue", "Saiki Kusuo no Psi-nan",
        "Danshi Koukousei no Nichijou", "Barakamon", "Non Non Biyori", "Yuru Camp", "Hinamatsuri", "Kobayashi-san Chi no Maidragon", "Hataraku Saibou",
        "Tonari no Seki-kun", "Tanaka-kun wa Itsumo Kedaruge", "Wotaku ni Koi wa Muzukashii", "Karakai Jouzu no Takagi-san", "Ijiranaide, Nagatoro-san",
        "Komi-san wa, Komyushou desu.", "Chuunibyou demo Koi ga Shitai!", "Yahari Ore no Seishun Love Comedy wa Machigatteiru.",
        "Shirobako", "Seishun Buta Yarou wa Bunny Girl Senpai no Yume wo Minai", "Gekkan Shoujo Nozaki-kun", "Gabriel DropOut", "Kiniro Mosaic",
        "Gochuumon wa Usagi Desu ka?", "Aria the Animation", "Sora yori mo Tooi Basho", "Shoujo Shuumatsu Ryokou", "Ouran Koukou Host Club",
        "Sakurasou no Pet na Kanojo", "Great Pretender", "Kono Oto Tomare!", "Osomatsu-san", "Pop Team Epic", "Asobi Asobase",
        "Emma: A Victorian Romance", "Mahoromatic", "Kaichou wa Maid-sama!", "Hanasaku Iroha", "Tsuki ga Kirei", "Tonikaku Kawaii"]),
    ("rom", "Романтика и драма", "tv", [
        "Clannad: After Story", "Shigatsu wa Kimi no Uso", "Ano Hi Mita Hana no Namae wo Bokutachi wa Mada Shiranai.", "Orange", "Kimi ni Todoke", "Ao Haru Ride",
        "Fruits Basket 2019", "Plastic Memories", "Nana", "Chihayafuru", "3-gatsu no Lion", "Angel Beats!", "Charlotte", "Tsurezure Children", "Ore Monogatari!!",
        "Domestic na Kanojo", "Kanojo, Okarishimasu", "Gotoubun no Hanayome", "Nisekoi", "School Days", "White Album 2", "Golden Time", "Yuri!!! on Ice",
        "Lovely Complex", "Itazura na Kiss", "Skip Beat!", "Nodame Cantabile", "Maison Ikkoku", "Kamisama Hajimemashita",
        "Akagami no Shirayuki-hime", "Kokoro Connect", "Say \"I Love You\".", "Tonari no Kaibutsu-kun", "Kiss Him, Not Me", "Fumetsu no Anata e",
        "Horimiya", "Koi to Uso", "Sankarea"]),
    ("spo", "Спорт, музыка, ремесло", "tv", [
        "Haikyuu!!", "Kuroko no Basket", "Free!", "Yowamushi Pedal", "Diamond no Ace", "Initial D First Stage", "Prince of Tennis", "Kaze ga Tsuyoku Fuiteiru",
        "Baby Steps", "Hikaru no Go", "Giant Killing", "Hanebado!", "Beck", "Sound! Euphonium", "Shokugeki no Souma", "Love Live!", "Zombieland Saga",
        "Show by Rock!!", "Tsurune", "Sk8 the Infinity", "Ahiru no Sora", "Megalo Box", "Eyeshield 21", "Captain Tsubasa", "Bakuman.", "Silver Spoon",
        "Ookiku Furikabutte", "Space Brothers", "Run with the Wind"]),
    ("mov", "Фильмы", "movie", [
        "Sen to Chihiro no Kamikakushi", "Mononoke-hime", "Tonari no Totoro", "Howl no Ugoku Shiro", "Majo no Takkyuubin", "Tenkuu no Shiro Laputa",
        "Kaze no Tani no Nausicaa", "Hotaru no Haka", "Kurenai no Buta", "Gake no Ue no Ponyo", "Kaze Tachinu", "Kimi no Na wa.", "Tenki no Ko", "Suzume no Tojimari",
        "Kotonoha no Niwa", "Byousoku 5 Centimeter", "Koe no Katachi", "Kimi no Suizou wo Tabetai", "Ookami Kodomo no Ame to Yuki", "Summer Wars",
        "Toki wo Kakeru Shoujo", "Perfect Blue", "Akira", "Koukaku Kidoutai", "Paprika", "Sennen Joyuu", "Tokyo Godfathers", "Evangelion: 3.0+1.0 Thrice Upon a Time",
        "Neon Genesis Evangelion: The End of Evangelion", "Jujutsu Kaisen 0", "Kimetsu no Yaiba Movie: Mugen Ressha-hen", "Violet Evergarden Movie",
        "Made in Abyss Movie 3", "Redline", "Mind Game", "Ryuu to Sobakasu no Hime", "Kaguya-hime no Monogatari", "Mimi wo Sumaseba", "Kari-gurashi no Arrietty",
        "Omoide no Marnie", "Kimi-tachi wa Dou Ikiru ka", "Look Back", "Hotarubi no Mori e", "Mary to Majo no Hana", "Fireworks",
        "Ghost in the Shell 2: Innocence", "Cowboy Bebop: Tengoku no Tobira"]),
]

# Если поиск ошибся: «запрос» -> id MAL (проверяется глазами по выводу).
OVERRIDE: dict[str, int] = {
    "Ginga Eiyuu Densetsu": 820,
    "Cyberpunk: Edgerunners": 42310,
    "Devilman Crybaby": 35120,
    "Yuru Camp": 34798,
    "Fruits Basket 2019": 38680,
}


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


def item(a: dict) -> dict:
    on = a.get("aired_on") or ""
    year = int(on[:4]) if len(on) >= 4 and on[:4].isdigit() else None
    return {"id": a["id"], "ru": (a.get("russian") or a.get("name") or "").strip(), "orig": (a.get("name") or "").strip(), "year": year}


def load_cache() -> dict:
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    return {"ids": {}, "rec": {}}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    cache = load_cache()
    ids, rec = cache["ids"], cache["rec"]
    plan = []  # (список, [(запрос, id)])
    for lid, title, kind, queries in LISTS:
        got = []
        for q in queries:
            if q in OVERRIDE:
                got.append((q, OVERRIDE[q]))
                continue
            key = f"{kind}|{q}"
            if key not in ids:
                res = get({"search": q, "kind": kind, "limit": 3, "order": "popularity", "censored": "true"})
                if not res:
                    res = get({"search": q, "limit": 3, "order": "popularity", "censored": "true"})
                if not res:
                    print(f"  ?? {q}: не нашлось")
                    continue
                ids[key] = res[0]["id"]
                rec[str(res[0]["id"])] = item(res[0])
                CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            got.append((q, ids[key]))
        plan.append((lid, title, got))
    need = sorted({i for _, _, got in plan for _, i in got if str(i) not in rec})
    for k in range(0, len(need), 50):
        for a in get({"ids": ",".join(map(str, need[k:k + 50])), "limit": 50}):
            rec[str(a["id"])] = item(a)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")

    used: set[int] = set()
    out_lists = []
    for lid, title, got in plan:
        items = []
        print(f"## {lid} {title}")
        for q, i in got:
            it = rec.get(str(i))
            if not it:
                print(f"  ?? {q}: id {i} не загрузился")
                continue
            dup = i in used
            print(f"  {q} -> {it['ru']} ({it['year']}) [{i}]" + ("  ДУБЛЬ, пропущен" if dup else ""))
            if dup:
                continue
            used.add(i)
            items.append(it)
        out_lists.append({"id": lid, "t": title, "items": items})
    OUT.write_text(json.dumps({"source": "shikimori.io", "fetched": time.strftime("%Y-%m-%d"), "lists": out_lists}, ensure_ascii=False, indent=1), encoding="utf-8")
    print()
    for l in out_lists:
        print(f"{l['id']}: {len(l['items'])}  {l['t']}")
    print("Всего:", sum(len(l["items"]) for l in out_lists))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
