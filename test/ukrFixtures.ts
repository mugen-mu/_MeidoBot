// Образцы ленты Укрэнерго (t.me/s/Ukrenergo) для тестов: разметка — как у настоящей страницы (проверено 2026-11-15),
// тексты — короткие, свои, в том же стиле (настоящие сообщения в репозиторий не копируем).

/** Момент публикации в виде, как его пишет Telegram: 2026-11-15T10:04:00+00:00 */
const stamp = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "+00:00");

export interface FixturePost {
  id: number;
  at: number;
  /** html внутри блока текста; null — пост без текста (одна картинка) */
  html: string | null;
}

/** Одна страница ленты: те же вложенные блоки, что у настоящей (обёртка, шапка, текст, подвал со временем). */
export function ukrPage(posts: FixturePost[]): string {
  const body = posts
    .map((p) => {
      const text = p.html === null ? "" : `<div class="tgme_widget_message_text js-message_text" dir="auto">${p.html}</div>`;
      return (
        `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="Ukrenergo/${p.id}" data-view="abc">` +
        `<div class="tgme_widget_message_user"><a href="https://t.me/Ukrenergo"><i class="tgme_widget_message_user_photo bgcolor0" data-content="У"></i></a></div>` +
        `<div class="tgme_widget_message_bubble"><div class="tgme_widget_message_author accent_color"><a class="tgme_widget_message_owner_name" href="https://t.me/Ukrenergo"><span dir="auto">Укренерго</span></a></div>` +
        `${text}` +
        `<div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info"><span class="tgme_widget_message_views">35.8K</span>` +
        `<span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/Ukrenergo/${p.id}"><time datetime="${stamp(p.at)}" class="time">12:04</time></a></span></div></div>` +
        `</div></div></div>`
      );
    })
    .join("\n");
  return `<html><head><title>Укренерго – Telegram</title></head><body><div class="tgme_channel_info_header_title">Укренерго</div>${body}</body></html>`;
}

const emoji = '<i class="emoji" style="background-image:url(\'//telegram.org/img/emoji/40/E29D97.png\')"><b>❗️</b></i>';

/** Аварийные отключения в нашей области (и в соседней). */
export const EMERGENCY_HTML =
  `<b>${emoji}УВАГА! АВАРІЙНІ ВІДКЛЮЧЕННЯ</b><br/><br/>На цю годину у Дніпропетровській та Харківській областях вимушено запроваджені аварійні відключення електроенергії.<br/><br/>` +
  "Попередньо оприлюднені графіки у цих регіонах наразі не діють. Відключення будуть скасовані, щойно це дозволить стан енергосистеми.";

/** Последствия атак: наша область названа, слов «аварійні відключення» нет. Маркеры списка — с невидимыми знаками, как в Telegram. */
export const REGION_HTML =
  "Через ворожі атаки на енергооб&#39;єкти на ранок є знеструмлення у Київській, Дніпропетровській та Одеській областях. Найскладніша ситуація на Дніпропетровщині.<br/><br/>" +
  "Енергетики цілодобово відновлюють пошкоджене обладнання. Аварійно-відновлювальні роботи проводяться всюди, де це дозволяє безпекова ситуація.<br/><br/>" +
  "•⁠ ⁠для промисловості — графіки обмеження потужності;<br/>•⁠ ⁠для всіх споживачів — графіки погодинних відключень";

/** Обычное «завтра у частині областей» — без названия областей: график опубликует Yasno. */
export const PLANNED_HTML = `${emoji}<b>Інформація про відключення електроенергії</b><br/><br/>Завтра у частині областей діятимуть графіки погодинних відключень.<br/><br/>Причина – наслідки атак на енергосистему.`;

/** Аварийные отключения, но не у нас. */
export const OTHER_REGION_HTML = "У Харківській та Сумській областях вимушено запроваджені аварійні відключення електроенергії.";

/** Аварийные отключения по всей стране. */
export const ALL_HTML = "По всій території України вимушено запроваджені екстрені відключення електроенергії до зміни ситуації.";

/** Новость компании без отключений. */
export const NEWS_HTML = "Вирва розміром з будинок утворилась після удару по підстанції. Ремонтні бригади працюють цілодобово.";
