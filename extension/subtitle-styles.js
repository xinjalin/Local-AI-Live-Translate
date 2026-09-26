// Subtitle appearance, shared by the subtitle overlay (content script) and the popup's preview,
// so both always draw the box the same way.

// Default for every subtitle setting kept in chrome.storage.local.
const LC_SUBTITLE_DEFAULTS = {
  bgColor: '#0a0f19',
  textColor: '#ffffff',
  bgOpacity: 82,               // %
  fontSize: 'medium',
  fontFamily: 'system',
  fontWeight: 'bold',
  textShadow: 'medium',
  shadowColor: '#000000',      // used by the soft / medium / strong shadow styles
  outlineColor: '#000000',     // outline colour and width (px), used when textShadow is 'outline'
  outlineWidth: 1.5,
  originalPlacement: 'above',  // original line above / below the translation
  originalScale: 70,           // original line size, % of the translation
  subtitlePosition: 'bottom',  // bottom | top | custom (where it was last dragged)
  subtitleX: null,             // custom position: left / top edge as a fraction of the viewport
  subtitleY: null,
  historyLines: 0,
  pinSubtitles: false,
  holdTime: 1.5,               // s a line stays up after the speech it belongs to
  minDisplay: 3                // s a line stays up at least
};

// px size of the main (translated) line.
const LC_FONT_SIZES = {
  xsmall: 14,
  small: 16,
  medium: 19,
  large: 24,
  xlarge: 28,
  xxlarge: 34,
  huge: 42
};

// Only fonts that ship with the operating system: the overlay runs inside other websites, where
// downloading web fonts can be blocked by the page. Each stack lists the Windows / macOS / Linux
// equivalents and ends in a generic family, so every browser finds a match; Chinese, Japanese and
// Korean characters fall back to the system's CJK font automatically.
const LC_FONTS = {
  system: { label: null, stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif' },
  arial: { label: 'Arial', stack: 'Arial, Helvetica, "Liberation Sans", "Noto Sans", sans-serif' },
  verdana: { label: 'Verdana', stack: 'Verdana, Geneva, "DejaVu Sans", sans-serif' },
  tahoma: { label: 'Tahoma', stack: 'Tahoma, "Segoe UI", Geneva, "DejaVu Sans", sans-serif' },
  trebuchet: { label: 'Trebuchet MS', stack: '"Trebuchet MS", "Lucida Grande", "Lucida Sans Unicode", "DejaVu Sans", sans-serif' },
  georgia: { label: 'Georgia', stack: 'Georgia, "DejaVu Serif", "Noto Serif", serif' },
  times: { label: 'Times New Roman', stack: '"Times New Roman", Times, "Liberation Serif", "Noto Serif", serif' },
  courier: { label: 'Courier New', stack: '"Courier New", Courier, "Liberation Mono", "DejaVu Sans Mono", monospace' }
};

const LC_FONT_WEIGHTS = { bold: 700, semibold: 600, normal: 400 };

const LC_TEXT_SHADOW_STYLES = ['off', 'soft', 'medium', 'strong', 'outline'];

// An outline of `width` px: copies of the text shadow placed in a ring around each glyph
// (16 around for thick outlines so there are no gaps), plus a soft edge to smooth it.
function lcOutline(width, color) {
  const w = Math.max(Number(width) || 0, 0);
  if (!w) return 'none';
  const steps = w > 2 ? 16 : 8;
  const parts = [];
  for (let i = 0; i < steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    const x = +(Math.cos(angle) * w).toFixed(2);
    const y = +(Math.sin(angle) * w).toFixed(2);
    parts.push(`${x}px ${y}px 0 ${color}`);
  }
  parts.push(`0 0 ${+(w * 1.5).toFixed(2)}px ${color}`);
  return parts.join(', ');
}

// [translated line, original line] text-shadow for a style. The shadow styles use the shadow
// colour and the outline uses the outline colour; the popup only shows the picker that applies.
function lcTextShadow(style, shadowColor, outlineColor, width) {
  const c = (alpha) => lcHexToRgba(shadowColor, alpha);
  switch (style) {
    case 'off':
      return ['none', 'none'];
    case 'soft':
      return [`0 1px 2px ${c(0.6)}`, `0 1px 2px ${c(0.5)}`];
    case 'strong':
      return [`0 0 2px ${c(1)}, 0 2px 4px ${c(1)}, 0 0 10px ${c(0.9)}`, `0 0 2px ${c(1)}, 0 2px 4px ${c(0.9)}`];
    case 'outline':
      // The original line is smaller, so it gets a proportionally thinner outline.
      return [
        lcOutline(width, lcHexToRgba(outlineColor, 1)),
        lcOutline(Math.max(width * 0.7, 0.5), lcHexToRgba(outlineColor, 1))
      ];
    default: // medium
      return [`0 2px 4px ${c(0.9)}`, `0 2px 4px ${c(0.8)}`];
  }
}

function lcFontStack(id) {
  return (LC_FONTS[id] || LC_FONTS.system).stack;
}

function lcHexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = parseInt(m ? m[1] : '0a0f19', 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Everything needed to draw the subtitle box for a set of settings.
function lcSubtitleLook(settings) {
  const s = { ...LC_SUBTITLE_DEFAULTS, ...settings };
  const alpha = Math.min(Math.max(Number(s.bgOpacity), 0), 100) / 100;
  const main = LC_FONT_SIZES[s.fontSize] || LC_FONT_SIZES.medium;
  const shadows = lcTextShadow(s.textShadow, s.shadowColor, s.outlineColor, Number(s.outlineWidth));
  return {
    background: lcHexToRgba(s.bgColor, alpha),
    // Frame, drop shadow and blur fade out with the background, so 0% really is see-through.
    border: `1px solid rgba(255, 255, 255, ${(0.12 * alpha).toFixed(3)})`,
    boxShadow: alpha > 0 ? `0 10px 40px rgba(0, 0, 0, ${(0.6 * alpha).toFixed(3)})` : 'none',
    backdropFilter: alpha > 0.05 ? `blur(${Math.round(8 * alpha)}px)` : 'none',
    color: s.textColor,
    fontFamily: lcFontStack(s.fontFamily),
    fontWeight: LC_FONT_WEIGHTS[s.fontWeight] || 700,
    mainSize: main,
    rawSize: Math.round(main * Number(s.originalScale)) / 100,
    mainShadow: shadows[0],
    rawShadow: shadows[1],
    originalBelow: s.originalPlacement === 'below'
  };
}

// Direction of a subtitle line, from its first letter: Arabic script (and Hebrew) reads right to left.
// Set per line rather than with dir="auto", which would follow a "Person 1:" label in front of it.
const LC_RTL_LETTER = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;

function lcTextDirection(text) {
  const first = String(text || '').match(/\p{L}/u);
  return first && LC_RTL_LETTER.test(first[0]) ? 'rtl' : 'ltr';
}

// Speaker labels (Person 1, 2, ...): one colour per person, repeating after eight. Bright colours
// on dark or see-through boxes (over the video), deeper ones on light boxes.
const LC_SPEAKER_COLORS = {
  onDark: ['#5eb8ff', '#ffb347', '#7ee08a', '#ff85bb', '#c9a0ff', '#4fd6c8', '#ffd84d', '#ff8a70'],
  onLight: ['#0a64b0', '#a85600', '#1c7a30', '#b8144f', '#5b34b0', '#00695c', '#7a6000', '#b33a1c']
};

function lcSpeakerColor(n, settings) {
  const s = { ...LC_SUBTITLE_DEFAULTS, ...settings };
  const m = /^#?([0-9a-f]{6})$/i.exec(s.bgColor || '');
  const v = parseInt(m ? m[1] : '0a0f19', 16);
  const luminance = (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
  const lightBox = luminance > 0.55 && Number(s.bgOpacity) >= 40;
  const colors = lightBox ? LC_SPEAKER_COLORS.onLight : LC_SPEAKER_COLORS.onDark;
  return colors[(Math.max(1, parseInt(n) || 1) - 1) % colors.length];
}
