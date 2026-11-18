/** Privacy-first, basic consent mode. GA4 is never requested without opt-in. */
const MEASUREMENT_ID = 'G-TG14RBXLTF';
const STORAGE_KEY = 'buildiful_analytics_consent_v1';
let consent = 'unknown';
let initialized = false;
let scriptLoaded = false;
const safeRead = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const safeWrite = value => { try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Private mode */ } };

function prepareGtag() {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  window.gtag('set', 'allow_google_signals', false);
  window.gtag('set', 'allow_ad_personalization_signals', false);
}
function loadAnalytics() {
  if (!initialized) { prepareGtag(); initialized = true; }
  window.gtag('consent', 'update', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  if (scriptLoaded) return;
  scriptLoaded = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
  script.onerror = () => { scriptLoaded = false; };
  document.head.appendChild(script);
  window.gtag('js', new Date());
  window.gtag('config', MEASUREMENT_ID, {
    anonymize_ip: true, allow_google_signals: false, allow_ad_personalization_signals: false,
    page_location: globalThis.location ? globalThis.location.origin + globalThis.location.pathname : undefined,
    page_title: 'Volume Normalizer'
  });
}
export function setAnalyticsConsent(next) {
  consent = next === 'allow' ? 'allow' : 'decline';
  safeWrite(JSON.stringify({ choice: consent, recordedAt: new Date().toISOString() }));
  if (consent === 'allow') loadAnalytics();
  else if (initialized) {
    window.gtag('consent', 'update', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    // Match our existing tools: remove accessible GA cookies and unload the tag.
    if (globalThis.document?.cookie != null) {
      for (const pair of document.cookie.split(';')) {
        const name = pair.trim().split('=')[0];
        if (/^(_ga(?:_.*)?|_gid|_gat(?:_.*)?)$/.test(name)) document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
      }
    }
    if (globalThis.location?.reload) globalThis.location.reload();
  }
  dispatchEvent(new CustomEvent('buildiful:analytics-choice', { detail: consent }));
}
export function analyticsConsent() { return consent; }
export function initializeAnalytics() {
  try { const saved = JSON.parse(safeRead() || 'null'); if (saved?.choice === 'allow' || saved?.choice === 'decline') consent = saved.choice; } catch { /* ignore malformed preference */ }
  if (consent === 'allow') loadAnalytics();
  return consent;
}
export function track(event, params = {}) {
  if (consent !== 'allow' || !initialized) return;
  // Only aggregate feature usage, never filenames, audio, paths, metadata or file sizes.
  window.gtag('event', event, params);
}
