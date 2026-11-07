// Минимальные типы Discord, нужные боту (не вся схема API).

export interface Button {
  type: 2;
  /** 1 основная, 2 серая, 3 зелёная, 4 красная */
  style: 1 | 2 | 3 | 4;
  label: string;
  custom_id: string;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export interface StringSelect {
  type: 3;
  custom_id: string;
  placeholder?: string;
  options: SelectOption[];
  min_values?: number;
  max_values?: number;
}

export interface ActionRow {
  type: 1;
  components: (Button | StringSelect)[];
}

export interface MessageBody {
  content?: string;
  components?: ActionRow[];
  allowed_mentions?: { parse?: string[]; users?: string[] };
  /** 64 = виден только вам; 4096 = без уведомления */
  flags?: number;
}

export interface SentMessage {
  id: string;
  channel_id: string;
}

export interface IncomingMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; bot?: boolean };
  attachments?: unknown[];
}

export interface GuildChannel {
  id: string;
  name: string;
  /** 0 текстовый, 4 категория, 15 форум */
  type: number;
  parent_id?: string | null;
}

export class DiscordError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(status: number, message: string, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Всё, что бот делает через REST. Настоящая реализация — api.ts, в тестах подставляется поддельная. */
export interface DiscordApi {
  postMessage(channelId: string, body: MessageBody): Promise<SentMessage>;
  editMessage(channelId: string, messageId: string, body: MessageBody): Promise<void>;
  /** Удаление без ошибки, если сообщения уже нет. */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /** Новые сообщения после `after` по возрастанию id. */
  listMessages(channelId: string, after: string | null, limit: number): Promise<IncomingMessage[]>;
  listGuildChannels(guildId: string): Promise<GuildChannel[]>;
  createChannel(guildId: string, body: { name: string; type: number; topic?: string }): Promise<{ id: string }>;
  createDm(userId: string): Promise<{ id: string }>;
  /** Правка ответа на команду после «отложенного» ответа. */
  editInteractionOriginal(appId: string, token: string, body: MessageBody): Promise<void>;
}
