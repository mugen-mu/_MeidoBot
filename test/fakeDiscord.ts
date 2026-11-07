// Поддельный Discord для тестов и сухого прогона: записывает всё, что бот «отправил».
import {
  DiscordError,
  type DiscordApi,
  type GuildChannel,
  type IncomingMessage,
  type MessageBody,
} from "../src/discord/types.ts";

export interface Posted {
  id: string;
  channel: string;
  body: MessageBody;
  deleted: boolean;
}

export class FakeDiscord implements DiscordApi {
  seq = 1000;
  posted: Posted[] = [];
  edits: { channel: string; id: string; body: MessageBody }[] = [];
  deletes: { channel: string; id: string }[] = [];
  reactions: { channel: string; id: string; emoji: string }[] = [];
  /** входящие сообщения по каналам (для приёма текста) */
  inbox = new Map<string, IncomingMessage[]>();
  channels: GuildChannel[] = [];
  created: { name: string; type: number }[] = [];
  /** ближайшие N вызовов отправки завершатся ошибкой с этим статусом */
  failPost: { status: number; times: number } | null = null;
  originals: { appId: string; token: string; body: MessageBody }[] = [];
  calls = 0;

  private nextId(): string {
    return String(++this.seq);
  }

  async postMessage(channelId: string, body: MessageBody) {
    this.calls++;
    if (this.failPost && this.failPost.times > 0) {
      this.failPost.times--;
      throw new DiscordError(this.failPost.status, `Discord ${this.failPost.status}`, this.failPost.status === 429 ? 1 : null);
    }
    const id = this.nextId();
    this.posted.push({ id, channel: channelId, body, deleted: false });
    return { id, channel_id: channelId };
  }
  async editMessage(channelId: string, messageId: string, body: MessageBody) {
    this.calls++;
    if (!this.posted.some((p) => p.id === messageId)) throw new DiscordError(404, "Unknown Message");
    this.edits.push({ channel: channelId, id: messageId, body });
  }
  async deleteMessage(channelId: string, messageId: string) {
    this.calls++;
    this.deletes.push({ channel: channelId, id: messageId });
    const p = this.posted.find((x) => x.id === messageId);
    if (p) p.deleted = true;
  }
  async addReaction(channelId: string, messageId: string, emoji: string) {
    this.calls++;
    this.reactions.push({ channel: channelId, id: messageId, emoji });
  }
  async listMessages(channelId: string, after: string | null, limit: number) {
    this.calls++;
    const all = this.inbox.get(channelId) ?? [];
    if (after === null) return all.slice(-limit);
    return all.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit);
  }
  async listGuildChannels() {
    this.calls++;
    return this.channels;
  }
  async createChannel(_guildId: string, body: { name: string; type: number }) {
    this.calls++;
    const id = this.nextId();
    this.created.push(body);
    this.channels.push({ id, name: body.name, type: body.type });
    return { id };
  }
  async createDm(userId: string) {
    this.calls++;
    return { id: `dm-${userId}` };
  }
  async editInteractionOriginal(appId: string, token: string, body: MessageBody) {
    this.calls++;
    this.originals.push({ appId, token, body });
  }

  /** Добавить входящее сообщение в канал. */
  say(channel: string, authorId: string, content: string, opts: { bot?: boolean; /** время отправки, мс */ at?: number; /** ответ на сообщение с этим id */ ref?: string } = {}): IncomingMessage {
    const m: IncomingMessage = {
      id: this.nextId(),
      channel_id: channel,
      content,
      author: { id: authorId, bot: opts.bot },
      attachments: [],
      ...(opts.at !== undefined ? { timestamp: new Date(opts.at).toISOString() } : {}),
      ...(opts.ref ? { message_reference: { message_id: opts.ref } } : {}),
    };
    this.inbox.set(channel, [...(this.inbox.get(channel) ?? []), m]);
    return m;
  }

  /** Актуальные (не удалённые) сообщения канала. */
  live(channel: string): Posted[] {
    return this.posted.filter((p) => p.channel === channel && !p.deleted);
  }
}
