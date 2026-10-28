import { t } from './i18n.js';

// Icons are local, fixed artwork. Never interpolate a click value into SVG.
const svg = paths => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const ART = Object.freeze({
  'unknown-country': svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>'),
  'unknown-device': svg('<rect x="3" y="4" width="15" height="12" rx="2"/><path d="M7 20h7M10 16v4"/><rect x="16" y="10" width="5" height="10" rx="1"/>'),
  'unknown-os': svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01"/>'),
  'device-desktop': svg('<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>'),
  'device-mobile': svg('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4M12 19h.01"/>'),
  'device-tablet': svg('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 19h.01"/>'),
  'device-tv': svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m8 2 4 3 4-3M8 22h8M12 19v3"/>'),
  'device-console': svg('<path d="M8 7h8c3 0 4 3 5 8 .6 3-1.5 4-3 2l-2-2H8l-2 2c-1.5 2-3.6 1-3-2 1-5 2-8 5-8Z"/><path d="M7 10v4M5 12h4M16 11h.01M18 13h.01"/>'),
  'device-wearable': svg('<rect x="6" y="6" width="12" height="12" rx="3"/><path d="m8 6 1-4h6l1 4M8 18l1 4h6l1-4M12 9v3l2 1"/>'),
  'os-windows': svg('<path fill="currentColor" stroke="none" d="M3 4.5 11 3v8H3Zm10-1.8L21 1v10h-8ZM3 13h8v8l-8-1.5Zm10 0h8v10l-8-1.7Z"/>'),
  'os-android': svg('<path d="m8 5-2-3m10 3 2-3M5 11a7 7 0 0 1 14 0H5Zm1 2h12v6H6ZM8 19v3m8-3v3M3 13v5m18-5v5"/><path d="M9 8h.01M15 8h.01"/>'),
  'os-macos': svg('<path d="M12 7c-2-2-5-1.5-7 .5-3 3-1.5 8 1 11 2 2.5 3 2 6 1 3 1 4 1.5 6-1a12 12 0 0 0 2-4c-4-1-4-5-1-7-2-2-5-2.5-7-.5Z"/><path d="M12 7c0-3 1-5 4-6 0 3-1 5-4 6Z"/>'),
  'os-ios': svg('<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M12 9h.01M11 12h1v4M10 16h4M12 19h.01"/>'),
  'os-linux': svg('<path d="M8 9V7a4 4 0 0 1 8 0v2c3 3 4 7 2 10H6c-2-3-1-7 2-10Z"/><ellipse cx="12" cy="14" rx="4" ry="5"/><path d="m10 8 2 1 2-1M10 6h.01M14 6h.01M7 18l-3 3h6M17 18l3 3h-6"/>'),
  'os-chromeos': svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 8h8M8.5 14 4 7M14 15.5 10 21"/>'),
});

// ISO 3166-1 alpha-2 codes. Do not infer a country from IP, language or region.
const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const normalized = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const countries = new Map(COUNTRY_CODES.map(code => [normalized(code), code]));
if (typeof Intl.DisplayNames === 'function') {
  for (const locale of ['en', 'ru']) {
    const names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
    for (const code of COUNTRY_CODES) {
      const name = names.of(code);
      if (name) countries.set(normalized(name), code);
    }
  }
}
for (const [code, aliases] of Object.entries({
  US: ['USA', 'U.S.', 'U.S.A.', 'United States of America', 'США', 'Соединенные Штаты Америки'],
  GB: ['UK', 'U.K.', 'Great Britain', 'Britain', 'United Kingdom of Great Britain and Northern Ireland'],
  NL: ['The Netherlands'],
  AE: ['UAE', 'U.A.E.', 'ОАЭ'],
  RU: ['Russian Federation', 'Российская Федерация'],
  CZ: ['Czech Republic', 'Чешская Республика'],
  TR: ['Turkey', 'Türkiye', 'Turkiye'],
  KR: ['Republic of Korea', 'Korea, Republic of', 'Республика Корея'],
  KP: ["Korea, Democratic People's Republic of", 'DPRK', 'КНДР'],
  VN: ['Viet Nam'],
  IR: ['Iran, Islamic Republic of', 'Iran (Islamic Republic of)'],
  MD: ['Moldova, Republic of', 'Republic of Moldova'],
  TZ: ['Tanzania, United Republic of', 'United Republic of Tanzania'],
  VE: ['Venezuela, Bolivarian Republic of', 'Venezuela (Bolivarian Republic of)'],
  BO: ['Bolivia, Plurinational State of', 'Bolivia (Plurinational State of)'],
  CI: ["Cote d'Ivoire", 'Ivory Coast'],
})) for (const alias of aliases) countries.set(normalized(alias), code);

const devices = new Map();
for (const [kind, aliases] of Object.entries({
  desktop: ['desktop', 'desktop computer', 'computer', 'pc', 'laptop', 'notebook', 'netbook', 'компьютер', 'настольный компьютер', 'ноутбук'],
  mobile: ['mobile', 'mobile phone', 'phone', 'smartphone', 'feature phone', 'phablet', 'мобильный', 'мобильный телефон', 'телефон', 'смартфон'],
  tablet: ['tablet', 'планшет'],
  tv: ['tv', 'television', 'smart tv', 'smarttv', 'телевизор', 'смарт тв'],
  console: ['console', 'gaming console', 'game console', 'консоль', 'игровая консоль'],
  wearable: ['wearable', 'watch', 'smart watch', 'smartwatch', 'умные часы', 'носимое устройство'],
})) for (const alias of aliases) devices.set(alias, `device-${kind}`);

function osIcon(value) {
  // A combined cell may contain multiple OS values; never pick only the first.
  if (value.includes(',')) return 'unknown-os';
  if (/^(?:windows|microsoft windows)(?:$|[\s/(])/.test(value)) return 'os-windows';
  if (/^android(?:$|[\s/(])/.test(value)) return 'os-android';
  if (/^(?:macos|mac os(?: x)?|os x|macintosh)(?:$|[\s/(])/.test(value)) return 'os-macos';
  if (/^(?:ios|ipados|iphone os|ipad os|ipod os)(?:$|[\s/(])/.test(value)) return 'os-ios';
  if (/^(?:chrome ?os|chromium ?os|cros)(?:$|[\s/(])/.test(value)) return 'os-chromeos';
  if (/^(?:linux|ubuntu|debian|fedora|centos|red hat(?: enterprise linux)?|rhel|opensuse|suse|arch linux|gentoo|manjaro|alpine linux)(?:$|[\s/(])/.test(value)) return 'os-linux';
  return 'unknown-os';
}

/** Return local artwork plus an unescaped label for textContent/title/aria-label. */
export function describeClicklogIcon(key, value) {
  const label = typeof value === 'string' && value.trim() ? value : t('Не определено', 'Unknown');
  const name = normalized(label);
  if (key === 'country') {
    const code = countries.get(name);
    if (code) return { label, icon: `country-${code}`, emoji: [...code].map(letter => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65)).join('') };
    return { label, icon: 'unknown-country', svg: ART['unknown-country'] };
  }
  const icon = key === 'device' ? devices.get(name.replace(/[_-]/g, ' ')) || 'unknown-device' : key === 'os' ? osIcon(name) : 'unknown-os';
  return { label, icon, svg: ART[icon] };
}
