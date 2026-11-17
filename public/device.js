/* Підлаштування під конкретний iPhone.
 *
 * Проблема: в iOS-застосунку з екрана «Додому» (PWA) браузер інколи віддає неправильну висоту вікна
 * (після запуску зі сповіщення, повернення в застосунок, появи клавіатури, зміни орієнтації), через що
 * нижня панель із position: fixed «зависає» посередині екрана. Тому тут висоту екрана й безпечні зони
 * (виріз/острів зверху, смужка «Додому» знизу) визначаємо самі — за моделлю пристрою — і віддаємо в CSS:
 *   --app-h  висота застосунку, --sat / --sab  верхній і нижній відступи.
 */
(() => {
  'use strict';

  // Розмір екрана в CSS-пікселях (портрет) → модель, мінімальні безпечні зони.
  // top — висота статус-бару/острова, bottom — смужка «Додому». Якщо iOS сама повідомила більше
  // значення (env(safe-area-inset-*)), береться воно: тут лише нижня межа «про всяк випадок».
  const PROFILES = {
    '320x568': { names: 'iPhone SE 1 / 5s', top: 20, bottom: 0 },
    '375x667': { names: 'iPhone SE 2–3 / 6 / 7 / 8', top: 20, bottom: 0 },
    '414x736': { names: 'iPhone 6 / 7 / 8 Plus', top: 20, bottom: 0 },
    '375x812': { names: 'iPhone X / XS / 11 Pro / 12–13 mini', top: 44, bottom: 34 },
    '414x896': { names: 'iPhone XR / XS Max / 11 / 11 Pro Max', top: 44, bottom: 34 },
    '390x844': { names: 'iPhone 12–14 / 12–13 Pro / 16e', top: 47, bottom: 34 },
    '428x926': { names: 'iPhone 12–13 Pro Max / 14 Plus', top: 47, bottom: 34 },
    '393x852': { names: 'iPhone 14 Pro / 15 / 15 Pro / 16', top: 54, bottom: 34 },
    '430x932': { names: 'iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus', top: 54, bottom: 34 },
    '402x874': { names: 'iPhone 16 Pro / 17 / 17 Pro', top: 59, bottom: 34 },
    '420x912': { names: 'iPhone Air', top: 59, bottom: 34 },
    '440x956': { names: 'iPhone 16 Pro Max / 17 Pro Max', top: 59, bottom: 34 },
  };

  const root = document.documentElement;
  const ua = navigator.userAgent || '';
  const isIOS = /iphone|ipod/i.test(ua);
  const standalone = () => window.navigator.standalone === true ||
    (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

  const sw = Math.min(screen.width, screen.height);
  const sh = Math.max(screen.width, screen.height);
  const profile = isIOS ? PROFILES[`${sw}x${sh}`] || null : null;

  // Справжні безпечні зони, які повідомляє iOS (через прихований елемент).
  let probe = null;
  function measureInsets() {
    if (!probe) {
      probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
      (document.body || root).appendChild(probe);
    }
    const cs = getComputedStyle(probe);
    return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  }

  const typing = () => {
    const a = document.activeElement;
    return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  };
  const portrait = () => window.matchMedia('(orientation: portrait)').matches;

  function update() {
    const standaloneIOS = isIOS && standalone();
    const m = measureInsets();
    let top = m.top;
    let bottom = m.bottom;
    if (standaloneIOS && profile) {
      top = Math.max(top, profile.top);
      bottom = Math.max(bottom, profile.bottom);
    }
    root.style.setProperty('--sat', top + 'px');
    root.style.setProperty('--sab', bottom + 'px');

    // Висота застосунку. У PWA на iPhone вікно завжди на весь екран, тож у портреті беремо висоту екрана,
    // якщо браузер віддав менше. З клавіатурою — реальну висоту видимої частини.
    const vv = window.visualViewport;
    const inner = Math.round((vv && vv.height) || window.innerHeight);
    let h = null;
    if (standaloneIOS) {
      if (typing()) h = inner;
      else if (portrait()) h = Math.max(inner, sh);
      else h = inner;
    }
    if (h) root.style.setProperty('--app-h', h + 'px');
    else root.style.removeProperty('--app-h');

    root.dataset.standalone = standaloneIOS ? '1' : '0';
    if (profile) root.dataset.device = `${sw}x${sh}`;
  }

  let timer = null;
  function schedule() {
    update();
    clearTimeout(timer);
    // iOS повідомляє остаточні розміри з затримкою — перевіряємо ще кілька разів.
    timer = setTimeout(update, 120);
    setTimeout(update, 500);
    setTimeout(update, 1500);
  }

  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('pageshow', schedule);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => setTimeout(update, 100));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', update);

  // Назва пристрою для адміністратора («iPhone 14 Pro / 15 … · застосунок»).
  function label() {
    let base = 'Пристрій';
    if (isIOS) base = profile ? profile.names : 'iPhone';
    else if (/ipad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) base = 'iPad';
    else if (/android/i.test(ua)) base = 'Android';
    else if (/windows/i.test(ua)) base = 'Windows';
    else if (/mac os x/i.test(ua)) base = 'Mac';
    else if (/linux/i.test(ua)) base = 'Linux';
    if (base.length > 48) base = base.slice(0, 45) + '…';
    return `${base} · ${standalone() ? 'застосунок' : 'браузер'}`;
  }

  window.DeviceInfo = { profile, label, update };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
})();
