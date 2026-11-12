/*
 * Успішність студента: мої бали (підвищення балу), рейтинг (у app.js), статистика й графіки, останні зміни балів
 * у профілі, сповіщення й налаштування сповіщень. Усі дані — лише власні (сервер бере студента з сеансу).
 */
(() => {
  'use strict';
  const D = window.Diary;
  const { S, api, esc, ic, ui, fmt, toast } = D;
  const $ = (s, r = document) => r.querySelector(s);
  const render = () => D.render();

  const P = {
    scores: null, scoresErr: '',
    stats: null, statsErr: '', statsLoading: false,
    range: D.LS.get('statsRange', '7d'), from: '', to: '', period: 'day',
    ntf: { items: null, next: null, err: '', loading: false },
    profile: null, profileErr: '',
    prefs: null, prefsLoading: false,
  };

  const linked = () => !!(P.scores && P.scores.linked);
  const SRC_STUDENT = { sheet: 'З таблиці', student: 'Змінено вами', admin: 'Адміністратор', import: 'Імпорт файлу', seed: 'Початкові дані', migration: 'Початкові дані' };
  const srcBadge = (s) => (s ? ui.src(s, SRC_STUDENT[s]) : '');
  const subjOf = (key) => (P.scores && P.scores.subjects || []).find((x) => x.key === key);
  const pts = (n) => `${fmt.num(n)} ${fmt.plural(n, 'бал', 'бали', 'балів')}`;
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

  // ───────────── завантаження ─────────────

  async function loadScores() {
    try { P.scores = await api('GET', '/api/me/scores'); P.scoresErr = ''; } catch (e) { P.scoresErr = e.message; }
    render();
  }
  async function loadStats() {
    P.statsLoading = true;
    render();
    const q = P.range === 'custom' ? `range=custom&from=${encodeURIComponent(P.from)}&to=${encodeURIComponent(P.to)}` : `range=${P.range}`;
    try { P.stats = await api('GET', '/api/me/stats?' + q); P.statsErr = ''; } catch (e) { P.statsErr = e.message; }
    P.statsLoading = false;
    render();
  }
  async function loadNotifications(more) {
    const N = P.ntf;
    N.loading = true;
    try {
      const r = await api('GET', '/api/me/notifications?limit=30' + (more && N.next ? '&before=' + encodeURIComponent(N.next) : ''));
      N.items = more ? (N.items || []).concat(r.items) : r.items;
      N.next = r.next;
      S.unread = r.unread;
      N.err = '';
    } catch (e) { N.err = e.message; }
    N.loading = false;
    render();
  }
  async function loadProfile() {
    try { P.profile = await api('GET', '/api/me/profile'); P.profileErr = ''; S.unread = P.profile.unread; } catch (e) { P.profileErr = e.message; }
    render();
  }
  async function loadPrefs() {
    if (P.prefsLoading) return;
    P.prefsLoading = true;
    try { P.prefs = (await api('GET', '/api/me/prefs')).prefs; } catch (e) { P.prefs = null; }
    P.prefsLoading = false;
    render();
  }

  // ───────────── спільні фрагменти ─────────────

  function editNotice(edit) {
    if (!edit || edit.allowed) return '';
    return ui.notice(edit.code === 'device_untrusted' ? 'warn' : 'info', esc(edit.message));
  }

  function notLinked() {
    return ui.empty('link', 'Обліковий запис ще не прив’язано до рейтингу',
      'Щоб бачити свої бали, статистику та змінювати бали, адміністратор має прив’язати ваш обліковий запис до запису в рейтингу групи.');
  }

  /** Порівняння з минулим (доба / тиждень / місяць) — лише з реальних знімків історії. */
  function periodCard(title, k) {
    if (!k || !k.available) {
      return `<div class="kpi"><div class="k-top"><span class="k-label">${esc(title)}</span></div><div class="k-val k-txt faint">Немає даних</div>
        <div class="k-sub">${k && k.since ? `Історія збирається з ${esc(fmt.longDay(k.since))}` : 'Історія ще не накопичилась'}</div></div>`;
    }
    return `<div class="kpi"><div class="k-top"><span class="k-label">${esc(title)}</span>${ui.delta(k.delta)}</div>
      <div class="k-val">${k.pct == null ? '—' : esc(fmt.signed(k.pct, '%'))}</div>
      <div class="k-sub"><span>${esc(fmt.num(k.baseTotal))} → ${esc(fmt.num(k.total))}</span>${k.rankChange ? ui.delta(k.rankChange, { text: `${Math.abs(k.rankChange)} ${fmt.plural(Math.abs(k.rankChange), 'позиція', 'позиції', 'позицій')}` }) : ''}</div></div>`;
  }

  // Хто змінив бал — з погляду студента (імена адміністраторів не показуються).
  const CHANGED_BY = { student: 'змінено вами', admin: 'адміністратор', sheet: 'Google-таблиця', import: 'імпорт файлу', seed: 'початкові дані', migration: 'початкові дані' };

  function historyItem(h) {
    const subj = subjOf(h.subject);
    const title = h.subjectTitle && h.subjectTitle !== h.subject ? h.subjectTitle : subj ? subj.title : h.subject;
    return ui.scoreChange({ ...h, subjectTitle: title }, {
      source: esc(CHANGED_BY[h.source] || 'система') + (h.conflictId ? ' · розв’язання розбіжності з таблицею' : ''),
    });
  }

  function subjectCard(x, edit) {
    const canRaise = edit && edit.allowed && (x.value == null || x.value < x.max);
    return `<div class="subj-card ${x.underReview ? 'review' : ''}">
      <div class="s-head"><div><div class="s-key">${esc(x.key)}</div>${x.title !== x.key ? `<div class="s-title">${esc(x.title)}</div>` : ''}</div>${srcBadge(x.source)}</div>
      <div class="spread"><div class="s-val"><b>${esc(fmt.num(x.value))}</b><span>/ ${esc(fmt.num(x.max))}</span></div>${x.changes ? ui.scoreDelta(x.previous, x.value) : ''}</div>
      ${ui.progress(x.value || 0, x.max)}
      <div class="s-meta"><span>Попередній: <b>${x.changes && x.previous != null ? esc(fmt.num(x.previous)) : '—'}</b></span><span>Зміна: <b>${esc(fmt.pct(x.pct))}</b></span><span>Місце: <b>${x.rank ? `${x.rank} з ${x.of}` : '—'}</b></span></div>
      ${x.studentIncrease > 0 ? `<div class="muted xs">Ваше підвищення: +${esc(fmt.points(x.studentIncrease))} до значення з таблиці</div>` : ''}
      ${x.underReview ? `<div class="notice warn" style="font-size:13px;padding:9px 11px">${ic('alert', 16)}<div>Значення в Google-таблиці відрізняється — бал перевіряє адміністратор.</div></div>` : ''}
      <div class="s-actions">
        <button class="btn small" data-act="incOpen" data-key="${esc(x.key)}" ${canRaise ? '' : 'disabled'}>${ic('up', 16)} Підвищити</button>
      </div></div>`;
  }

  function summaryHero(s) {
    const c = s.current;
    const rc = s.daily && s.daily.available ? s.daily.rankChange : null;
    return `<div class="card hero">
      <div class="spread wrap"><span class="label">Загальний бал · ${esc(s.student.group)}</span>${s.daily && s.daily.available ? ui.delta(s.daily.delta, { text: `${fmt.signed(s.daily.delta)} за добу` }) : ''}</div>
      <div class="hero-main">
        <div class="hero-pos"><b>${esc(fmt.num(c.total))}</b><span>${esc(fmt.plural(c.total || 0, 'бал', 'бали', 'балів'))} разом</span></div>
        <div class="hero-pts"><b>${c.rank != null ? c.rank : '—'}</b><span>${c.rank != null ? `місце з ${c.of}` : 'ще без місця'}${rc ? ` · ${rc > 0 ? '▲' : '▼'} ${Math.abs(rc)}` : ''}</span></div></div>
      <div class="hero-stats"><div><b>${esc(fmt.num(c.avg))}</b><small>середній бал</small></div><div><b>${c.count} / ${c.subjects}</b><small>предметів з балами</small></div>
        <div><b>${s.weekly && s.weekly.available ? esc(fmt.signed(s.weekly.delta)) : '—'}</b><small>за тиждень</small></div></div></div>`;
  }

  // ───────────── сторінки ─────────────

  function viewScores() {
    if (!P.scores) return P.scoresErr ? ui.error(P.scoresErr, 'pReloadScores') : ui.skeleton(3, 120);
    if (!P.scores.linked) return notLinked();
    const s = P.scores;
    if (!s.student.active) return summaryHero(s) + ui.notice('warn', 'Ваш запис у рейтингу групи архівовано. Якщо це помилка, зверніться до адміністратора.');
    return `${summaryHero(s)}
      ${editNotice(s.edit)}
      ${s.edit.allowed ? ui.notice('info', 'Ви можете підвищити бал з будь-якого предмета в межах максимуму. <b>Знизити бал після збереження неможливо</b>; кожна зміна записується в історію й видима адміністратору.') : ''}
      <div class="sec-head"><h2>Предмети</h2><span class="muted small">${s.subjects.length} ${fmt.plural(s.subjects.length, 'предмет', 'предмети', 'предметів')}</span></div>
      <div class="subjects">${s.subjects.map((x) => subjectCard(x, s.edit)).join('')}</div>`;
  }

  const RANGES = [['today', 'Сьогодні'], ['7d', '7 днів'], ['30d', '30 днів'], ['90d', '3 місяці'], ['custom', 'Період']];

  function rangeBar() {
    return `<div class="card tight"><div class="spread wrap"><div class="pills">${RANGES.map(([v, t]) => `<button class="pill ${P.range === v ? 'on' : ''}" data-act="statsRange" data-v="${v}">${t}</button>`).join('')}</div>
      ${P.stats && P.stats.historySince ? `<span class="muted xs">Історія з ${esc(fmt.longDay(P.stats.historySince))}</span>` : ''}</div>
      ${P.range === 'custom' ? `<div class="toolbar"><label class="grow"><span class="label">Від</span><input class="field" type="date" id="statsFrom" value="${esc(P.from)}"></label>
        <label class="grow"><span class="label">До</span><input class="field" type="date" id="statsTo" value="${esc(P.to)}"></label>
        <button class="btn small" data-act="statsCustom" style="align-self:flex-end">Показати</button></div>` : ''}</div>`;
  }

  function changeSub(ch, unit = '') {
    if (!ch) return 'Немає даних за період';
    return `${ui.delta(ch.delta)} <span>${ch.pct != null ? esc(fmt.signed(ch.pct, '%')) : ''}${ch.partial ? ` · з ${esc(fmt.longDay(ch.fromDate))}` : ''}${unit}</span>`;
  }

  function viewStats() {
    if (!P.scores && !P.stats) return ui.skeleton(3, 120);
    if (P.scores && !P.scores.linked) return notLinked();
    let h = rangeBar();
    if (P.statsErr) return h + ui.error(P.statsErr, 'pReloadStats');
    const s = P.stats;
    if (!s) return h + ui.skeleton(2, 220);
    const c = s.current;
    const today = s.range.range === 'today';
    h += `<div class="grid k4">
      ${ui.kpi({ label: 'Місце в групі', value: c.rank != null ? String(c.rank) : '—', unit: c.rank != null ? `з ${c.of}` : '', icon: 'trophy', tone: 'warn',
        sub: s.previousRank != null ? `Учора: ${s.previousRank} ${c.rank != null && s.previousRank !== c.rank ? ui.delta(s.previousRank - c.rank, { text: `${Math.abs(s.previousRank - c.rank)} поз.` }) : ''}` : 'Немає даних за вчора' })}
      ${ui.kpi({ label: today ? 'Загальний бал · сьогодні' : 'Загальний бал · за період', value: esc(fmt.num(c.total)), icon: 'target', sub: changeSub(s.totalChange) })}
      ${ui.kpi({ label: 'Середній бал', value: esc(fmt.num(c.avg)), icon: 'bars', tone: 'sky', sub: s.avgChange ? `${ui.delta(s.avgChange.delta)} <span>${s.avgChange.pct != null ? esc(fmt.signed(s.avgChange.pct, '%')) : ''}</span>` : 'Немає даних за період' })}
      ${ui.kpi({ label: 'Предметів з балами', value: `${c.count}`, unit: `з ${c.subjects}`, icon: 'book', tone: 'green', sub: s.rankChange && s.rankChange.places ? `Місце за період: ${ui.delta(s.rankChange.places, { text: `${Math.abs(s.rankChange.places)} поз.` })}` : '&nbsp;' })}
    </div>`;
    h += `<div class="grid k3">${periodCard('За добу', s.daily)}${periodCard('За тиждень', s.weekly)}${periodCard('За місяць', s.monthly)}</div>`;

    const series = s.series || [];
    const lineTotal = today && s.intraday
      ? Charts.line({ labels: s.intraday.map((p) => fmt.dateTime(p.at).split(', ').pop()), tipLabels: s.intraday.map((p) => fmt.dateTime(p.at)), series: [{ name: 'Загальний бал', color: 'var(--c1)', values: s.intraday.map((p) => p.total) }], area: true, height: 240, empty: 'Сьогодні змін ще не було', label: 'Динаміка загального балу' })
      : Charts.line({ labels: series.map((p) => fmt.shortDay(p.date)), tipLabels: series.map((p) => fmt.longDay(p.date)), series: [{ name: 'Загальний бал', color: 'var(--c1)', values: series.map((p) => p.total) }], area: true, height: 240, label: 'Динаміка загального балу' });
    const lineRank = Charts.line({ labels: series.map((p) => fmt.shortDay(p.date)), tipLabels: series.map((p) => fmt.longDay(p.date)), series: [{ name: 'Місце', color: 'var(--c4)', values: series.map((p) => p.rank) }], invert: true, integer: true, min: 1, height: 200, format: (v) => (v == null ? '—' : `${Math.round(v)}`), label: 'Місце в групі' });
    const per = (s.periods && s.periods[P.period]) || [];
    const perLabel = (b) => (P.period === 'day' ? fmt.shortDay(b.label) : P.period === 'week' ? 'тиж. ' + fmt.shortDay(b.label) : fmt.month(b.label));
    const bars = Charts.bars({ labels: per.map(perLabel), tipLabels: per.map((b) => (P.period === 'week' ? 'Тиждень з ' + fmt.longDay(b.label) : P.period === 'month' ? fmt.month(b.label) : fmt.longDay(b.label))), series: [{ name: 'Зміна загального балу', values: per.map((b) => b.delta) }], signed: true, height: 200, empty: 'Змін за цей період немає', label: 'Зміни за періодами' });
    h += `<div class="grid c2">
      <div class="card"><div class="card-head"><div><div class="card-title">Динаміка загального балу</div><div class="card-sub">${today ? 'Зміни протягом сьогоднішнього дня' : 'Значення на кінець кожного дня'}</div></div></div>${lineTotal}</div>
      <div class="card"><div class="card-head"><div><div class="card-title">Місце в групі</div><div class="card-sub">Чим вище лінія, тим краще місце</div></div></div>${lineRank}</div>
      <div class="card"><div class="card-head"><div><div class="card-title">Прогрес за періодами</div><div class="card-sub">Зміна загального балу</div></div>
        ${ui.seg([['day', 'День'], ['week', 'Тиждень'], ['month', 'Місяць']], P.period, 'statsPeriod')}</div>${bars}</div>
      <div class="card"><div class="card-head"><div><div class="card-title">Порівняння предметів</div><div class="card-sub">Поточний бал від максимуму; світла смуга — початок періоду</div></div></div>
        <div class="hbars">${s.subjects.map((x) => {
          const start = x.range ? x.range.from : null;
          return `<div class="hbar"><span class="hb-l" title="${esc(x.title)}">${esc(x.key)}</span><div class="progress">${start != null ? `<i class="ghost" style="width:${Math.min(100, (start / x.max) * 100).toFixed(1)}%"></i>` : ''}<i style="width:${Math.min(100, ((x.value || 0) / x.max) * 100).toFixed(1)}%"></i></div><span class="hb-v">${esc(fmt.num(x.value))}</span></div>`;
        }).join('')}</div></div>
    </div>`;
    h += `<div class="card"><div class="card-head"><div><div class="card-title">Прогрес за предметами</div><div class="card-sub">Бали протягом обраного періоду</div></div></div>
      <div class="mini-charts">${s.subjects.map((x) => {
        const vals = (s.subjectSeries && s.subjectSeries[x.key] || []).map((p) => p.value);
        const r = x.range;
        return `<div class="mini"><div class="m-head"><b>${esc(x.key)}</b>${r ? ui.delta(r.delta) : '<span class="faint xs">—</span>'}</div>${Charts.spark(vals.length > 1 ? vals : [x.value, x.value], { color: r && r.delta < 0 ? 'var(--red)' : 'var(--c1)' })}<span class="muted xs">${esc(fmt.num(x.value))} з ${esc(fmt.num(x.max))}</span></div>`;
      }).join('')}</div></div>`;
    const act = s.activity || [];
    h += `<div class="grid c2">
      <div class="card"><div class="card-title">Найкращі предмети</div>${s.best.length ? `<div class="feed">${s.best.map((b, i) => `<div class="feed-item"><span class="feed-ic fi-student">${i + 1}</span><div class="feed-body"><span class="t">${esc(b.key)}${b.title !== b.key ? ' · ' + esc(b.title) : ''}</span><span class="d">${esc(fmt.num(b.value))} з ${esc(fmt.num(b.max))}</span></div><div class="feed-side"><b>${esc(fmt.pct(Math.round((b.value / b.max) * 1000) / 10))}</b></div></div>`).join('')}</div>` : '<div class="muted small">Балів ще немає.</div>'}</div>
      <div class="card"><div class="card-title">Найбільше покращення за період</div>${s.improved.length ? `<div class="feed">${s.improved.map((b) => `<div class="feed-item"><span class="feed-ic fi-sheet">${ic('up', 16)}</span><div class="feed-body"><span class="t">${esc(b.key)}${b.title !== b.key ? ' · ' + esc(b.title) : ''}</span><span class="d">${b.pct != null ? esc(fmt.signed(b.pct, '%')) : 'нові бали'}${b.partial ? ` · з ${esc(fmt.longDay(b.fromDate))}` : ''}</span></div><div class="feed-side">${ui.delta(b.delta)}</div></div>`).join('')}</div>` : '<div class="muted small">За обраний період покращень не було.</div>'}</div>
    </div>`;
    if (act.length) {
      h += `<div class="card"><div class="card-head"><div><div class="card-title">Активність</div><div class="card-sub">Кількість змін балів за днями та їх джерело</div></div>
        <div class="legend"><span><i style="background:var(--c1)"></i>Ви</span><span><i style="background:var(--c2)"></i>Таблиця</span><span><i style="background:var(--c4)"></i>Адміністратор</span></div></div>
        ${Charts.bars({ labels: act.map((a) => fmt.shortDay(a.date)), tipLabels: act.map((a) => fmt.longDay(a.date)), stacked: true, integer: true, height: 180,
          series: [{ name: 'Ви', color: 'var(--c1)', values: act.map((a) => a.student) }, { name: 'Таблиця', color: 'var(--c2)', values: act.map((a) => a.sheet) }, { name: 'Адміністратор', color: 'var(--c4)', values: act.map((a) => a.admin + a.other) }] })}</div>`;
    }
    h += `<div class="section"><div class="sec-head"><h2>Предмети детально</h2></div><div class="tbl-wrap stack"><table class="tbl stack"><thead><tr>
      <th>Предмет</th><th class="r">Поточний</th><th class="r">Попередній</th><th class="r">Різниця</th><th class="r">Зміна, %</th><th class="r">Місце</th></tr></thead><tbody>
      ${s.subjects.map((x) => `<tr><td class="head" data-label="Предмет"><span class="name">${esc(x.key)}</span>${x.title !== x.key ? `<span class="sub">${esc(x.title)}</span>` : ''}</td>
        <td class="r" data-label="Поточний"><b>${esc(fmt.num(x.value))}</b> <span class="faint">/ ${esc(fmt.num(x.max))}</span></td>
        <td class="r" data-label="Попередній">${x.changes ? esc(fmt.num(x.previous)) : '—'}</td>
        <td class="r" data-label="Різниця">${x.delta != null ? ui.delta(x.delta) : '—'}</td>
        <td class="r" data-label="Зміна, %">${esc(fmt.pct(x.pct))}</td>
        <td class="r" data-label="Місце">${x.rank ? `${x.rank} з ${x.of}` : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="foot">Різниця й відсоток — порівняно з попереднім значенням балу (до останньої зміни). Відсоток = (новий − попередній) / попередній × 100; від нульового балу відсоток не обчислюється.</div></div>`;
    return h;
  }

  function viewNotifications() {
    const N = P.ntf;
    if (N.err) return ui.error(N.err, 'ntfReload');
    if (!N.items) return ui.skeleton(4, 76);
    let h = `<div class="spread wrap"><span class="muted small">${S.unread ? `Непрочитаних: ${S.unread}` : 'Усі сповіщення прочитано'}</span>
      <div class="btn-row"><button class="btn small ghost" data-act="go" data-tab="settings" data-sub="prefs">${ic('gear', 16)} Налаштувати</button>
      ${S.unread ? `<button class="btn small soft" data-act="ntfReadAll">${ic('check', 16)} Позначити всі як прочитані</button>` : ''}</div></div>`;
    if (!N.items.length) return h + ui.empty('bell', 'Сповіщень поки немає', 'Тут з’являтимуться зміни ваших балів, рейтингу та щоденні підсумки — лише коли для них є реальні дані.');
    const groups = [];
    for (const n of N.items) {
      const g = fmt.dayGroup(n.createdAt);
      if (!groups.length || groups[groups.length - 1].g !== g) groups.push({ g, items: [] });
      groups[groups.length - 1].items.push(n);
    }
    h += groups.map((g) => `<div><div class="day-head">${esc(g.g)}</div>${g.items.map((n) => `<button class="ntf ${n.read ? 'read' : 'unread'}" data-act="ntfOpen" data-id="${esc(n.id)}">
        <span class="n-dot"></span><span class="n-body"><span class="n-title">${esc(n.title)}</span><span class="n-text" style="display:block">${esc(n.body)}</span><span class="n-time" style="display:block">${esc(fmt.rel(n.createdAt))}</span></span></button>`).join('')}</div>`).join('');
    if (N.next) h += `<button class="btn ghost auto" data-act="ntfMore" ${N.loading ? 'disabled' : ''}>Показати ще</button>`;
    return h;
  }

  function viewProfile() {
    if (P.profileErr) return ui.error(P.profileErr, 'pReloadProfile');
    const pr = P.profile;
    if (!pr) return ui.skeleton(3, 120);
    const a = pr.account;
    let h = `<div class="card"><div class="hstack wrap"><span class="ava lg">${esc(D.initialsOf(a.fullName))}</span>
      <div class="grow"><h2 style="font-size:22px">${esc(a.fullName)}</h2>
        <div class="hstack wrap" style="gap:6px;margin-top:6px">${D.roleBadge(S.user) || D.badge('Студент', 'gray')}${pr.linked ? D.badge(pr.stats.student.group, 'sky') : D.badge('Не прив’язано до рейтингу', 'warn')}
          ${a.deviceTrusted ? D.badge('Довірений пристрій', 'accent') : D.badge('Пристрій не підтверджено', 'warn')}</div></div></div>
      ${!a.deviceTrusted ? ui.notice('warn', 'З цього пристрою не можна змінювати бали, доки адміністратор його не підтвердить (Адміністрування → Керування → Учасники та пристрої).') : ''}</div>`;
    if (!pr.linked) return h + notLinked();
    const s = pr.stats;
    const c = s.current;
    h += `<div class="grid k4">
      ${ui.kpi({ label: 'Місце в групі', value: c.rank != null ? String(c.rank) : '—', unit: c.rank != null ? `з ${c.of}` : '', icon: 'trophy', tone: 'warn', act: 'go', attrs: 'data-tab="progress" data-sub="rating"', sub: s.previousRank != null ? `Попереднє: ${s.previousRank}` : 'Попереднього ще немає' })}
      ${ui.kpi({ label: 'Загальний бал', value: esc(fmt.num(c.total)), icon: 'target', act: 'go', attrs: 'data-tab="progress" data-sub="scores"', sub: s.daily.available ? `${ui.delta(s.daily.delta)} за добу` : 'Немає даних за вчора' })}
      ${ui.kpi({ label: 'Середній бал', value: esc(fmt.num(c.avg)), icon: 'bars', tone: 'sky', sub: `${c.count} з ${c.subjects} предметів` })}
      ${ui.kpi({ label: 'Прогрес за місяць', value: s.monthly.available ? esc(fmt.signed(s.monthly.delta)) : '—', icon: 'chart', tone: 'green', act: 'go', attrs: 'data-tab="progress" data-sub="stats"', sub: s.monthly.available ? esc(fmt.signed(s.monthly.pct, '%')) : `Історія з ${esc(fmt.longDay(s.historySince))}` })}
    </div>`;
    const rankSeries = (s.series || []).filter((p) => p.rank != null);
    h += `<div class="grid c2">
      <div class="card"><div class="card-head"><div class="card-title">Успішність за предметами</div><button class="link" data-act="go" data-tab="progress" data-sub="scores">Усі бали</button></div>
        <div class="hbars">${s.subjects.map((x) => `<div class="hbar"><span class="hb-l" title="${esc(x.title)}">${esc(x.key)}</span>${ui.progress(x.value || 0, x.max)}<span class="hb-v">${esc(fmt.num(x.value))}</span></div>`).join('')}</div></div>
      <div class="card"><div class="card-head"><div class="card-title">Особиста аналітика</div><button class="link" data-act="go" data-tab="progress" data-sub="stats">Статистика</button></div>
        <div class="grid k3" style="gap:10px">${[['Доба', s.daily], ['Тиждень', s.weekly], ['Місяць', s.monthly]].map(([t, k]) => `<div class="mini"><span class="muted xs">${t}</span><b>${k.available ? esc(fmt.signed(k.delta)) : '—'}</b><span class="xs muted">${k.available ? esc(fmt.signed(k.pct, '%')) : 'немає даних'}</span></div>`).join('')}</div>
        <div><span class="label">Найкращі предмети</span><div class="muted small" style="margin-top:4px">${s.best.length ? s.best.map((b) => `${esc(b.key)} — ${esc(fmt.num(b.value))}`).join(' · ') : 'Балів ще немає'}</div></div>
        <div><span class="label">Найбільше покращення (30 днів)</span><div class="muted small" style="margin-top:4px">${s.improved.length ? s.improved.map((b) => `${esc(b.key)} ${esc(fmt.signed(b.delta))}`).join(' · ') : 'Покращень ще не було'}</div></div>
        <div><span class="label">Місце в групі за 30 днів</span>${Charts.line({ labels: rankSeries.map((p) => fmt.shortDay(p.date)), tipLabels: rankSeries.map((p) => fmt.longDay(p.date)), series: [{ name: 'Місце', color: 'var(--c4)', values: rankSeries.map((p) => p.rank) }], invert: true, integer: true, height: 150, format: (v) => `${Math.round(v)}`, empty: 'Історія місць ще накопичується' })}</div></div>
    </div>`;
    h += `<div class="grid c2">
      <div class="card"><div class="card-title">Останні зміни балів</div>
        ${pr.recent.length ? `<div class="sc-list">${pr.recent.map(historyItem).join('')}</div>` : '<div class="muted small">Змін ще не було.</div>'}</div>
      <div class="home-col">
        <div class="card"><div class="card-head"><div class="card-title">Останні сповіщення</div><button class="link" data-act="go" data-tab="notifications">Усі</button></div>
          ${pr.notifications.length ? pr.notifications.map((n) => `<div class="feed-item"><span class="feed-ic">${ic('bell', 16)}</span><div class="feed-body"><span class="t">${esc(n.title)}</span><span class="d">${esc(n.body)}</span><span class="d faint">${esc(fmt.rel(n.createdAt))}</span></div></div>`).join('') : '<div class="muted small">Сповіщень ще немає.</div>'}</div>
        <div class="card"><div class="card-title">Оновлення з Google-таблиці</div>
          ${pr.syncUpdates.length ? `<div class="sc-list">${pr.syncUpdates.map(historyItem).join('')}</div>` : '<div class="muted small">Таблиця ще не змінювала ваші бали.</div>'}</div>
      </div></div>`;
    return h;
  }

  // ───────────── головна (віджети) ─────────────

  function homeTop() {
    if (!P.scores) return D.isAdmin() ? '' : `<div class="grid k4">${ui.skeleton(4, 104)}</div>`;
    if (!P.scores.linked) {
      return D.isAdmin() ? '' : ui.notice('info', 'Щоб бачити бали, рейтинг і статистику, адміністратор має прив’язати ваш обліковий запис до рейтингу групи.');
    }
    const s = P.scores;
    const c = s.current;
    const d = s.daily;
    return `<div class="grid k4">
      ${ui.kpi({ label: 'Місце в групі', value: c.rank != null ? String(c.rank) : '—', unit: c.rank != null ? `з ${c.of}` : '', icon: 'trophy', tone: 'warn', act: 'go', attrs: 'data-tab="progress" data-sub="rating"',
        sub: d.available && d.rankChange ? `${ui.delta(d.rankChange, { text: `${Math.abs(d.rankChange)} ${fmt.plural(Math.abs(d.rankChange), 'позиція', 'позиції', 'позицій')}` })} за добу` : d.available ? 'Без змін за добу' : 'Динаміка з’явиться завтра' })}
      ${ui.kpi({ label: 'Загальний бал', value: esc(fmt.num(c.total)), icon: 'target', act: 'go', attrs: 'data-tab="progress" data-sub="scores"', sub: d.available ? `${ui.delta(d.delta)} за добу` : 'Порівняння з’явиться завтра' })}
      ${ui.kpi({ label: 'Середній бал', value: esc(fmt.num(c.avg)), icon: 'bars', tone: 'sky', act: 'go', attrs: 'data-tab="progress" data-sub="stats"', sub: s.weekly.available ? `${ui.delta(s.weekly.avgDelta)} за тиждень` : `${c.count} з ${c.subjects} предметів` })}
      ${ui.kpi({ label: 'Сповіщення', value: String(S.unread), icon: 'bell', tone: S.unread ? 'red' : 'green', act: 'go', attrs: 'data-tab="notifications"', sub: S.unread ? 'непрочитані' : 'усе прочитано' })}
    </div>`;
  }

  // Права колонка головної: усі предмети студента (без окремого блоку «Останні зміни»).
  function homeSide() {
    if (!linked()) return '';
    const s = P.scores;
    const list = [...s.subjects].filter((x) => x.value != null).sort((a, b) => b.value / b.max - a.value / a.max);
    return `<div class="card"><div class="card-head"><div class="card-title">Мої предмети</div><button class="link" data-act="go" data-tab="progress" data-sub="scores">Усі бали</button></div>
      ${list.length ? `<div class="hbars">${list.map((x) => `<div class="hbar"><span class="hb-l" title="${esc(x.title)}">${esc(x.key)}</span>${ui.progress(x.value, x.max)}<span class="hb-v">${esc(fmt.num(x.value))}</span></div>`).join('')}</div>` : '<div class="muted small">Балів ще немає.</div>'}
      ${s.edit.allowed ? `<button class="btn soft" data-act="go" data-tab="progress" data-sub="scores">${ic('up', 17)} Підвищити бал</button>` : editNotice(s.edit)}</div>`;
  }

  function prefsSection() {
    if (!S.user) return '';
    if (!P.prefs) { if (!P.prefsLoading) setTimeout(loadPrefs, 0); return ''; }
    const row = (k, t, sub) => `<label class="row"><span>${t}${sub ? `<small class="muted" style="display:block;font-size:12.5px">${sub}</small>` : ''}</span><span class="toggle"><input type="checkbox" data-chg="prefToggle" data-key="${k}" ${P.prefs[k] ? 'checked' : ''}><span></span></span></label>`;
    return `<div><span class="label gl">Сповіщення про успішність</span><div class="list">
      ${row('scores', 'Зміни балів із таблиці', 'Коли Google-таблиця або адміністратор змінює ваші бали')}
      ${row('daily', 'Щоденний підсумок', 'Покращення за добу (о 20:00)')}
      ${row('rank', 'Зміна місця в рейтингу')}
      ${row('weekly', 'Підсумок тижня', 'Щонеділі: середній бал і найкращий результат')}
      ${row('push', 'Надсилати також на пристрої', 'Push-сповіщення, якщо вони ввімкнені')}
    </div><div class="foot">Сповіщення створюються лише з реальних змін — без вигаданих показників.</div></div>`;
  }

  // ───────────── підвищення балу ─────────────

  function parseValue(raw) {
    const t = String(raw == null ? '' : raw).trim().replace(',', '.');
    if (!t) return null;
    if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
    return Math.round(Number(t) * 100) / 100;
  }

  function incCheck(x, v) {
    const cur = x.value == null ? 0 : x.value;
    if (v == null) return { ok: false, msg: '' };
    if (Number.isNaN(v)) return { ok: false, msg: 'Введіть число, наприклад 82 або 82,5.' };
    if (v > x.max) return { ok: false, msg: `Максимальний бал з цього предмета — ${fmt.num(x.max)}.` };
    if (!(v > cur)) return { ok: false, msg: x.value == null ? 'Новий бал має бути більшим за 0.' : `Новий бал має бути більшим за поточний (${fmt.num(x.value)}). Знизити бал неможливо.` };
    return { ok: true, msg: '' };
  }

  function incPreview(x, v) {
    const chk = incCheck(x, v);
    if (!chk.ok) return '';
    const cur = x.value == null ? 0 : x.value;
    const pct = x.value ? Math.round(((v - cur) / cur) * 1000) / 10 : null;
    return `<div class="notice ok">${ic('up', 18)}<div><b>${esc(fmt.num(x.value))} → ${esc(fmt.num(v))}</b> · ${esc(fmt.signed(v - cur))} ${esc(fmt.plural(v - cur, 'бал', 'бали', 'балів'))}${pct != null ? ` · ${esc(fmt.signed(pct, '%'))}` : ''}</div></div>`;
  }

  function openIncrease(key) {
    const x = subjOf(key);
    if (!x) return;
    const s = {
      auto: false, title: 'Підвищення балу', closeLabel: 'Скасувати', key, requestId: uuid(), value: '',
      right: () => '<button class="link" data-act="incSave">Зберегти</button>',
    };
    s.render = () => {
      const cur = subjOf(key) || x;
      const min = cur.value == null ? 0.01 : Math.round((cur.value + 0.01) * 100) / 100;
      return `<div class="card"><div class="spread"><div><div class="card-title">${esc(cur.key)}</div>${cur.title !== cur.key ? `<div class="card-sub">${esc(cur.title)}</div>` : ''}</div>${srcBadge(cur.source)}</div>
          <dl class="dl"><dt>Поточний бал</dt><dd>${esc(fmt.num(cur.value))}</dd><dt>Максимальний бал</dt><dd>${esc(fmt.num(cur.max))}</dd>
            <dt>Можна встановити</dt><dd>${cur.value != null && cur.value >= cur.max ? 'Досягнуто максимуму' : `від ${esc(fmt.num(min))} до ${esc(fmt.num(cur.max))}`}</dd></dl>
          ${ui.progress(cur.value || 0, cur.max)}</div>
        <div class="form">
          <label><span class="label">Новий бал</span><input class="field" id="incValue" name="incValue" type="text" inputmode="decimal" autocomplete="off" placeholder="Наприклад, ${esc(fmt.num(Math.min(cur.max, Math.ceil((cur.value || 0) + 5))))}" data-inp="incValue"></label>
          <div class="pills">${[1, 5, 10].map((n) => `<button class="pill" data-act="incQuick" data-n="${n}">+${n}</button>`).join('')}<button class="pill" data-act="incQuick" data-n="max">Максимум</button></div>
          <div data-role="preview"></div>
          <div class="err" data-role="err"></div>
          ${ui.notice('info', 'Після збереження <b>знизити бал неможливо</b>. Зміну буде записано в історію з датою, часом і номером операції; її бачить адміністратор.')}
          <button class="btn big" data-act="incSave">${ic('check', 18)} Зберегти новий бал</button></div>`;
    };
    D.openSheet(s);
    setTimeout(() => { const i = $('#incValue', s.el); if (i) i.focus(); }, 60);
  }

  function incUpdate(sheet) {
    const x = subjOf(sheet.key);
    const inp = $('#incValue', sheet.el);
    const v = parseValue(inp.value);
    const chk = incCheck(x, v);
    $('[data-role="preview"]', sheet.el).innerHTML = incPreview(x, v);
    $('[data-role="err"]', sheet.el).textContent = chk.msg;
    inp.classList.toggle('invalid', !!chk.msg);
  }

  // ───────────── реєстрація ─────────────

  D.register({
    pages: {
      'progress/scores': { render: viewScores, enter: () => { loadScores(); } },
      'progress/stats': { render: viewStats, enter: () => { if (!P.scores) loadScores(); loadStats(); } },
      notifications: { render: viewNotifications, enter: () => loadNotifications(false) },
      'settings/profile': { render: viewProfile, enter: () => loadProfile() },
    },
    hooks: {
      homeTop, homeSide, prefs: prefsSection,
      sync: () => {
        if (!S.user) return;
        loadScores();
        // Відкрита сторінка оновлюється разом із новими даними (наприклад, із Google-таблиці) — без ручного оновлення.
        const k = D.currentPage().key;
        if (k === 'progress/stats') loadStats();
        else if (k === 'settings/profile') loadProfile();
      },
      reset: () => {
        Object.assign(P, { scores: null, stats: null, profile: null, prefs: null, ntf: { items: null, next: null, err: '', loading: false } });
      },
    },
    actions: {
      pReloadScores: loadScores,
      pReloadStats: loadStats,
      pReloadProfile: loadProfile,
      ntfReload: () => loadNotifications(false),
      incOpen(el) { openIncrease(el.dataset.key); },
      incQuick(el) {
        const s = D.sheetOf(el);
        const x = subjOf(s.key);
        const inp = $('#incValue', s.el);
        const cur = x.value == null ? 0 : x.value;
        const base = parseValue(inp.value);
        const from = base != null && !Number.isNaN(base) && base > cur ? base : cur;
        inp.value = String(el.dataset.n === 'max' ? x.max : Math.min(x.max, Math.round((from + Number(el.dataset.n)) * 100) / 100)).replace('.', ',');
        incUpdate(s);
      },
      async incSave(el) {
        const s = D.sheetOf(el);
        if (!s) return;
        const x = subjOf(s.key);
        const v = parseValue($('#incValue', s.el).value);
        const chk = incCheck(x, v);
        if (!chk.ok) { $('[data-role="err"]', s.el).textContent = chk.msg || 'Введіть новий бал.'; return; }
        await D.withBusy(el, async () => {
          try {
            const r = await api('POST', '/api/me/scores/increase', { subject: x.key, value: v, expected: x.value, requestId: s.requestId });
            D.closeSheet();
            toast(`«${x.key}»: ${fmt.num(r.entry.oldValue)} → ${fmt.num(r.entry.newValue)}. Зміну збережено.`);
            await loadScores();
          } catch (e) {
            $('[data-role="err"]', s.el).textContent = e.message;
            if (e.code === 'stale' || e.code === 'not_increase') { await loadScores(); D.rerender(s); $('[data-role="err"]', s.el).textContent = e.message; }
          }
        });
      },
      statsRange(el) {
        P.range = el.dataset.v;
        if (P.range === 'custom') {
          if (!P.to) { const t = new Date(); P.to = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; }
          if (!P.from) { const f = new Date(Date.now() - 13 * 86400000); P.from = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`; }
          render();
          return;
        }
        D.LS.set('statsRange', P.range);
        loadStats();
      },
      statsCustom() {
        P.from = $('#statsFrom').value;
        P.to = $('#statsTo').value;
        if (!P.from || !P.to) { toast('Вкажіть обидві дати періоду.'); return; }
        if (P.from > P.to) { toast('Початок періоду має бути раніше за кінець.'); return; }
        loadStats();
      },
      statsPeriod(el) { P.period = el.dataset.v; render(); },
      ntfMore() { loadNotifications(true); },
      async ntfReadAll() {
        try { const r = await api('POST', '/api/me/notifications/read', { all: true }); S.unread = r.unread; (P.ntf.items || []).forEach((n) => { n.read = true; }); render(); } catch (e) { toast(e.message); }
      },
      async ntfOpen(el) {
        const n = (P.ntf.items || []).find((x) => x.id === el.dataset.id);
        if (!n) return;
        if (!n.read) {
          n.read = true;
          try { const r = await api('POST', '/api/me/notifications/read', { ids: [n.id] }); S.unread = r.unread; } catch (e) { /* не критично */ }
        }
        const url = n.data && n.data.url;
        const m = url && /[?&]tab=([a-z]+)(?:&sub=([a-z]+))?/.exec(url);
        if (m && m[1] !== 'notifications') D.go(m[1], m[2]); else render();
      },
    },
    changes: {
      async prefToggle(el) {
        P.prefs = { ...P.prefs, [el.dataset.key]: el.checked };
        try { P.prefs = (await api('PUT', '/api/me/prefs', { prefs: P.prefs })).prefs; toast('Налаштування сповіщень збережено'); } catch (e) { toast(e.message); }
      },
    },
    inputs: {
      incValue(el) { const s = D.sheetOf(el); if (s) incUpdate(s); },
    },
  });
})();
