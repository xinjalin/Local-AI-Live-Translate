// Checks the extension's translations (run by the GitHub checks, or: node tools/check_i18n.js).
//  - every key the code or HTML uses exists in English
//  - every popup language has exactly the English keys
//  - each translation keeps the English text's {placeholders}
const fs = require('fs');
const path = require('path');

const ext = path.join(__dirname, '..', 'extension');
const src = fs.readFileSync(path.join(ext, 'i18n.js'), 'utf8').replace(/^const /gm, 'var ');
const ctx = {};
new Function('ctx', `${src}; ctx.I18N = LC_I18N; ctx.UI = LC_UI_LANGS;`)(ctx);
const en = ctx.I18N.en;
const errors = [];

// Keys used by the code and pages
const used = new Set();
for (const f of fs.readdirSync(ext).filter(name => /\.(js|html)$/.test(name))) {
  const text = fs.readFileSync(path.join(ext, f), 'utf8');
  if (f.endsWith('.js') && f !== 'i18n.js') {
    for (const re of [/\bt\(\s*'([A-Za-z0-9]+)'/g, /lcTranslate\([^,]+,\s*'([A-Za-z0-9]+)'/g, /flash\(\s*'([A-Za-z0-9]+)'/g]) {
      for (const m of text.matchAll(re)) used.add(m[1]);
    }
  } else if (f.endsWith('.html')) {
    for (const m of text.matchAll(/data-(?:first-)?i18n(?:-title|-placeholder)?="([A-Za-z0-9]+)"/g)) used.add(m[1]);
  }
}
for (const key of used) if (!(key in en)) errors.push(`used but not defined in English: ${key}`);

const placeholders = (s) => (s.match(/\{[a-z]+\}/gi) || []).sort().join(' ');
for (const lang of ctx.UI) {
  const dict = ctx.I18N[lang];
  if (!dict) {
    errors.push(`${lang}: no translations`);
    continue;
  }
  for (const key of Object.keys(en)) {
    if (!(key in dict)) errors.push(`${lang}: missing ${key}`);
    else if (placeholders(dict[key]) !== placeholders(en[key])) errors.push(`${lang}.${key}: placeholders differ from English`);
  }
  for (const key of Object.keys(dict)) if (!(key in en)) errors.push(`${lang}: extra key ${key}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Translations OK: ${Object.keys(en).length} keys x ${ctx.UI.length} languages, ${used.size} used by the extension.`);
