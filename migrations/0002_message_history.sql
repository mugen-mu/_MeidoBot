-- Прежние копии сообщения-напоминания: лестница удаляет старую копию и ставит новую,
-- а ответ (Reply) пользователя может ссылаться на уже удалённую. По id сообщения находим дело.
-- Текста сообщений здесь нет, только id.
CREATE TABLE occ_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  occ_id     INTEGER NOT NULL REFERENCES occurrences(id) ON DELETE CASCADE,
  sent_at    INTEGER NOT NULL
);
CREATE INDEX idx_occmsg_occ ON occ_messages(occ_id);
CREATE INDEX idx_occmsg_sent ON occ_messages(sent_at);
