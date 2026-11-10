// «Всё со звуком» (D7, решение пользователя 2026-11-10): по галочке в настройках сообщения бота в канал уходят с упоминанием
// хозяина — телефон подаёт звук не только на настоящие напоминания, но и на сводки, подтверждения, вопросы и реплики Хару.
// По умолчанию выключено: правило «звук только для настоящего» остаётся стартовым.
import type { DiscordApi, MessageBody } from "./discord/types.ts";

/** Тот же бот, но каждое новое сообщение в канал начинается с упоминания хозяина (если его там ещё нет). Правка и удаление не меняются. */
export function withSound(api: DiscordApi, ownerId: string | undefined, on: boolean, skipChannels: string[] = []): DiscordApi {
  if (!on || !ownerId) return api;
  const mention = `<@${ownerId}>`;
  const loud = (body: MessageBody): MessageBody => {
    const text = body.content ?? "";
    const already = text.includes(mention);
    const am = body.allowed_mentions ?? { parse: [] };
    return {
      ...body,
      content: already ? text : text ? `${mention} ${text}` : mention,
      allowed_mentions: { ...am, users: [...new Set([...(am.users ?? []), ownerId])] },
    };
  };
  // Object.create: все прочие вызовы (правка, удаление, чтение) идут к прежнему api без изменений
  return Object.create(api, {
    postMessage: {
      value: (channelId: string, body: MessageBody) => api.postMessage(channelId, skipChannels.includes(channelId) ? body : loud(body)),
    },
  }) as DiscordApi;
}
