import { describe, expect, it } from "vitest";
import { fetchTgChannel, parseTgChannel, tgUrl } from "../src/tgChannel.ts";

const post = (channel: string, id: number, iso: string, html: string | null): string =>
  `<div class="tgme_widget_message" data-post="${channel}/${id}"><a class="tgme_widget_message_date"><time datetime="${iso}">x</time></a>${html === null ? "" : `<div class="tgme_widget_message_text js-message_text">${html}</div>`}</div>`;

const PAGE = [
  post("avariykaaa", 27820, "2026-11-19T09:12:32+00:00", "⚡️Шановні споживачі.<br/><br/>Повертаємося до ГРАФІКІВ &amp; тиші"),
  post("avariykaaa", 27821, "2026-11-19T09:13:34+00:00", null),
  post("avariykaaa", 27822, "2026-11-19T09:14:40+00:00", "Черги 3.1 та 3.2 — 12:30–19:30"),
].join("\n");

describe("tgChannel: лента публичного канала", () => {
  it("посты с текстом: канал, номер, время, ссылка; без текста пропускаются, порядок как на странице", () => {
    const posts = parseTgChannel(PAGE);
    expect(posts.map((p) => p.id)).toEqual([27820, 27822]);
    expect(posts[0]).toMatchObject({ channel: "avariykaaa", at: Date.parse("2026-11-19T09:12:32+00:00"), link: "https://t.me/avariykaaa/27820" });
    expect(posts[0].text).toBe("⚡️Шановні споживачі.\n\nПовертаємося до ГРАФІКІВ & тиші");
  });

  it("пустая и чужая страница — пустой список", () => {
    expect(parseTgChannel("")).toEqual([]);
    expect(parseTgChannel('<div data-post="x/abc"></div>')).toEqual([]);
  });

  it("fetchTgChannel: читает t.me/s/<канал>; не 200, сбой сети и пустая страница дают null", async () => {
    const calls: string[] = [];
    const ok: typeof fetch = async (u) => (calls.push(String(u)), new Response(PAGE, { status: 200 }));
    expect((await fetchTgChannel("avariykaaa", ok))?.length).toBe(2);
    expect(calls).toEqual([tgUrl("avariykaaa")]);
    expect(await fetchTgChannel("x", async () => new Response("", { status: 404 }))).toBeNull();
    expect(await fetchTgChannel("x", async () => { throw new Error("сеть"); })).toBeNull();
    expect(await fetchTgChannel("x", async () => new Response("<html>просмотр выключен</html>", { status: 200 }))).toBeNull();
  });
});
