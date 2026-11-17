import {
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  GraduationCap,
  LayoutDashboard,
  Library,
  LogOut,
  Mail,
  MapPin,
  Menu,
  MessageSquareText,
  PanelLeftClose,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  Trophy,
  UserRound,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Rating from "./Rating";
import { fetchGroupInfo, fetchGroupRatings, fetchMyScores, saveMyScore } from "./ratingApi";
import {
  countdownParts,
  dayLabel,
  daysBetween,
  findNextLesson,
  isRemote,
  kindLabel,
  kyivNow,
  lessonDuration,
  lessonsOnDate,
  lessonState,
  longDate,
  pluralUk,
  type GroupInfo,
  type Lesson,
  type WallClock,
} from "./schedule";
import {
  averageScore,
  formatAverage,
  groupRank,
  SUBJECTS,
  type Scores,
  type SubjectKey,
} from "./subjects";

export type SessionUser = { login: string; name: string; role?: string; group?: string };

const UserContext = createContext<SessionUser>({ login: "", name: "" });

function userInitials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

type HomeworkItem = {
  id: string;
  subject: string;
  task: string;
  due: string;
  priority?: "high" | "normal";
};

type SubjectItem = {
  id: string;
  name: string;
  teacher: string;
  progress: number;
  completed: number;
  total: number;
  nextClass: string;
  code: string;
};

type NotificationItem = {
  id: string;
  title: string;
  text: string;
  time: string;
};

const navGroups: NavGroup[] = [
  {
    label: "Навчання",
    items: [
      { id: "overview", label: "Огляд", icon: LayoutDashboard },
      { id: "schedule", label: "Розклад", icon: CalendarDays },
      { id: "homework", label: "Домашні завдання", icon: ClipboardCheck },
      { id: "rating", label: "Рейтинг", icon: Trophy },
    ],
  },
  {
    label: "Академія",
    items: [
      { id: "subjects", label: "Мої предмети", icon: BookOpen },
      { id: "library", label: "Бібліотека", icon: Library },
      { id: "teachers", label: "Викладачі", icon: UsersRound },
    ],
  },
  {
    label: "Система",
    items: [
      { id: "messages", label: "Повідомлення", icon: MessageSquareText, badge: 3 },
      { id: "settings", label: "Налаштування", icon: Settings },
      { id: "help", label: "Допомога", icon: CircleHelp },
    ],
  },
];

const homeworkItems: HomeworkItem[] = [
  {
    id: "crime-scene",
    subject: "Криміналістика",
    task: "Практикум: огляд місця події",
    due: "Сьогодні, 18:00",
    priority: "high",
  },
  {
    id: "administrative-law",
    subject: "Адміністративне право",
    task: "Опрацювати статті 23–31",
    due: "Завтра, 12:00",
  },
  {
    id: "tactical",
    subject: "Тактико-спеціальна підготовка",
    task: "Підготувати алгоритм дій групи",
    due: "17 березня",
  },
  {
    id: "english",
    subject: "Професійна англійська",
    task: "Unit 7: Incident report",
    due: "Виконано 12 березня",
  },
  {
    id: "cyber-test",
    subject: "Кібербезпека",
    task: "Тест: основи цифрової криміналістики",
    due: "Виконано 11 березня",
  },
];

const subjects: SubjectItem[] = [
  {
    id: "criminal-law",
    name: "Кримінальне право",
    teacher: "Ірина Мельник",
    progress: 86,
    completed: 12,
    total: 14,
    nextClass: "Сьогодні, 10:30",
    code: "КП",
  },
  {
    id: "criminalistics",
    name: "Криміналістика",
    teacher: "Андрій Бондар",
    progress: 72,
    completed: 10,
    total: 14,
    nextClass: "Понеділок, 09:00",
    code: "КР",
  },
  {
    id: "tactical-training",
    name: "Тактико-спеціальна підготовка",
    teacher: "Сергій Литвин",
    progress: 64,
    completed: 9,
    total: 14,
    nextClass: "Понеділок, 13:10",
    code: "ТП",
  },
  {
    id: "cybersecurity",
    name: "Кібербезпека",
    teacher: "Наталія Савчук",
    progress: 58,
    completed: 7,
    total: 12,
    nextClass: "Вівторок, 11:50",
    code: "КБ",
  },
];

const notifications: NotificationItem[] = [
  {
    id: "room",
    title: "Змінено аудиторію",
    text: "Криміналістика відбудеться в аудиторії 218.",
    time: "8 хв тому",
  },
  {
    id: "task",
    title: "Нове завдання",
    text: "Додано завдання з адміністративного права.",
    time: "34 хв тому",
  },
  {
    id: "grade",
    title: "Тест оцінено",
    text: "Кібербезпека: результат 94 зі 100.",
    time: "2 год тому",
  },
];

const sectionLabels = Object.fromEntries(
  navGroups.flatMap((group) => group.items.map((item) => [item.id, item.label])),
);

const emblemUrl = `${import.meta.env.BASE_URL}navs-emblem.png`;

function IconButton({
  label,
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

function Sidebar({
  activeId,
  onSelect,
  onClose,
  onLogout,
  mobile = false,
}: {
  activeId: string;
  onSelect: (id: string) => void;
  onClose?: () => void;
  onLogout: () => void;
  mobile?: boolean;
}) {
  const user = useContext(UserContext);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sidebar-brand">
        <div className="brand-emblem-wrap" aria-hidden="true">
          <img src={emblemUrl} alt="" className="brand-emblem" />
        </div>
        <div className="sidebar-copy min-w-0">
          <div className="flex items-center gap-2">
            <span className="brand-title">НАВС</span>
            <span className="online-dot" aria-label="Система онлайн" />
          </div>
          <p className="brand-subtitle">Студентський портал</p>
        </div>
        {mobile && (
          <IconButton
            id="mobile-menu-close"
            label="Закрити меню"
            onClick={onClose}
            className="ml-auto shrink-0"
          >
            <X size={19} />
          </IconButton>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Основна навігація">
        {navGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <p className="nav-group-label sidebar-copy">{group.label}</p>
            <div className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = activeId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`nav-item ${active ? "nav-item-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    aria-label={item.label}
                    title={item.label}
                    onClick={() => onSelect(item.id)}
                  >
                    <Icon size={19} strokeWidth={1.8} className="nav-icon" />
                    <span className="sidebar-copy nav-label">{item.label}</span>
                    {item.badge && (
                      <span className="nav-badge sidebar-copy" aria-label={`${item.badge} нових`}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-profile">
        <div className="profile-avatar">{userInitials(user.name)}</div>
        <div className="sidebar-copy min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-white">{user.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-slate-400">
            {user.group ? `Група ${user.group}` : "Курсант"}
          </p>
        </div>
        <IconButton label="Вийти" onClick={onLogout} className="sidebar-logout">
          <LogOut size={17} />
        </IconButton>
      </div>
    </div>
  );
}

function TopBar({
  onOpenMenu,
  query,
  onQueryChange,
  searchOpen,
  onToggleSearch,
  notificationsOpen,
  onToggleNotifications,
  profileOpen,
  onToggleProfile,
  onNavigate,
  onLogout,
  notificationRef,
  profileRef,
}: {
  onOpenMenu: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  notificationsOpen: boolean;
  onToggleNotifications: () => void;
  profileOpen: boolean;
  onToggleProfile: () => void;
  onNavigate: (id: string) => void;
  onLogout: () => void;
  notificationRef: React.RefObject<HTMLDivElement | null>;
  profileRef: React.RefObject<HTMLDivElement | null>;
}) {
  const user = useContext(UserContext);
  return (
    <header className="topbar">
      <div className="topbar-title-group">
        <IconButton
          id="mobile-menu-trigger"
          label="Відкрити меню"
          onClick={onOpenMenu}
          className="mobile-menu-button"
        >
          <Menu size={20} />
        </IconButton>
        <div className="min-w-0">
          <p className="eyebrow">П’ятниця, 14 березня</p>
          <h1 className="page-title">Вітаємо, {user.name.split(" ")[0]}</h1>
          <p className="page-subtitle">Ось ваш навчальний ритм на сьогодні</p>
        </div>
      </div>

      <div className="topbar-actions">
        <div className={`search-shell ${searchOpen ? "search-shell-open" : ""}`}>
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Пошук у щоденнику…"
            aria-label="Пошук у щоденнику"
          />
          {query && (
            <button type="button" className="search-clear" onClick={() => onQueryChange("")}>
              <X size={14} />
              <span className="sr-only">Очистити пошук</span>
            </button>
          )}
        </div>
        <IconButton
          label={searchOpen ? "Закрити пошук" : "Відкрити пошук"}
          onClick={onToggleSearch}
          className="compact-search-button"
          aria-expanded={searchOpen}
        >
          {searchOpen ? <X size={18} /> : <Search size={18} />}
        </IconButton>

        <div className="relative" ref={notificationRef}>
          <IconButton
            label="Сповіщення"
            onClick={onToggleNotifications}
            aria-expanded={notificationsOpen}
            aria-controls="notifications-popover"
          >
            <Bell size={18} />
            <span className="notification-ping" aria-hidden="true" />
          </IconButton>
          {notificationsOpen && (
            <div className="popover notifications-popover" id="notifications-popover">
              <div className="popover-header">
                <div>
                  <p className="popover-kicker">Центр подій</p>
                  <h2>Сповіщення</h2>
                </div>
                <span className="popover-count">3 нові</span>
              </div>
              <div className="notification-list">
                {notifications.map((item, index) => (
                  <button type="button" className="notification-item" key={item.id}>
                    <span className={`notification-icon notification-icon-${index + 1}`}>
                      {index === 0 ? (
                        <MapPin size={16} />
                      ) : index === 1 ? (
                        <ClipboardCheck size={16} />
                      ) : (
                        <Star size={16} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-semibold text-white">
                        {item.title}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-slate-400">
                        {item.text}
                      </span>
                      <span className="mt-1.5 block text-[10px] text-blue-300">{item.time}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="relative" ref={profileRef}>
          <button
            type="button"
            className="profile-trigger"
            onClick={onToggleProfile}
            aria-expanded={profileOpen}
            aria-controls="profile-popover"
          >
            <span className="topbar-avatar">{userInitials(user.name)}</span>
            <span className="profile-trigger-copy">
              <span>{user.name.split(" ")[0]}</span>
              <small>Курсант</small>
            </span>
            <ChevronDown size={15} className={profileOpen ? "rotate-180" : ""} />
          </button>
          {profileOpen && (
            <div className="popover profile-popover" id="profile-popover">
              <div className="profile-popover-user">
                <span className="topbar-avatar">{userInitials(user.name)}</span>
                <span>
                  <strong>{user.name}</strong>
                  <small>{user.group ? `${user.group} · ${user.login}` : user.login}</small>
                </span>
              </div>
              <div className="profile-menu">
                <button type="button" onClick={() => onNavigate("profile")}>
                  <UserRound size={16} /> Мій профіль
                </button>
                <button type="button" onClick={() => onNavigate("settings")}>
                  <Settings size={16} /> Налаштування
                </button>
                {user.role === "admin" && (
                  <button type="button" onClick={() => window.location.assign("/admin")}>
                    <ShieldCheck size={16} /> Адмін-панель
                  </button>
                )}
                <button type="button" className="profile-menu-logout" onClick={onLogout}>
                  <LogOut size={16} /> Вийти
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function StatCard({
  label,
  value,
  note,
  icon: Icon,
  tone,
  children,
}: {
  label: string;
  value: string;
  note: string;
  icon: LucideIcon;
  tone: string;
  children?: React.ReactNode;
}) {
  return (
    <article className={`glass-panel stat-card stat-${tone}`}>
      <div className="stat-top">
        <div>
          <p className="stat-label">{label}</p>
          <p className="stat-value">{value}</p>
        </div>
        <span className="stat-icon">
          <Icon size={18} strokeWidth={1.8} />
        </span>
      </div>
      <div className="stat-footer">
        <p>{note}</p>
        {children}
      </div>
    </article>
  );
}

type ScheduleStatus = "loading" | "error" | "ready";

function NextClassCard({
  status,
  lessons,
  now,
  hasLink,
  onJoin,
}: {
  status: ScheduleStatus;
  lessons: Lesson[] | null;
  now: WallClock;
  hasLink: (lesson: Lesson) => boolean;
  onJoin: (lesson: Lesson) => void;
}) {
  const next = lessons ? findNextLesson(lessons, now) : null;
  const lesson = next?.lesson ?? null;

  // Правий блок — пари того ж дня, що й найближча (або сьогоднішні, якщо пар більше немає)
  const focusDate = lesson?.date ?? now.date;
  const dayLessons = lessons ? lessonsOnDate(lessons, focusDate) : [];
  let visible = dayLessons;
  if (dayLessons.length > 4) {
    const firstActive = dayLessons.findIndex((item) => lessonState(item, now) !== "done");
    const from = Math.max(
      0,
      Math.min(firstActive < 0 ? dayLessons.length - 4 : firstActive - 1, dayLessons.length - 4),
    );
    visible = dayLessons.slice(from, from + 4);
  }

  let emptyTitle = "";
  let emptyText = "";
  if (status === "loading") {
    emptyTitle = "Завантажуємо розклад…";
  } else if (status === "error" && !lessons) {
    emptyTitle = "Не вдалося завантажити розклад";
    emptyText = "Перевірте з’єднання — спробуємо ще раз автоматично.";
  } else if (!lessons) {
    emptyTitle = "Розклад ще не завантажено";
    emptyText = "Адміністратор додасть розклад вашої групи — і тут зʼявиться найближча пара.";
  } else if (!lesson) {
    emptyTitle = "Найближчих пар немає";
    emptyText = "У завантаженому розкладі більше немає запланованих занять.";
  }

  const countdown = next ? countdownParts(next) : null;
  const minutes = lesson ? lessonDuration(lesson) : 0;
  const showJoin = lesson ? hasLink(lesson) || isRemote(lesson.room) : false;

  return (
    <section className="glass-panel next-class-card" aria-labelledby="next-class-heading">
      <div className="class-watermark" aria-hidden="true">
        <img src={emblemUrl} alt="" />
      </div>
      <div className="next-class-main">
        <div className="section-heading-row">
          <div>
            <span className="section-badge">
              <span className="section-badge-dot" />
              {next?.state === "current" ? "Зараз триває" : "Наступна пара"}
            </span>
            <h2 id="next-class-heading" className="section-title mt-4">
              {lesson ? lesson.subject : emptyTitle}
            </h2>
            {!lesson && emptyText && <p className="class-empty-text">{emptyText}</p>}
          </div>
          {countdown && (
            <div className="class-countdown">
              <Clock3 size={15} />
              <span>
                {countdown.label} <strong>{countdown.value}</strong>
              </span>
            </div>
          )}
        </div>

        {lesson && (
          <>
            <div className="class-meta">
              <div>
                <Clock3 size={16} />
                <span>
                  <strong>
                    {lesson.start}–{lesson.end}
                  </strong>
                  <small>
                    {dayLabel(lesson.date, now.date)} · {minutes} {pluralUk(minutes, "хвилина", "хвилини", "хвилин")}
                  </small>
                </span>
              </div>
              <div>
                <MapPin size={16} />
                <span>
                  <strong>
                    {isRemote(lesson.room) ? "Дистанційно" : lesson.room ? `Аудиторія ${lesson.room}` : "Аудиторію не вказано"}
                  </strong>
                  <small>{lesson.pair} пара</small>
                </span>
              </div>
              <div>
                <GraduationCap size={16} />
                <span>
                  <strong title={lesson.teacher}>{lesson.teacher || "Викладача не вказано"}</strong>
                  <small>
                    {kindLabel(lesson.kind)}
                    {lesson.detail ? ` · ${lesson.detail}` : ""}
                  </small>
                </span>
              </div>
            </div>

            {showJoin && (
              <button type="button" className="primary-button" onClick={() => onJoin(lesson)}>
                Перейти до заняття
                <ChevronRight size={17} />
              </button>
            )}
          </>
        )}
      </div>

      <div className="day-timeline" aria-label="Розклад на день">
        <p className="timeline-caption">{lessons ? dayLabel(focusDate, now.date) : "Розклад"}</p>
        {visible.length > 0 ? (
          <div className="timeline-list">
            <div className="timeline-line" aria-hidden="true" />
            {visible.map((item) => {
              const state = lessonState(item, now);
              return (
                <div
                  key={`${item.date}-${item.start}-${item.subjectKey}-${item.detail}`}
                  className={`timeline-event ${
                    state === "done"
                      ? "timeline-event-done"
                      : state === "current"
                        ? "timeline-event-current"
                        : ""
                  }`}
                >
                  <span className="timeline-dot">{state === "done" && <Check size={10} />}</span>
                  <div>
                    <time>{item.start}</time>
                    <p>{item.subject}</p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="timeline-empty">{lessons ? "На цей день пар немає" : "Поки порожньо"}</p>
        )}
      </div>
    </section>
  );
}

function HomeworkCard({
  items,
  completedIds,
  onToggle,
}: {
  items: HomeworkItem[];
  completedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <section className="glass-panel content-card homework-card" aria-labelledby="homework-heading">
      <div className="content-card-header">
        <div>
          <p className="section-kicker">Цього тижня</p>
          <h2 id="homework-heading" className="section-title">
            Домашні завдання
          </h2>
        </div>
        <span className="task-counter">
          {completedIds.size}/{homeworkItems.length}
        </span>
      </div>

      {items.length > 0 ? (
        <ul className="homework-list">
          {items.map((item) => {
            const completed = completedIds.has(item.id);
            return (
              <li
                className={`homework-item ${completed ? "homework-item-completed" : ""}`}
                key={item.id}
              >
                <button
                  type="button"
                  className="task-checkbox"
                  role="checkbox"
                  aria-checked={completed}
                  aria-label={`${completed ? "Позначити невиконаним" : "Позначити виконаним"}: ${item.task}`}
                  onClick={() => onToggle(item.id)}
                >
                  {completed && <Check size={14} strokeWidth={2.5} />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="task-subject-row">
                    <p className="task-subject">{item.subject}</p>
                    {item.priority === "high" && !completed && (
                      <span className="priority-badge">Терміново</span>
                    )}
                  </div>
                  <p className="task-name">{item.task}</p>
                  <p className="task-due">
                    <Clock3 size={12} />
                    {item.due}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptySearchState label="завдань" />
      )}

      <button type="button" className="text-button">
        Усі завдання
        <ChevronRight size={15} />
      </button>
    </section>
  );
}

function SubjectsCard({
  items,
  expandedId,
  onExpand,
  onOpenMaterials,
}: {
  items: SubjectItem[];
  expandedId: string | null;
  onExpand: (id: string) => void;
  onOpenMaterials: () => void;
}) {
  return (
    <section className="glass-panel content-card subjects-card" aria-labelledby="subjects-heading">
      <div className="content-card-header">
        <div>
          <p className="section-kicker">Мій прогрес</p>
          <h2 id="subjects-heading" className="section-title">
            Мої предмети
          </h2>
        </div>
        <button type="button" className="header-link">
          Переглянути всі
          <ChevronRight size={14} />
        </button>
      </div>

      {items.length > 0 ? (
        <div className="subjects-list">
          {items.map((subject, index) => {
            const expanded = expandedId === subject.id;
            return (
              <article
                className={`subject-item ${expanded ? "subject-item-expanded" : ""}`}
                key={subject.id}
              >
                <button
                  type="button"
                  className="subject-summary"
                  aria-expanded={expanded}
                  aria-controls={`subject-${subject.id}`}
                  onClick={() => onExpand(subject.id)}
                >
                  <span className={`subject-code subject-code-${index + 1}`}>{subject.code}</span>
                  <span className="subject-primary">
                    <span className="subject-title-row">
                      <strong>{subject.name}</strong>
                      <span>{subject.progress}%</span>
                    </span>
                    <span className="subject-teacher">{subject.teacher}</span>
                    <span className="progress-track" aria-hidden="true">
                      <span style={{ width: `${subject.progress}%` }} />
                    </span>
                  </span>
                  <ChevronDown
                    size={17}
                    className={`subject-chevron ${expanded ? "rotate-180" : ""}`}
                  />
                </button>
                {expanded && (
                  <div className="subject-details" id={`subject-${subject.id}`}>
                    <div>
                      <span>Завершено тем</span>
                      <strong>
                        {subject.completed} з {subject.total}
                      </strong>
                    </div>
                    <div>
                      <span>Наступне заняття</span>
                      <strong>{subject.nextClass}</strong>
                    </div>
                    <button type="button" onClick={onOpenMaterials}>
                      Відкрити матеріали
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptySearchState label="предметів" />
      )}
    </section>
  );
}

function EmptySearchState({ label }: { label: string }) {
  return (
    <div className="empty-search">
      <Search size={19} />
      <p>Збігів серед {label} не знайдено</p>
      <span>Спробуйте інший пошуковий запит</span>
    </div>
  );
}

function ComingSoonState({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <section className="glass-panel coming-soon">
      <div className="coming-soon-mark">
        <ShieldCheck size={35} />
      </div>
      <span className="section-badge">
        <Sparkles size={13} />
        Цифрова екосистема НАВС
      </span>
      <h2>{label}</h2>
      <p>
        Цей розділ готується до запуску. У демонстрації повністю доступний головний навчальний
        дашборд.
      </p>
      <button type="button" className="primary-button" onClick={onBack}>
        <LayoutDashboard size={17} />
        Повернутися до огляду
      </button>
    </section>
  );
}

export default function Dashboard({
  user,
  onLogout,
}: {
  user: SessionUser;
  onLogout: () => void;
}) {
  const [activeNavId, setActiveNavId] = useState("overview");
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [completedHomeworkIds, setCompletedHomeworkIds] = useState(
    () => new Set(["english", "cyber-test"]),
  );
  const [expandedSubjectId, setExpandedSubjectId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [scores, setScores] = useState<Scores | null>(null);
  const [ratingRefresh, setRatingRefresh] = useState(0);
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
  const [groupInfoFailed, setGroupInfoFailed] = useState(false);
  const [rank, setRank] = useState<ReturnType<typeof groupRank>>(null);
  const [now, setNow] = useState<WallClock>(() => kyivNow());

  const notificationRef = useRef<HTMLDivElement | null>(null);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 3600);
  };

  const loadScores = useCallback(async () => {
    const result = await fetchMyScores();
    if (result.ok) setScores(result.data.scores);
  }, []);

  const loadGroup = useCallback(async () => {
    const result = await fetchGroupInfo();
    if (result.ok) {
      setGroupInfo(result.data);
      setGroupInfoFailed(false);
    } else {
      setGroupInfoFailed(true);
    }
  }, []);

  const loadRank = useCallback(async () => {
    const result = await fetchGroupRatings();
    if (result.ok) setRank(groupRank(result.data.students, result.data.me));
  }, []);

  const refresh = useCallback(() => {
    void loadScores();
    void loadGroup();
    void loadRank();
  }, [loadScores, loadGroup, loadRank]);

  const saveScore = async (key: SubjectKey, value: number): Promise<string | null> => {
    const result = await saveMyScore(key, value);
    if (!result.ok) return result.error;
    setScores((current) => (current ? { ...current, [key]: result.data.value } : current));
    setRatingRefresh((n) => n + 1);
    void loadRank();
    return null;
  };

  const lessonLink = (lesson: Lesson) =>
    groupInfo?.subjectLinks.find((link) => link.key === lesson.subjectKey)?.url ?? "";

  const joinLesson = (lesson: Lesson) => {
    const url = lessonLink(lesson);
    if (!url) {
      showToast("Посилання на це заняття ще не додано. Зверніться до адміністратора.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const navigate = (id: string) => {
    setActiveNavId(id);
    setIsMobileNavOpen(false);
    setIsProfileOpen(false);
    setIsNotificationsOpen(false);
  };

  const toggleHomework = (id: string) => {
    setCompletedHomeworkIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase("uk");
  const filteredHomework = normalizedQuery
    ? homeworkItems.filter((item) =>
        `${item.subject} ${item.task}`.toLocaleLowerCase("uk").includes(normalizedQuery),
      )
    : homeworkItems;
  const filteredSubjects = normalizedQuery
    ? subjects.filter((item) =>
        `${item.name} ${item.teacher}`.toLocaleLowerCase("uk").includes(normalizedQuery),
      )
    : subjects;

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (isNotificationsOpen && !notificationRef.current?.contains(target)) {
        setIsNotificationsOpen(false);
      }
      if (isProfileOpen && !profileRef.current?.contains(target)) {
        setIsProfileOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsNotificationsOpen(false);
      setIsProfileOpen(false);
      setIsSearchOpen(false);
      if (isMobileNavOpen) {
        setIsMobileNavOpen(false);
        requestAnimationFrame(() => document.getElementById("mobile-menu-trigger")?.focus());
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobileNavOpen, isNotificationsOpen, isProfileOpen]);

  // Оцінки, рейтинг і дані групи (розклад, дата сесії, посилання) беруться з бази:
  // оновлюємо при вході, поверненні на вкладку, зміні розділу і раз на 30 с.
  useEffect(() => {
    refresh();
    const onVisible = () => {
      setNow(kyivNow());
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(onVisible, 30000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    refresh();
  }, [activeNavId, refresh]);

  useEffect(() => {
    document.body.style.overflow = isMobileNavOpen ? "hidden" : "";
    if (isMobileNavOpen) {
      requestAnimationFrame(() => document.getElementById("mobile-menu-close")?.focus());
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isMobileNavOpen]);

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const sessionStart = groupInfo?.sessionStart ?? null;
  const daysToSession = sessionStart ? daysBetween(now.date, sessionStart) : null;

  const currentSectionLabel =
    activeNavId === "profile" ? "Мій профіль" : (sectionLabels[activeNavId] ?? "Розділ");

  return (
    <UserContext.Provider value={user}>
      <div className="app-shell">
        <div className="ambient-orb ambient-orb-one" aria-hidden="true" />
        <div className="ambient-orb ambient-orb-two" aria-hidden="true" />

        <aside className="desktop-sidebar">
          <Sidebar
            activeId={activeNavId}
            onSelect={navigate}
            onLogout={onLogout}
          />
        </aside>

        {isMobileNavOpen && (
          <div className="mobile-drawer-layer" role="presentation">
            <button
              type="button"
              className="drawer-backdrop"
              aria-label="Закрити меню"
              onClick={() => {
                setIsMobileNavOpen(false);
                requestAnimationFrame(() => document.getElementById("mobile-menu-trigger")?.focus());
              }}
            />
            <aside className="mobile-drawer" aria-label="Мобільна навігація">
              <div>
                <Sidebar
                  activeId={activeNavId}
                  onSelect={navigate}
                  onClose={() => {
                    setIsMobileNavOpen(false);
                    requestAnimationFrame(() =>
                      document.getElementById("mobile-menu-trigger")?.focus(),
                    );
                  }}
                  onLogout={onLogout}
                  mobile
                />
              </div>
            </aside>
          </div>
        )}

        <div className="main-column">
          <div>
            <TopBar
              onOpenMenu={() => setIsMobileNavOpen(true)}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              searchOpen={isSearchOpen}
              onToggleSearch={() => setIsSearchOpen((value) => !value)}
              notificationsOpen={isNotificationsOpen}
              onToggleNotifications={() => {
                setIsNotificationsOpen((value) => !value);
                setIsProfileOpen(false);
              }}
              profileOpen={isProfileOpen}
              onToggleProfile={() => {
                setIsProfileOpen((value) => !value);
                setIsNotificationsOpen(false);
              }}
              onNavigate={navigate}
              onLogout={() => {
                setIsProfileOpen(false);
                onLogout();
              }}
              notificationRef={notificationRef}
              profileRef={profileRef}
            />
          </div>

          <main className="dashboard-main">
            {activeNavId === "overview" ? (
              <>
                <section className="stats-grid" aria-label="Навчальна статистика">
                  <StatCard
                    label="Середній бал"
                    value={scores ? formatAverage(averageScore(scores)) : "—"}
                    note={`за ${SUBJECTS.length} дисциплінами`}
                    icon={Target}
                    tone="blue"
                  >
                    <div className="mini-bars" aria-hidden="true">
                      {SUBJECTS.map((subject) => (
                        <i
                          key={subject.key}
                          style={{
                            height: `${Math.max(3, Math.round(((scores?.[subject.key] ?? 0) / 100) * 22))}px`,
                          }}
                        />
                      ))}
                    </div>
                  </StatCard>
                  <StatCard
                    label="Рейтинг у групі"
                    value={rank?.hasScores ? `${rank.rank} місце` : "—"}
                    note={
                      !rank
                        ? "дані недоступні"
                        : rank.hasScores
                          ? `із ${rank.total} ${pluralUk(rank.total, "студента", "студентів", "студентів")} у групі`
                          : "зʼявиться, коли будуть оцінки"
                    }
                    icon={Trophy}
                    tone="violet"
                  >
                    <span className="rank-mark" aria-hidden="true">
                      {rank?.hasScores ? `#${rank.rank}` : "—"}
                    </span>
                  </StatCard>
                  <StatCard
                    label="До сесії"
                    value={
                      sessionStart === null
                        ? "—"
                        : daysToSession! > 0
                          ? `${daysToSession} ${pluralUk(daysToSession!, "день", "дні", "днів")}`
                          : daysToSession === 0
                            ? "Сьогодні"
                            : "Триває"
                    }
                    note={
                      sessionStart === null
                        ? "дату ще не вказано"
                        : daysToSession! >= 0
                          ? `початок ${longDate(sessionStart)}`
                          : `розпочалась ${longDate(sessionStart)}`
                    }
                    icon={CalendarDays}
                    tone="cyan"
                  >
                    <span className="calendar-mark" aria-hidden="true">
                      {sessionStart ? Number(sessionStart.slice(8, 10)) : "—"}
                    </span>
                  </StatCard>
                </section>

                <div className="dashboard-grid">
                  <div className="dashboard-primary">
                    <NextClassCard
                      status={groupInfo ? "ready" : groupInfoFailed ? "error" : "loading"}
                      lessons={groupInfo?.schedule?.lessons ?? null}
                      now={now}
                      hasLink={(lesson) => lessonLink(lesson) !== ""}
                      onJoin={joinLesson}
                    />
                    <SubjectsCard
                      items={filteredSubjects}
                      expandedId={expandedSubjectId}
                      onExpand={(id) =>
                        setExpandedSubjectId((current) => (current === id ? null : id))
                      }
                      onOpenMaterials={() =>
                        showToast("Навчальні матеріали відкриються в повній версії порталу.")
                      }
                    />
                  </div>
                  <HomeworkCard
                    items={filteredHomework}
                    completedIds={completedHomeworkIds}
                    onToggle={toggleHomework}
                  />
                </div>
              </>
            ) : activeNavId === "rating" ? (
              <Rating scores={scores} onSave={saveScore} refreshKey={ratingRefresh} />
            ) : (
              <ComingSoonState label={currentSectionLabel} onBack={() => navigate("overview")} />
            )}
          </main>
        </div>

        {toast && (
          <div className="toast" role="status" aria-live="polite">
            <span>
              <Check size={15} />
            </span>
            <p>{toast}</p>
            <button type="button" aria-label="Закрити повідомлення" onClick={() => setToast(null)}>
              <X size={15} />
            </button>
          </div>
        )}
      </div>
    </UserContext.Provider>
  );
}
