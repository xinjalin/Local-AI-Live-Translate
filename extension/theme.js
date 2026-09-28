// Popup theme (shared by popup.js and import.js).
//
// Most built-in themes are sets of colour tokens in popup.css, picked with data-theme on <html>.
// Dark and Light (the default) also change the layout: they set data-layout="studio" (popup.css,
// "Studio layout"). The Custom theme is made here from a few colours the user picks: every token is
// worked out from them and set on <html>, so the rest of the CSS doesn't know the difference. The
// Sakura themes are made the same way, from fixed colours (LC_PRESET_THEMES). A Custom theme's
// style: "Studio" has the layout of Dark / Light, "Glass" the glowing background and see-through
// panels of Glass Dark / Glass Light, "Flat" the solid surfaces of the OLED themes.

const LC_THEMES = ['dark', 'light', 'glass-dark', 'glass-light', 'sakura-light', 'sakura-dark', 'oled-light', 'oled-dim', 'oled-black', 'system', 'custom'];
// Themes with the studio layout
const LC_STUDIO_THEMES = ['dark', 'light'];
// Built-in themes made from their LC_THEME_SEEDS colours (not in popup.css).
const LC_PRESET_THEMES = ['sakura-light', 'sakura-dark'];
const LC_THEME_STYLES = ['studio', 'glass', 'flat'];
// In the order the popup shows them: surfaces, then text.
const LC_THEME_COLOR_KEYS = ['background', 'panel', 'accent', 'button', 'heading', 'label', 'text', 'muted', 'field'];

// A built-in theme's colours, for starting a custom one from it.
const LC_THEME_SEEDS = {
  dark: {
    style: 'studio', background: '#111111', panel: '#1a1a1a', accent: '#a8c5da', button: '#e3f5ff',
    heading: '#ffffff', label: '#a3a3a3', text: '#ffffff', muted: '#9e9e9e', field: '#ffffff'
  },
  light: {
    style: 'studio', background: '#ffffff', panel: '#f7f9fb', accent: '#4f7fa3', button: '#1c1c1c',
    heading: '#1c1c1c', label: '#626262', text: '#1c1c1c', muted: '#6b6b6b', field: '#1c1c1c'
  },
  'glass-dark': {
    style: 'glass', background: '#0b0a10', panel: '#16151c', accent: '#8b5cf6', button: '#ffffff',
    heading: '#8f8b9c', label: '#8f8b9c', text: '#ecebf1', muted: '#8f8b9c', field: '#ecebf1'
  },
  'glass-light': {
    style: 'glass', background: '#f5f3fb', panel: '#ffffff', accent: '#7c3aed', button: '#16141d',
    heading: '#6d6a7a', label: '#6d6a7a', text: '#16141d', muted: '#6d6a7a', field: '#16141d'
  },
  // Cherry blossom: petal pinks on a blush page (light) or a plum night (dark).
  'sakura-light': {
    style: 'glass', background: '#fdf0f5', panel: '#fffafc', accent: '#e05a8d', button: '#b8336c',
    heading: '#b0577f', label: '#86707c', text: '#35202b', muted: '#8f7784', field: '#35202b'
  },
  'sakura-dark': {
    style: 'glass', background: '#150b12', panel: '#23141e', accent: '#f07aa6', button: '#ffd3e3',
    heading: '#e8a3bf', label: '#b89dab', text: '#fbeaf1', muted: '#a58c99', field: '#fbeaf1'
  },
  'oled-light': {
    style: 'flat', background: '#ffffff', panel: '#ffffff', accent: '#1d9bf0', button: '#1d9bf0',
    heading: '#536471', label: '#536471', text: '#0f1419', muted: '#536471', field: '#0f1419'
  },
  'oled-dim': {
    style: 'flat', background: '#15202b', panel: '#1e2732', accent: '#1d9bf0', button: '#1d9bf0',
    heading: '#8b98a5', label: '#8b98a5', text: '#f7f9f9', muted: '#8b98a5', field: '#f7f9f9'
  },
  'oled-black': {
    style: 'flat', background: '#000000', panel: '#000000', accent: '#1d9bf0', button: '#1d9bf0',
    heading: '#71767b', label: '#71767b', text: '#e7e9ea', muted: '#71767b', field: '#e7e9ea'
  }
};

// { base, style, ...colours } from anything (storage, an imported file): unknown or broken values
// are replaced by the base theme's.
function lcSanitizeCustomTheme(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = LC_THEME_SEEDS[src.base] ? src.base : 'dark';
  const seed = LC_THEME_SEEDS[base];
  const out = { base, style: LC_THEME_STYLES.includes(src.style) ? src.style : seed.style };
  for (const key of LC_THEME_COLOR_KEYS) {
    const v = src[key];
    out[key] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : seed[key];
  }
  return out;
}

function lcCustomThemeFrom(base) {
  const seed = LC_THEME_SEEDS[base] ? base : 'dark';
  return { base: seed, ...LC_THEME_SEEDS[seed] };
}

// --- colour arithmetic ------------------------------------------------------

function lcRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lcHex(rgb) {
  return '#' + rgb.map(c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
}

// `amount` of b mixed into a.
function lcMix(a, b, amount) {
  const x = lcRgb(a), y = lcRgb(b);
  return lcHex(x.map((c, i) => c + (y[i] - c) * amount));
}

function lcAlpha(hex, alpha) {
  return `rgba(${lcRgb(hex).join(', ')}, ${alpha})`;
}

function lcLuminance(hex) {
  const [r, g, b] = lcRgb(hex).map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function lcContrast(a, b) {
  const [hi, lo] = [lcLuminance(a), lcLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Dark colour: white text reads better on it than black.
function lcIsDark(hex) {
  return lcContrast(hex, '#ffffff') > lcContrast(hex, '#000000');
}

// The colour itself when it can be read on `bg`; else moved towards white or black until it can,
// so a picked colour never makes text disappear (e.g. dark text on a dark background).
function lcReadable(color, bg, min = 3) {
  if (lcContrast(color, bg) >= min) return color;
  const toward = lcIsDark(bg) ? '#ffffff' : '#000000';
  for (let amount = 0.1; amount < 1; amount += 0.1) {
    const c = lcMix(color, toward, amount);
    if (lcContrast(c, bg) >= min) return c;
  }
  return toward;
}

function lcChevron(hex) {
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23${hex.slice(1)}' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`;
}

// --- the tokens ---------------------------------------------------------------

// Every popup.css token for a custom theme.
function lcCustomThemeTokens(raw) {
  const c = lcSanitizeCustomTheme(raw);
  const glass = c.style === 'glass';
  const B = c.background, P = c.panel, A = c.accent, T = c.text;
  const darkPage = lcIsDark(B);
  const darkPanel = lcIsDark(P);
  const white = '#ffffff', black = '#000000';

  const pageText = lcReadable(T, B, 4.5);
  const panelText = lcReadable(T, P, 4.5);
  const panelMuted = lcReadable(c.muted, P);
  const heroBg = glass ? P : lcMix(P, T, 0.07);
  const fieldBg = lcMix(P, T, 0.03);
  const fieldText = lcReadable(c.field, fieldBg, 4.5);
  const segBg = lcMix(P, B, 0.35);
  const iconBg = lcMix(P, T, 0.07);
  const menuBg = darkPanel ? lcMix(P, T, 0.04) : P;
  const trueBlack = lcLuminance(P) < 0.005;
  const accentOn = (bg) => lcReadable(darkPanel ? lcMix(A, white, 0.25) : A, bg);
  const danger = darkPanel ? '#f87171' : '#dc2626';

  return {
    '--scheme-page': darkPage ? 'dark' : 'light',
    '--scheme-panel': darkPanel ? 'dark' : 'light',

    '--page-bg': B,
    '--page-glow': glass
      ? `radial-gradient(120% 55% at 105% 105%, ${lcAlpha(A, darkPage ? 0.42 : 0.2)}, transparent 62%), ` +
        `radial-gradient(90% 40% at -10% -5%, ${lcAlpha(A, darkPage ? 0.14 : 0.12)}, transparent 60%)`
      : 'none',
    '--text': pageText,
    '--text-muted': lcReadable(c.muted, B),

    '--accent': accentOn(P),
    '--accent-strong': A,
    '--accent-soft': lcAlpha(A, 0.13),
    '--accent-soft-border': lcAlpha(A, 0.38),
    '--logo-left-a': lcMix(A, white, 0.3),
    '--logo-left-b': lcMix(A, black, 0.3),
    '--logo-right': darkPage ? lcMix(B, white, 0.12) : lcMix(A, white, 0.88),
    '--logo-a': white,
    '--logo-wen': darkPage ? lcMix(A, white, 0.5) : lcMix(A, black, 0.3),
    '--logo-edge': darkPage ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',

    // (glass: dark cards are lit from the top-left, light ones are tinted with the accent, as in
    // the Dark and Light themes)
    '--hero-bg': !glass ? heroBg : darkPanel
      ? `linear-gradient(150deg, ${lcMix(P, T, 0.1)} 0%, ${P} 55%, ${lcMix(P, B, 0.4)} 100%)`
      : `linear-gradient(150deg, ${P} 0%, ${lcMix(P, A, 0.06)} 55%, ${lcMix(P, A, 0.13)} 100%)`,
    '--hero-sheen': glass ? `radial-gradient(85% 70% at 25% -10%, ${lcAlpha(A, 0.22)}, transparent 60%)` : 'none',
    '--hero-border': lcAlpha(T, 0.1),
    '--hero-text': lcReadable(T, heroBg, 4.5),
    '--hero-muted': lcReadable(c.muted, heroBg),
    '--hero-accent': accentOn(heroBg),
    '--hero-shadow': !glass ? 'none' : darkPage ? '0 18px 40px rgba(0, 0, 0, 0.45)' : `0 16px 36px ${lcAlpha(A, 0.12)}`,

    '--panel-bg': glass ? lcAlpha(P, 0.6) : P,
    '--panel-border': glass ? lcAlpha(T, 0.08) : lcMix(P, T, 0.16),
    '--panel-text': panelText,
    '--panel-muted': panelMuted,
    '--heading': lcReadable(c.heading, P),
    '--label-text': lcReadable(c.label, P),
    '--field-bg': fieldBg,
    '--field-border': lcAlpha(T, 0.1),
    '--field-text': fieldText,
    '--field-placeholder': lcMix(fieldText, fieldBg, 0.5),
    '--focus-ring': lcAlpha(A, 0.35),
    '--chevron': lcChevron(lcReadable(c.muted, fieldBg)),

    '--seg-bg': segBg,
    '--seg-border': lcAlpha(T, 0.08),
    '--seg-text': lcReadable(lcMix(T, c.muted, 0.5), segBg),
    '--seg-active-bg': lcAlpha(A, 0.16),
    '--seg-active-border': lcAlpha(A, 0.45),
    '--seg-active-text': accentOn(segBg),

    '--btn-bg': c.button,
    '--btn-text': lcIsDark(c.button) ? white : '#0b0a10',
    '--btn-shadow': !glass ? 'none' : darkPage ? '0 10px 26px rgba(0, 0, 0, 0.35)' : `0 8px 20px ${lcAlpha(c.button, 0.25)}`,
    '--btn-stop-bg': lcAlpha(danger, 0.12),
    '--btn-stop-border': lcAlpha(danger, 0.45),
    '--btn-stop-text': danger,
    '--icon-bg': iconBg,
    '--icon-text': accentOn(iconBg),
    '--switch-off': lcMix(P, T, 0.18),
    '--switch-on': A,
    '--switch-knob': white,

    '--success': darkPanel ? '#34d399' : '#059669',
    '--warning': darkPanel ? '#fbbf24' : '#d97706',
    '--danger': danger,
    '--chip-bg': lcAlpha(T, 0.07),
    '--chip-text': lcReadable(c.muted, heroBg),
    '--chip-live-bg': lcAlpha(A, 0.16),
    '--rec-dot': darkPanel ? '#c0265f' : '#9d1747',
    '--rec-dot-bright': darkPanel ? '#e0306f' : '#c21f5a',
    '--rec-glow': darkPanel ? 'rgba(224, 48, 111, 0.45)' : 'rgba(194, 31, 90, 0.35)',
    '--chip-live-text': accentOn(heroBg),

    '--menu-bg': menuBg,
    '--menu-border': lcAlpha(T, 0.1),
    '--menu-text': lcReadable(c.field, menuBg, 4.5),
    '--menu-muted': lcReadable(c.muted, menuBg),
    '--menu-active': lcAlpha(A, 0.16),
    '--menu-mark': accentOn(menuBg),
    // (on true black a dark shadow is invisible: a faint light halo separates the menu instead)
    '--menu-shadow': trueBlack
      ? '0 0 15px rgba(255, 255, 255, 0.12), 0 0 3px rgba(255, 255, 255, 0.1)'
      : darkPanel ? '0 16px 40px rgba(0, 0, 0, 0.55)' : '0 16px 36px rgba(0, 0, 0, 0.16)'
  };
}

// Show `theme` ('system' follows the OS; 'custom' uses `custom`'s colours).
let lcCustomTokenNames = [];
function lcApplyTheme(theme, custom) {
  const root = document.documentElement;
  for (const name of lcCustomTokenNames) root.style.removeProperty(name);
  lcCustomTokenNames = [];
  if (!LC_THEMES.includes(theme)) theme = 'dark';
  if (theme === 'system') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.dataset.theme = theme;
  const studio = LC_STUDIO_THEMES.includes(theme) || (theme === 'custom' && lcSanitizeCustomTheme(custom).style === 'studio');
  if (studio) root.dataset.layout = 'studio';
  else delete root.dataset.layout;
  if (theme !== 'custom' && !LC_PRESET_THEMES.includes(theme)) return;
  const tokens = lcCustomThemeTokens(theme === 'custom' ? custom : lcCustomThemeFrom(theme));
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  lcCustomTokenNames = Object.keys(tokens);
}
