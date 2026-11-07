// Настоящий клиент Discord REST (fetch). В тестах вместо него подставляется поддельный.
import type { Counter } from "../db/repo.ts";
import { BudgetExceeded } from "../db/repo.ts";
import {
  DiscordError,
  type DiscordApi,
  type GuildChannel,
  type IncomingMessage,
  type MessageBody,
  type SentMessage,
} from "./types.ts";

const BASE = "https://discord.com/api/v10";

export function createDiscordApi(token: string, fetchFn: typeof fetch = fetch): DiscordApi {
  async function call(method: string, path: string, body?: unknown, opts: { okStatuses?: number[] } = {}): Promise<unknown> {
    const res = await fetchFn(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
        "user-agent": "MeidoBot (personal, 0.1)",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok || opts.okStatuses?.includes(res.status)) {
      if (res.status === 204 || res.status === 404) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    let retry: number | null = null;
    let msg = `Discord ${res.status}`;
    try {
      const j = (await res.json()) as { retry_after?: number; message?: string };
      if (typeof j.retry_after === "number") retry = j.retry_after;
      if (j.message) msg += `: ${j.message}`;
    } catch {
      /* тела нет */
    }
    throw new DiscordError(res.status, msg, retry);
  }

  return {
    async postMessage(channelId, body): Promise<SentMessage> {
      return (await call("POST", `/channels/${channelId}/messages`, body)) as SentMessage;
    },
    async editMessage(channelId, messageId, body): Promise<void> {
      await call("PATCH", `/channels/${channelId}/messages/${messageId}`, body);
    },
    async deleteMessage(channelId, messageId): Promise<void> {
      await call("DELETE", `/channels/${channelId}/messages/${messageId}`, undefined, { okStatuses: [404] });
    },
    async listMessages(channelId, after, limit): Promise<IncomingMessage[]> {
      const q = new URLSearchParams({ limit: String(limit) });
      if (after) q.set("after", after);
      const list = ((await call("GET", `/channels/${channelId}/messages?${q}`)) as IncomingMessage[] | null) ?? [];
      return list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    },
    async listGuildChannels(guildId): Promise<GuildChannel[]> {
      return ((await call("GET", `/guilds/${guildId}/channels`)) as GuildChannel[] | null) ?? [];
    },
    async createChannel(guildId, body): Promise<{ id: string }> {
      return (await call("POST", `/guilds/${guildId}/channels`, body)) as { id: string };
    },
    async createDm(userId): Promise<{ id: string }> {
      return (await call("POST", "/users/@me/channels", { recipient_id: userId })) as { id: string };
    },
    async editInteractionOriginal(appId, interactionToken, body: MessageBody): Promise<void> {
      await call("PATCH", `/webhooks/${appId}/${interactionToken}/messages/@original`, body);
    },
  };
}

/** Каждый вызов тратит один из 50 подзапросов запуска (см. Counter). */
export function countedApi(api: DiscordApi, counter: Counter): DiscordApi {
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      if (!counter.can(1)) return Promise.reject(new BudgetExceeded());
      counter.spend(1);
      return f(...a);
    };
  return {
    postMessage: wrap(api.postMessage.bind(api)),
    editMessage: wrap(api.editMessage.bind(api)),
    deleteMessage: wrap(api.deleteMessage.bind(api)),
    listMessages: wrap(api.listMessages.bind(api)),
    listGuildChannels: wrap(api.listGuildChannels.bind(api)),
    createChannel: wrap(api.createChannel.bind(api)),
    createDm: wrap(api.createDm.bind(api)),
    editInteractionOriginal: wrap(api.editInteractionOriginal.bind(api)),
  };
}
