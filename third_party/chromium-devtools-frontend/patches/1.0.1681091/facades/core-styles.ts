import applicationTokens from '#chromium/application_tokens.css.js';
import designSystemTokens from '#chromium/design_system_tokens.css.js';

const styleId = 'pin-op-chromium-design-system-tokens';
if (!document.getElementById(styleId)) {
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `${designSystemTokens}\n${applicationTokens}`;
  document.head.appendChild(style);
}
