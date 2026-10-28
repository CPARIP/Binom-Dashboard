// Local extension copy only. Never translate tracker names or visitor data.
let language = 'en';
export const getLanguage = () => language;
export function setLanguage(value) { language = value === 'ru' ? 'ru' : 'en'; }
export const locale = () => language === 'ru' ? 'ru-RU' : 'en-US';
export const t = (ru, en) => language === 'ru' ? ru : en;

// Worker messages stay language-neutral at the protocol boundary (fixed codes
// and existing safe Russian copy). Translate only known UI messages locally.
const MESSAGES = new Map([
  ['Укажите HTTPS-адрес вашего Binom без пути, параметров и данных входа.', 'Enter your Binom HTTPS address without a path, query parameters or login details.'],
  ['Укажите HTTPS-адрес трекера без пути, параметров и данных входа.', 'Enter the tracker HTTPS address without a path, query parameters or login details.'],
  ['Укажите путь страницы кампаний внутри выбранного Binom.', 'Enter the campaigns page path within the selected Binom tracker.'],
  ['Некорректный часовой пояс Binom.', 'Invalid Binom time zone.'],
  ['Binom не вернул корректный часовой пояс. Проверьте настройку часового пояса в Binom и доступ API-пользователя к ней.', 'Binom did not return a valid time zone. Check its time zone setting and the API user’s access.'],
  ['Введите корректный API-ключ без пробелов и переносов строк.', 'Enter a valid API key without spaces or line breaks.'],
  ['Введите корректный API-ключ.', 'Enter a valid API key.'],
  ['Некорректный запрос расширения.', 'Invalid extension request.'],
  ['Некорректные настройки панели.', 'Invalid dashboard preferences.'],
  ['Проверьте период и фильтры отчёта.', 'Check the report period and filters.'],
  ['Некорректные параметры отчёта. Проверьте период, часовой пояс и фильтры.', 'Invalid report parameters. Check the period, time zone and filters.'],
  ['Эта страница не может выполнить запрос расширения.', 'This page cannot make an extension request.'],
  ['Разрешите расширению доступ к выбранному сайту Binom.', 'Allow the extension to access the selected Binom site.'],
  ['Подключите Binom в настройках расширения.', 'Connect Binom in the extension settings.'],
  ['Разблокируйте сохранённый ключ или введите API-ключ в настройках расширения.', 'Unlock the saved key or enter an API key in the extension settings.'],
  ['Пароль должен содержать от 12 до 256 символов.', 'The password must contain 12 to 256 characters.'],
  ['Сохранённый ключ повреждён или относится к другому подключению. Подключите Binom заново.', 'The saved key is damaged or belongs to another connection. Reconnect Binom.'],
  ['Не удалось разблокировать ключ. Проверьте пароль; если он забыт, подключите Binom заново с API-ключом.', 'Could not unlock the key. Check the password; if you forgot it, reconnect Binom using the API key.'],
  ['Нет сохранённого ключа. Подключите Binom и выберите сохранение с паролем.', 'No saved key. Connect Binom and choose password-protected storage.'],
  ['Подключение изменилось. Обновите панель.', 'The connection changed. Refresh the dashboard.'],
  ['Дашборд отключён. Включите его в меню расширения.', 'The dashboard is disabled. Enable it in the extension menu.'],
  ['Не удалось подключиться к Binom. Проверьте адрес и доступность сервера.', 'Could not connect to Binom. Check the address and server availability.'],
  ['Не удалось связаться с Binom. Проверьте адрес, HTTPS и разрешение расширения.', 'Could not reach Binom. Check the address, HTTPS and extension permission.'],
  ['Binom не ответил вовремя. Повторите запрос.', 'Binom did not respond in time. Try again.'],
  ['Binom не ответил вовремя. Попробуйте меньший период.', 'Binom did not respond in time. Try a shorter period.'],
  ['Binom отклонил API-ключ. Проверьте ключ в настройках.', 'Binom rejected the API key. Check it in settings.'],
  ['Binom не принял API-ключ. Проверьте ключ в настройках расширения.', 'Binom rejected the API key. Check it in the extension settings.'],
  ['У пользователя API недостаточно прав для запрошенных данных.', 'The API user does not have permission to access the requested data.'],
  ['У пользователя Binom нет доступа к этим данным.', 'The Binom user does not have access to this data.'],
  ['Binom ограничил частоту запросов. Попробуйте позже.', 'Binom limited the request rate. Try again later.'],
  ['Binom ограничил частоту запросов. Подождите перед обновлением.', 'Binom limited the request rate. Wait before refreshing.'],
  ['Ответ Binom не соответствует ожидаемому формату.', 'The Binom response does not match the expected format.'],
  ['Binom вернул неожиданный формат данных. Возможно, требуется обновление адаптера.', 'Binom returned an unexpected data format. The adapter may need an update.'],
  ['Binom не смог сформировать отчёт.', 'Binom could not generate the report.'],
  ['Binom не смог выполнить запрос. Проверьте доступность Public API и выбранные фильтры.', 'Binom could not complete the request. Check Public API availability and the selected filters.'],
  ['Binom вернул неполные данные отчёта.', 'Binom returned incomplete report data.'],
  ['Binom не прислал отметку «Бот» для кликов, поэтому «Без ботов» не применить к журналу. Включите колонку «Бот» в настройках таблицы журнала кликов у API-пользователя Binom или выключите фильтр.', 'Binom did not send the “Bot” mark for clicks, so “Exclude bots” cannot be applied to the click log. Enable the Bot column in the click log table settings of the Binom API user, or turn the filter off.'],
  ['Binom повторил страницу отчёта. Не удалось подтвердить полноту данных за выбранный период.', 'Binom repeated a report page. Completeness for the selected period could not be verified.'],
  ['Не удалось получить полный отчёт. Итоги не показаны. Сократите период или фильтры.', 'Could not retrieve a complete report. Totals are not shown. Narrow the period or filters.'],
  ['Binom повторил уже полученные строки. Полнота отчёта не подтверждена; итоги не показаны.', 'Binom repeated previously received rows. Completeness is unverified; totals are not shown.'],
  ['Отчёт превысил предел загрузки. Сократите период или фильтры.', 'The report exceeded the download limit. Narrow the period or filters.'],
  ['Отчёт превысил безопасный предел загрузки. Сократите период или фильтры.', 'The report exceeded the safe download limit. Narrow the period or filters.'],
  ['Не удалось выполнить действие. Повторите попытку.', 'Could not complete the action. Try again.'],
  ['Некоторые показатели отсутствуют в ответе Binom или скрыты правами/настройками колонок. Они показаны как «—».', 'Some metrics are missing from the Binom response or hidden by permissions or column settings. They are shown as “—”.'],
  ['Для некоторых временных интервалов Binom не вернул строки. На графике оставлены пропуски; итоги рассчитаны по полученным строкам.', 'Binom did not return rows for some intervals. The chart retains gaps; totals use the received rows.'],
  ['Формат временных меток Binom не позволяет надёжно совместить периоды. Сравнение не показано.', 'The Binom timestamp format does not allow reliable period alignment. Comparison is not shown.'],
  ['Не удалось полностью загрузить предыдущий период. Сравнение не показано.', 'Could not load the complete previous period. Comparison is not shown.'],
  ['Список групп недоступен. Фильтр по группам не загружен.', 'The group list is unavailable. The group filter could not be loaded.'],
  ['Список источников недоступен. Фильтр по источникам не загружен.', 'The source list is unavailable. The source filter could not be loaded.'],
  ['У некоторых кампаний недоступны данные группы. Все кампании остаются в списке выбора.', 'Group data is unavailable for some campaigns. All campaigns remain in the selector.'],
  ['Часть кампаний не удалось загрузить. Ошибки показаны отдельно; доступные кампании остаются на графике.', 'Some campaigns could not be loaded. Their errors are shown separately; available campaigns remain on the chart.'],
  ['Выбранные кампании', 'Selected campaigns'],
  ['Все доступные кампании · независимо от статуса', 'All accessible campaigns · regardless of status'],
  ['В выбранной области нет доступных кампаний. Отсутствующие показатели показаны как «—».', 'No accessible campaigns in the selected scope. Missing metrics are shown as “—”.'],
  ['Расширение обновлено. Перезагрузите страницу Binom.', 'The extension was updated. Reload the Binom page.'],
  ['Не удалось загрузить статистику.', 'Could not load statistics.'],
  ['Разблокируйте сохранённый ключ паролем в настройках расширения.', 'Unlock the saved key with your password in the extension settings.'],
  ['Введите API-ключ в настройках расширения. Можно сохранить его с паролем.', 'Enter the API key in the extension settings. You can save it with a password.'],
]);

export function translateMessage(message) {
  const text = String(message ?? '');
  if (language === 'ru') return text;
  if (MESSAGES.has(text)) return MESSAGES.get(text);
  const diagnostic = /^(.*) Код: ([a-z-]+)\.$/.exec(text);
  if (diagnostic && MESSAGES.has(diagnostic[1])) return `${MESSAGES.get(diagnostic[1])} Code: ${diagnostic[2]}.`;
  return text;
}
