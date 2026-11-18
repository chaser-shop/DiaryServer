import { PortalScheduleCard } from "./PortalScheduleCard";
import {
  Activity,
  Archive,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  FileSpreadsheet,
  Filter,
  GraduationCap,
  History,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  Upload,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import {
  createGroup,
  createStudent,
  resetStudentPassword,
  updateGrade,
  type CreatedStudent,
} from './adminApi'
import { ScheduleUploadCard, SessionDateCard, SubjectLinksCard } from './GroupParams'
import {
  addDays,
  isRemote,
  kyivNow,
  mondayOf,
  shortDate,
  type GroupSchedule,
  type SubjectLink,
} from '../schedule'

export type AcademyGroup = {
  id: string
  name: string
  faculty: string
  course: number
  academicYear: string
  curator: string
  status: string
  /** YYYY-MM-DD — початок сесії, задає адміністратор у параметрах групи */
  sessionStart?: string | null
  /** Посилання, куди приєднуватись на пари, за предметами */
  subjectLinks?: SubjectLink[]
  /** Розклад, завантажений з Excel */
  portal?: {values:string[]; labels:string[]; checkedAt:string; error:string} | null
  schedule?: GroupSchedule | null
}

export type StudentRow = {
  id: string
  fullName: string
  login: string
  password?: string
  groupId: string
  status: string
  role: string
}

export type GradeRow = {
  id: string
  studentName: string
  groupId: string
  studentId: string
  scores: Record<SubjectKey, number>
}

export type LessonRow = {
  id: string
  groupId: string
  day: string
  time: string
  subject: string
  teacher: string
  lessonType: string
  location: string
}

export type ActivityRow = {
  id: string
  summary: string
  entityType: string
  administrator: string
  createdAt: string
  previousValue?: string
  newValue?: string
}

type SubjectKey = 'kpu' | 'spou' | 'it' | 'english' | 'vds' | 'umsp' | 'sfp' | 'tidtp'
type Section =
  | 'overview'
  | 'groups'
  | 'students'
  | 'ranking'
  | 'schedule'
  | 'analytics'
  | 'history'
  | 'settings'
type GroupTab = 'overview' | 'students' | 'schedule' | 'ranking' | 'settings'

const subjects: { key: SubjectKey; label: string }[] = [
  { key: 'kpu', label: 'КПУ' },
  { key: 'spou', label: 'СПОУ' },
  { key: 'it', label: 'ІТ' },
  { key: 'english', label: 'Англійська' },
  { key: 'vds', label: 'ВДС' },
  { key: 'umsp', label: 'УМСП' },
  { key: 'sfp', label: 'СФП' },
  { key: 'tidtp', label: 'ТіДтП' },
]

const navItems: { id: Section; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Огляд', icon: LayoutDashboard },
  { id: 'groups', label: 'Групи', icon: GraduationCap },
  { id: 'students', label: 'Студенти', icon: Users },
  { id: 'ranking', label: 'Рейтинг', icon: TrendingUp },
  { id: 'schedule', label: 'Розклад', icon: CalendarDays },
  { id: 'analytics', label: 'Аналітика', icon: BarChart3 },
  { id: 'history', label: 'Історія змін', icon: History },
  { id: 'settings', label: 'Налаштування', icon: Settings },
]

const groupTabs: { id: GroupTab; label: string }[] = [
  { id: 'overview', label: 'Огляд' },
  { id: 'students', label: 'Студенти' },
  { id: 'schedule', label: 'Розклад' },
  { id: 'ranking', label: 'Рейтинг' },
  { id: 'settings', label: 'Налаштування' },
]

const total = (scores: Record<SubjectKey, number>) =>
  subjects.reduce((sum, subject) => sum + scores[subject.key], 0)
const average = (scores: Record<SubjectKey, number>) => total(scores) / subjects.length

function initials(name: string) {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
}

function Progress({ value, compact = false }: { value: number; compact?: boolean }) {
  return (
    <div
      className={
        compact ? 'h-1.5 w-20 rounded-full bg-white/8' : 'h-2 w-full rounded-full bg-white/8'
      }
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-[#2457a6] to-[#9cc4f7] shadow-[0_0_12px_rgba(52,120,212,.35)] transition-[width] duration-500"
        style={{ width: `${Math.max(0, Math.min(value, 100))}%` }}
      />
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const active = status === 'active'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
        active
          ? 'border-emerald-300/15 bg-emerald-400/8 text-emerald-300'
          : 'border-slate-300/15 bg-slate-300/8 text-slate-300'
      }`}
    >
      <span className={`size-1.5 rounded-full ${active ? 'bg-emerald-300' : 'bg-slate-400'}`} />
      {active ? 'Активна' : 'Архівна'}
    </span>
  )
}

export default function AcademyDashboard({
  initialGroups,
  initialGrades,
  initialLessons,
  initialActivity,
  initialStudents,
  canManage,
  adminName,
  onLogout,
}: {
  initialGroups: AcademyGroup[]
  initialGrades: GradeRow[]
  initialLessons: LessonRow[]
  initialActivity: ActivityRow[]
  initialStudents: StudentRow[]
  canManage: boolean
  adminName: string
  onLogout: () => void
}) {
  const [groups, setGroups] = useState(initialGroups)
  const [students, setStudents] = useState(initialStudents)
  const [created, setCreated] = useState<CreatedStudent | null>(null)
  const [section, setSection] = useState<Section>('overview')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState(
    initialGrades[0]?.groupId ?? initialGroups[0]?.id ?? '',
  )
  const [groupTab, setGroupTab] = useState<GroupTab>('overview')
  const [grades, setGrades] = useState(initialGrades)
  const [activities, setActivities] = useState(initialActivity)
  const [studentMode, setStudentMode] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [modal, setModal] = useState<'group' | 'student' | 'import' | null>(null)

  const selectedGroup =
    groups.find((group) => group.id === selectedGroupId) ?? groups[0]
  const groupGrades = useMemo(
    () =>
      grades
        .filter((row) => !selectedGroupId || row.groupId === selectedGroupId)
        .sort((a, b) => average(b.scores) - average(a.scores)),
    [grades, selectedGroupId],
  )
  const allAverage = grades.length
    ? grades.reduce((sum, row) => sum + average(row.scores), 0) / grades.length
    : 0
  const currentStudent = groupGrades[2] ?? groupGrades[0]
  const currentRank = currentStudent
    ? groupGrades.findIndex((row) => row.id === currentStudent.id) + 1
    : 0

  function flash(text: string) {
    setNotice(text)
    window.setTimeout(() => setNotice(''), 2800)
  }

  function replaceGroup(group: AcademyGroup) {
    setGroups((items) => items.map((item) => (item.id === group.id ? group : item)))
  }

  function openGroupSettings() {
    setGroupTab('settings')
    setSection('groups')
  }

  function goTo(id: Section) {
    setSection(id)
    setMobileOpen(false)
  }

  function updateScore(rowId: string, key: SubjectKey, value: number) {
    const safe = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
    const row = grades.find((item) => item.id === rowId)
    if (!row) return
    const previous = row.scores[key]
    setGrades((items) =>
      items.map((item) =>
        item.id === rowId ? { ...item, scores: { ...item.scores, [key]: safe } } : item,
      ),
    )
    const subject = subjects.find((item) => item.key === key)?.label ?? key
    void updateGrade(rowId, key, safe).then((result) => {
      if (!result.ok) {
        setGrades((items) =>
          items.map((item) =>
            item.id === rowId ? { ...item, scores: { ...item.scores, [key]: previous } } : item,
          ),
        )
        setNotice(result.error)
        window.setTimeout(() => setNotice(''), 2800)
      }
    })
    setActivities((items) => [
      {
        id: `${Date.now()}`,
        summary: `Змінено оцінку з дисципліни «${subject}» для ${row.studentName}`,
        entityType: 'grade',
        administrator: adminName,
        createdAt: new Date().toISOString(),
        previousValue: String(previous),
        newValue: String(safe),
      },
      ...items,
    ])
    setNotice('Оцінку оновлено. Рейтинг перераховано автоматично.')
    window.setTimeout(() => setNotice(''), 2800)
  }

  const filteredGroups = groups.filter((group) =>
    `${group.name} ${group.faculty} ${group.curator}`.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <div className="min-h-screen bg-[#071426] text-[#f3f6fa]">
      <div className="fixed inset-0 pointer-events-none bg-[repeating-linear-gradient(90deg,rgba(102,143,187,.025)_0_1px,transparent_1px_70px),repeating-linear-gradient(0deg,rgba(102,143,187,.022)_0_1px,transparent_1px_70px),radial-gradient(circle_at_85%_-10%,rgba(36,87,166,.2),transparent_36%),radial-gradient(circle_at_24%_110%,rgba(181,154,99,.08),transparent_40%)]" />
      <div className="relative flex min-h-screen">
        {mobileOpen && (
          <button
            aria-label="Закрити меню"
            className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-[286px] flex-col border-r border-white/7 bg-[#0b1d35]/96 px-4 py-5 backdrop-blur-2xl transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="mb-7 flex items-center gap-3 px-2">
            <div className="relative grid size-12 shrink-0 place-items-center rounded-2xl border border-blue-300/15 bg-blue-500/8">
              <img
                src="/navs-emblem.png"
                alt="Емблема НАВС"
                width={42}
                height={42}
                className="object-contain"
              />
              <div className="absolute inset-0 -z-10 rounded-full bg-blue-500/25 blur-xl" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <strong className="text-[18px] tracking-[0.18em]">НАВС</strong>
                <span className="size-1 rounded-full bg-blue-400 shadow-[0_0_8px_#67a6f4]" />
              </div>
              <p className="truncate text-[10px] uppercase tracking-[0.16em] text-slate-500">
                Цифрова академія 2050
              </p>
            </div>
            <button
              className="ml-auto grid size-9 place-items-center rounded-xl text-slate-400 hover:bg-white/5 lg:hidden"
              aria-label="Закрити меню"
              onClick={() => setMobileOpen(false)}
            >
              <X size={18} />
            </button>
          </div>

          <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-600">
            Робочий простір
          </p>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  onClick={() => goTo(item.id)}
                  className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                    section === item.id && !studentMode
                      ? 'border border-blue-300/12 bg-gradient-to-r from-blue-500/17 to-blue-500/5 text-white shadow-[inset_0_1px_rgba(255,255,255,.04)]'
                      : 'border border-transparent text-slate-400 hover:bg-white/4 hover:text-slate-100'
                  }`}
                >
                  <Icon
                    size={17}
                    className={section === item.id ? 'text-blue-400' : 'text-slate-500'}
                  />
                  <span>{item.label}</span>
                  {item.id === 'history' && (
                    <span className="ml-auto rounded-full bg-blue-500/12 px-2 py-0.5 text-[10px] text-blue-300">
                      {activities.length}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>

          <div className="mt-auto space-y-3">
            <button
              onClick={() => setStudentMode((value) => !value)}
              className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition ${
                studentMode
                  ? 'border-blue-400/30 bg-blue-500/12'
                  : 'border-white/7 bg-white/[.025] hover:bg-white/[.045]'
              }`}
            >
              <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-[#2457a6] to-[#142b45] text-xs font-bold ring-1 ring-white/10">
                {currentStudent ? initials(currentStudent.studentName) : initials(adminName) || 'А'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">
                  {studentMode ? 'Режим студента' : adminName}
                </p>
                <p className="mt-0.5 truncate text-[10px] text-slate-500">
                  {studentMode
                    ? (currentStudent?.studentName ?? 'Студент')
                    : 'Адміністратор'}
                </p>
              </div>
              <ChevronRight size={15} className="text-slate-600" />
            </button>
            <div className="flex items-center justify-between px-2 text-[10px] text-slate-600">
              <a href="/" className="hover:text-slate-300">
                ← Щоденник
              </a>
              <button onClick={onLogout} className="hover:text-slate-300">
                Вийти
              </button>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 border-b border-white/6 bg-[#071426]/82 px-4 py-3 backdrop-blur-2xl sm:px-6 xl:px-8">
            <div className="mx-auto flex max-w-[1560px] items-center gap-3">
              <button
                className="grid size-10 place-items-center rounded-xl border border-white/8 bg-white/[.035] lg:hidden"
                aria-label="Відкрити меню"
                onClick={() => setMobileOpen(true)}
              >
                <Menu size={19} />
              </button>
              <div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex">
                <span>Адміністрування</span>
                <ChevronRight size={13} />
                <span className="text-slate-300">
                  {studentMode
                    ? 'Мій кабінет'
                    : navItems.find((item) => item.id === section)?.label}
                </span>
              </div>
              <label className="ml-auto hidden w-full max-w-[310px] items-center gap-2 rounded-xl border border-white/7 bg-white/[.035] px-3 py-2.5 md:flex">
                <Search size={16} className="text-slate-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Пошук у системі…"
                  className="w-full bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600"
                />
                <kbd className="rounded border border-white/8 px-1.5 py-0.5 text-[9px] text-slate-600">
                  ⌘К
                </kbd>
              </label>
              <button
                className="relative grid size-10 place-items-center rounded-xl border border-white/7 bg-white/[.035] text-slate-400 hover:text-white"
                aria-label="Сповіщення"
              >
                <Bell size={17} />
                <span className="absolute right-2 top-2 size-1.5 rounded-full bg-blue-400 ring-2 ring-[#071426]" />
              </button>
              <button
                className="hidden items-center gap-2 rounded-xl border border-white/7 bg-white/[.035] px-2 py-1.5 sm:flex"
                onClick={() => setStudentMode((value) => !value)}
              >
                <div className="grid size-7 place-items-center rounded-lg bg-blue-500/20 text-[10px] font-bold">
                  {initials(adminName) || 'А'}
                </div>
                <span className="text-[11px] font-medium">{adminName}</span>
                <ChevronDown size={13} className="text-slate-500" />
              </button>
            </div>
          </header>

          <main className="mx-auto max-w-[1560px] p-4 sm:p-6 xl:p-8">
            {studentMode ? (
              <StudentHomepage
                student={currentStudent}
                rank={currentRank}
                groupCount={groupGrades.length}
                peers={groupGrades}
                activities={activities}
              />
            ) : (
              <>
                <PageHeading
                  eyebrow="П’ятниця, 14 березня 2050"
                  title={navItems.find((item) => item.id === section)?.label ?? 'Огляд'}
                  description={
                    section === 'overview'
                      ? 'Оперативна картина академічного процесу в реальному часі.'
                      : 'Керуйте даними академії в єдиному захищеному середовищі.'
                  }
                  action={
                    section === 'groups'
                      ? { label: 'Створити групу', icon: Plus, onClick: () => setModal('group') }
                      : section === 'students' && canManage
                        ? {
                            label: 'Створити студента',
                            icon: Plus,
                            onClick: () => setModal('student'),
                          }
                        : section === 'schedule'
                          ? {
                              label: 'Завантажити розклад',
                              icon: Upload,
                              onClick: openGroupSettings,
                            }
                          : undefined
                  }
                />
                {section === 'overview' && (
                  <Overview
                    groups={groups}
                    grades={grades}
                    activities={activities}
                    allAverage={allAverage}
                    onNavigate={goTo}
                  />
                )}
                {section === 'groups' && (
                  <GroupsSection
                    groups={filteredGroups}
                    selectedGroup={selectedGroup}
                    setSelectedGroupId={setSelectedGroupId}
                    tab={groupTab}
                    setTab={setGroupTab}
                    grades={groupGrades}
                    updateScore={updateScore}
                    onArchive={() => setConfirm('archive')}
                    onDelete={() => setConfirm('delete')}
                    onGroupSaved={replaceGroup}
                    notify={flash}
                  />
                )}
                {section === 'students' && (
                  <StudentsSection
                    grades={grades}
                    groups={groups}
                    students={students}
                    canManage={canManage}
                    onImport={() => setModal('import')}
                    onPasswordReset={(id, password) =>
                      setStudents((items) =>
                        items.map((item) => (item.id === id ? { ...item, password } : item)),
                      )
                    }
                    onNotice={(text) => {
                      setNotice(text)
                      window.setTimeout(() => setNotice(''), 2800)
                    }}
                  />
                )}
                {section === 'ranking' && (
                  <RankingTable
                    rows={groupGrades}
                    group={selectedGroup}
                    updateScore={updateScore}
                  />
                )}
                {section === 'schedule' && (
                  <>{selectedGroup && <PortalScheduleCard key={selectedGroup.id} group={selectedGroup} onSaved={replaceGroup}/>}
                  <ScheduleSection
                    group={selectedGroup}
                    groups={groups}
                    onSelectGroup={setSelectedGroupId}
                    onOpenSettings={openGroupSettings}
                  /></>
                )}
                {section === 'analytics' && (
                  <AnalyticsSection grades={grades} groups={groups} />
                )}
                {section === 'history' && <HistorySection activities={activities} />}
                {section === 'settings' && <SettingsSection />}
              </>
            )}
          </main>
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-[80] max-w-sm rounded-2xl border border-blue-300/20 bg-[#0b1d35]/95 px-4 py-3 text-sm shadow-2xl backdrop-blur-xl"
        >
          <div className="flex items-center gap-3">
            <div className="grid size-8 place-items-center rounded-xl bg-blue-500/15 text-blue-300">
              <ShieldCheck size={16} />
            </div>
            {notice}
          </div>
        </div>
      )}
      {modal === 'student' && (
        <StudentCreateModal
          groups={groups}
          onClose={() => setModal(null)}
          onCreated={(student) => {
            setModal(null)
            setCreated(student)
            setStudents((items) =>
              [
                ...items,
                {
                  id: student.id,
                  fullName: student.fullName,
                  login: student.login,
                  password: student.password,
                  groupId: student.groupId,
                  status: 'active',
                  role: 'student',
                },
              ].sort((a, b) => a.fullName.localeCompare(b.fullName, 'uk')),
            )
            setGrades((items) => [
              ...items,
              {
                id: student.gradeId,
                studentName: student.fullName,
                groupId: student.groupId,
                studentId: student.id,
                scores: { kpu: 0, spou: 0, it: 0, english: 0, vds: 0, umsp: 0, sfp: 0, tidtp: 0 },
              },
            ])
          }}
        />
      )}
      {created && <CredentialsModal student={created} onClose={() => setCreated(null)} />}
      {modal === 'group' && (
        <GroupCreateModal
          onClose={() => setModal(null)}
          onCreated={(group) => {
            setModal(null)
            setGroups((items) => [...items, group].sort((a, b) => a.name.localeCompare(b.name, 'uk')))
            setNotice(`Групу ${group.name} створено.`)
            window.setTimeout(() => setNotice(''), 2800)
          }}
        />
      )}
      {modal === 'import' && <ActionModal type="import" onClose={() => setModal(null)} />}
      {confirm && (
        <ConfirmDialog
          type={confirm}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            setNotice(confirm === 'delete' ? 'Групу переміщено до кошика.' : 'Групу архівовано.')
          }}
        />
      )}
    </div>
  )
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: { label: string; icon: typeof Plus; onClick: () => void }
}) {
  const Icon = action?.icon
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.19em] text-[#b59a63]">
          {eyebrow}
        </p>
        <h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-[32px]">{title}</h1>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-500">{description}</p>
      </div>
      {action && Icon && (
        <button
          onClick={action.onClick}
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#2457a6] px-4 text-xs font-semibold text-white shadow-[0_10px_28px_rgba(36,87,166,.28)] hover:bg-[#3478d4]"
        >
          <Icon size={16} /> {action.label}
        </button>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  trend,
}: {
  label: string
  value: string
  detail: string
  icon: typeof Users
  trend?: string
}) {
  return (
    <article className="group relative overflow-hidden rounded-2xl border border-white/7 bg-gradient-to-br from-white/[.055] to-white/[.018] p-4 shadow-[inset_0_1px_rgba(255,255,255,.035)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-blue-300/15 sm:p-5">
      <div className="absolute -right-8 -top-8 size-28 rounded-full bg-blue-500/8 blur-2xl transition group-hover:bg-blue-500/14" />
      <div className="flex items-start justify-between">
        <div className="grid size-9 place-items-center rounded-xl border border-blue-300/10 bg-blue-500/8 text-blue-300">
          <Icon size={17} />
        </div>
        {trend && (
          <span className="rounded-full bg-emerald-400/8 px-2 py-1 text-[10px] text-emerald-300">
            {trend}
          </span>
        )}
      </div>
      <p className="mt-5 text-[11px] text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-[-0.04em] tabular-nums">{value}</p>
      <p className="mt-2 text-[10px] text-slate-600">{detail}</p>
    </article>
  )
}

function Overview({
  groups,
  grades,
  activities,
  allAverage,
  onNavigate,
}: {
  groups: AcademyGroup[]
  grades: GradeRow[]
  activities: ActivityRow[]
  allAverage: number
  onNavigate: (section: Section) => void
}) {
  const best = [...grades].sort((a, b) => average(b.scores) - average(a.scores)).slice(0, 5)
  return (
    <>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="Усього груп"
          value={String(groups.length)}
          detail="У поточному навчальному році"
          icon={GraduationCap}
        />
        <StatCard
          label="Студентів"
          value={String(grades.length)}
          detail="Профілі синхронізовано"
          icon={Users}
          trend="+4,2%"
        />
        <StatCard
          label="Активні групи"
          value={String(groups.filter((group) => group.status === 'active').length)}
          detail="Навчальний процес триває"
          icon={Activity}
        />
        <StatCard
          label="Середній бал"
          value={allAverage.toFixed(1)}
          detail="Серед усіх дисциплін"
          icon={TrendingUp}
          trend="+2,8%"
        />
      </section>
      <section className="mt-4 grid gap-4 xl:grid-cols-[1.45fr_.8fr]">
        <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Динаміка успішності</p>
              <p className="mt-1 text-[10px] text-slate-600">
                Середній бал академії за останні 8 місяців
              </p>
            </div>
            <button className="flex items-center gap-2 rounded-xl border border-white/7 bg-white/[.025] px-3 py-2 text-[10px] text-slate-400">
              <SlidersHorizontal size={13} /> Навчальний рік
            </button>
          </div>
          <div className="relative h-56 overflow-hidden rounded-xl border border-white/5 bg-[#0b1d35]/70 p-4">
            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:100%_44px,12.5%_100%]" />
            <svg
              className="relative h-full w-full"
              viewBox="0 0 700 180"
              preserveAspectRatio="none"
              aria-label="Графік динаміки успішності"
            >
              <defs>
                <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#3478d4" stopOpacity=".3" />
                  <stop offset="1" stopColor="#3478d4" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d="M0 142 C70 132 92 105 155 111 S250 92 310 99 S410 62 468 71 S565 38 700 28 L700 180 L0 180Z"
                fill="url(#area)"
              />
              <path
                d="M0 142 C70 132 92 105 155 111 S250 92 310 99 S410 62 468 71 S565 38 700 28"
                fill="none"
                stroke="#3478d4"
                strokeWidth="3"
              />
            </svg>
            <div className="absolute bottom-3 left-4 right-4 flex justify-between text-[9px] text-slate-700">
              {['Вер', 'Жов', 'Лис', 'Гру', 'Січ', 'Лют', 'Бер', 'Кві'].map((month) => (
                <span key={month}>{month}</span>
              ))}
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold">Остання активність</p>
            <button
              onClick={() => onNavigate('history')}
              className="text-[10px] text-blue-400 hover:text-blue-300"
            >
              Уся історія
            </button>
          </div>
          <div className="space-y-1">
            {activities.slice(0, 5).map((item) => (
              <div key={item.id} className="flex gap-3 border-b border-white/5 py-3 last:border-0">
                <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-blue-500/8 text-blue-400">
                  <History size={14} />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] leading-4 text-slate-300">{item.summary}</p>
                  <p className="mt-1 text-[9px] text-slate-600">
                    {item.administrator} · {new Date(item.createdAt).toLocaleDateString('uk-UA')}
                  </p>
                </div>
              </div>
            ))}
            {!activities.length && (
              <EmptyState
                title="Подій ще немає"
                description="Зміни в системі з’являться тут автоматично."
              />
            )}
          </div>
        </div>
      </section>
      <section className="mt-4 rounded-2xl border border-white/7 bg-white/[.025] p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Лідери академії</p>
            <p className="mt-1 text-[10px] text-slate-600">Найвищий середній бал</p>
          </div>
          <button
            onClick={() => onNavigate('ranking')}
            className="flex items-center gap-1 text-[10px] text-blue-400"
          >
            Перейти до рейтингу <ChevronRight size={13} />
          </button>
        </div>
        <div className="grid gap-2 md:grid-cols-5">
          {best.map((student, index) => (
            <div key={student.id} className="rounded-xl border border-white/6 bg-white/[.02] p-3">
              <div className="flex items-center gap-3">
                <span
                  className={`grid size-7 place-items-center rounded-lg text-[10px] font-bold ${index < 3 ? 'bg-blue-500/16 text-blue-300' : 'bg-white/5 text-slate-500'}`}
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium">{student.studentName}</p>
                  <p className="mt-1 text-[10px] text-slate-600">
                    {average(student.scores).toFixed(1)} бала
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

function Toolbar({ onImport }: { onImport?: () => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <label className="flex min-h-10 min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-white/7 bg-white/[.025] px-3">
        <Search size={15} className="text-slate-600" />
        <input
          className="w-full bg-transparent text-xs outline-none placeholder:text-slate-700"
          placeholder="Пошук…"
        />
      </label>
      <button className="flex min-h-10 items-center gap-2 rounded-xl border border-white/7 bg-white/[.025] px-3 text-[10px] text-slate-400">
        <Filter size={14} /> Фільтри
      </button>
      {onImport && (
        <button
          onClick={onImport}
          className="flex min-h-10 items-center gap-2 rounded-xl border border-white/7 bg-white/[.025] px-3 text-[10px] text-slate-400"
        >
          <FileSpreadsheet size={14} /> Імпорт Excel / CSV
        </button>
      )}
    </div>
  )
}

function GroupsSection({
  groups,
  selectedGroup,
  setSelectedGroupId,
  tab,
  setTab,
  grades,
  updateScore,
  onArchive,
  onDelete,
  onGroupSaved,
  notify,
}: {
  groups: AcademyGroup[]
  selectedGroup?: AcademyGroup
  setSelectedGroupId: (id: string) => void
  tab: GroupTab
  setTab: (tab: GroupTab) => void
  grades: GradeRow[]
  updateScore: (id: string, key: SubjectKey, value: number) => void
  onArchive: () => void
  onDelete: () => void
  onGroupSaved: (group: AcademyGroup) => void
  notify: (text: string) => void
}) {
  if (selectedGroup && tab !== 'overview') {
    return (
      <div>
        <button
          onClick={() => setTab('overview')}
          className="mb-4 flex items-center gap-1 text-[11px] text-slate-500 hover:text-white"
        >
          Групи <ChevronRight size={12} /> {selectedGroup.name}
        </button>
        <div className="mb-4 rounded-2xl border border-white/7 bg-gradient-to-r from-blue-500/9 to-white/[.02] p-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold">{selectedGroup.name}</h2>
                <StatusPill status={selectedGroup.status} />
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                {selectedGroup.faculty} · {selectedGroup.course} курс · {selectedGroup.academicYear}
              </p>
            </div>
            <button className="flex items-center gap-2 self-start rounded-xl border border-white/8 px-3 py-2 text-[10px] text-slate-400">
              <Pencil size={13} /> Редагувати
            </button>
          </div>
          <div className="mt-5 flex gap-1 overflow-x-auto border-b border-white/6">
            {groupTabs.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`whitespace-nowrap border-b-2 px-4 py-3 text-[11px] transition ${tab === item.id ? 'border-blue-400 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {tab === 'students' && (
          <RankingTable rows={grades} group={selectedGroup} updateScore={updateScore} simple />
        )}
        {tab === 'ranking' && (
          <RankingTable rows={grades} group={selectedGroup} updateScore={updateScore} />
        )}
        {tab === 'schedule' && (
          <><PortalScheduleCard key={selectedGroup.id} group={selectedGroup} onSaved={onGroupSaved}/><ScheduleSection group={selectedGroup} onOpenSettings={() => setTab('settings')} /></>
        )}
        {tab === 'settings' && (
          <>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
              <p className="text-sm font-semibold">Параметри групи</p>
              <FormGrid group={selectedGroup} />
            </div>
            <div className="rounded-2xl border border-rose-300/10 bg-rose-500/[.025] p-5">
              <p className="text-sm font-semibold">Керування статусом</p>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                Архівування збереже всі дані. Видалення потребує додаткового підтвердження.
              </p>
              <div className="mt-5 flex gap-2">
                <button
                  onClick={onArchive}
                  className="flex items-center gap-2 rounded-xl border border-white/8 px-3 py-2 text-[10px]"
                >
                  <Archive size={13} /> Архівувати
                </button>
                <button
                  onClick={onDelete}
                  className="flex items-center gap-2 rounded-xl border border-rose-300/15 bg-rose-500/8 px-3 py-2 text-[10px] text-rose-300"
                >
                  <Trash2 size={13} /> Видалити
                </button>
              </div>
            </div>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <SessionDateCard
              key={`session-${selectedGroup.id}`}
              group={selectedGroup}
              onSaved={onGroupSaved}
              notify={notify}
            />
            <ScheduleUploadCard
              key={`schedule-${selectedGroup.id}`}
              group={selectedGroup}
              onSaved={onGroupSaved}
              notify={notify}
            />
          </div>
          <div className="mt-4">
            <SubjectLinksCard
              key={`links-${selectedGroup.id}`}
              group={selectedGroup}
              knownSubjects={subjects}
              onSaved={onGroupSaved}
              notify={notify}
            />
          </div>
          </>
        )}
      </div>
    )
  }
  return (
    <>
      <Toolbar />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <button
            key={group.id}
            onClick={() => {
              setSelectedGroupId(group.id)
              setTab('students')
            }}
            className="group rounded-2xl border border-white/7 bg-white/[.025] p-5 text-left transition hover:-translate-y-0.5 hover:border-blue-300/20 hover:bg-blue-500/[.045]"
          >
            <div className="flex items-start justify-between">
              <div className="grid size-10 place-items-center rounded-xl border border-blue-300/10 bg-blue-500/9 text-blue-300">
                <GraduationCap size={18} />
              </div>
              <MoreHorizontal size={17} className="text-slate-700" />
            </div>
            <div className="mt-5 flex items-center gap-2">
              <h3 className="text-base font-semibold">{group.name}</h3>
              <StatusPill status={group.status} />
            </div>
            <p className="mt-2 min-h-8 text-[11px] leading-4 text-slate-500">{group.faculty}</p>
            <div className="mt-5 grid grid-cols-3 border-t border-white/6 pt-4 text-[10px]">
              <div>
                <p className="text-slate-700">Курс</p>
                <p className="mt-1 text-slate-300">{group.course}</p>
              </div>
              <div>
                <p className="text-slate-700">Студентів</p>
                <p className="mt-1 text-slate-300">
                  {group.id === selectedGroup?.id ? grades.length : '—'}
                </p>
              </div>
              <div>
                <p className="text-slate-700">Куратор</p>
                <p className="mt-1 truncate text-slate-300">
                  {group.curator.split(' ').slice(0, 2).join(' ')}
                </p>
              </div>
            </div>
          </button>
        ))}
        {!groups.length && (
          <EmptyState
            title="Груп не знайдено"
            description="Змініть фільтри або створіть нову групу."
          />
        )}
      </div>
    </>
  )
}

function FormGrid({ group }: { group: AcademyGroup }) {
  const fields = [
    ['Назва групи', group.name],
    ['Факультет', group.faculty],
    ['Курс', String(group.course)],
    ['Навчальний рік', group.academicYear],
    ['Куратор', group.curator],
    ['Статус групи', group.status === 'active' ? 'Активна' : 'Архівна'],
  ]
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      {fields.map(([label, value]) => (
        <label key={label} className="text-[10px] text-slate-600">
          {label}
          <input
            defaultValue={value}
            className="mt-2 w-full rounded-xl border border-white/7 bg-white/[.025] px-3 py-2.5 text-[11px] text-slate-300 outline-none focus:border-blue-400/35"
          />
        </label>
      ))}
      <button className="mt-2 rounded-xl bg-blue-600 px-4 py-2.5 text-[11px] font-semibold sm:col-span-2">
        Зберегти зміни
      </button>
    </div>
  )
}

function RankingTable({
  rows,
  group,
  updateScore,
  simple = false,
}: {
  rows: GradeRow[]
  group?: AcademyGroup
  updateScore: (id: string, key: SubjectKey, value: number) => void
  simple?: boolean
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-white/7 bg-white/[.025]">
      <div className="flex flex-col justify-between gap-3 border-b border-white/6 p-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm font-semibold">
            {simple ? 'Студенти групи' : 'Рейтинг групи'} {group?.name}
          </p>
          <p className="mt-1 text-[10px] text-slate-600">
            Оцінки 0–100 · сортування за середнім балом
          </p>
        </div>
        <div className="flex gap-2">
          <button className="rounded-xl border border-white/7 px-3 py-2 text-[10px] text-slate-400">
            <Download size={13} className="mr-2 inline" />
            Експорт
          </button>
          <button className="rounded-xl border border-white/7 px-3 py-2 text-[10px] text-slate-400">
            <Filter size={13} className="mr-2 inline" />
            Фільтри
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] text-left">
          <thead className="bg-white/[.018] text-[9px] uppercase tracking-[.12em] text-slate-600">
            <tr>
              <th className="px-4 py-3">Місце</th>
              <th className="px-4 py-3">Студент</th>
              {subjects.map((subject) => (
                <th key={subject.key} className="px-2 py-3 text-center">
                  {subject.label}
                </th>
              ))}
              <th className="px-3 py-3 text-center">Разом</th>
              <th className="px-3 py-3">Середній</th>
              <th className="px-4 py-3">Прогрес</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.id}
                className="border-t border-white/5 text-[11px] transition hover:bg-white/[.02]"
              >
                <td className="px-4 py-3">
                  <span
                    className={`grid size-7 place-items-center rounded-lg font-bold ${index < 3 ? 'bg-blue-500/14 text-blue-300' : 'text-slate-600'}`}
                  >
                    {index + 1}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="grid size-8 place-items-center rounded-xl bg-gradient-to-br from-blue-500/25 to-slate-700/30 text-[9px] font-bold">
                      {initials(row.studentName)}
                    </div>
                    <div>
                      <p className="whitespace-nowrap font-medium text-slate-200">
                        {row.studentName}
                      </p>
                      <p className="mt-0.5 text-[9px] text-slate-700">Статус: навчається</p>
                    </div>
                  </div>
                </td>
                {subjects.map((subject) => (
                  <td key={subject.key} className="px-1 py-3 text-center">
                    <input
                      aria-label={`${subject.label}, ${row.studentName}`}
                      type="number"
                      min="0"
                      max="100"
                      value={row.scores[subject.key]}
                      onChange={(event) =>
                        updateScore(row.id, subject.key, Number(event.target.value))
                      }
                      className="w-12 rounded-lg border border-transparent bg-transparent px-1 py-1.5 text-center text-[11px] tabular-nums outline-none hover:border-white/10 hover:bg-white/5 focus:border-blue-400/40 focus:bg-blue-500/8"
                    />
                  </td>
                ))}
                <td className="px-3 py-3 text-center font-semibold tabular-nums text-slate-300">
                  {total(row.scores)}
                </td>
                <td className="px-3 py-3 font-semibold tabular-nums text-blue-300">
                  {average(row.scores).toFixed(1)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Progress value={average(row.scores)} compact />
                    <span className="text-[9px] tabular-nums text-slate-600">
                      {Math.round(average(row.scores))}%
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <EmptyState
          title="Студентів ще немає"
          description="Додайте студентів або імпортуйте список із таблиці."
        />
      )}
    </section>
  )
}

type StudentCard = {
  id: string
  name: string
  groupId: string
  status: string
  login?: string
  password?: string
  scores?: Record<SubjectKey, number>
}

const studentStatusLabel: Record<string, string> = {
  active: 'навчається',
  leave: 'академічна відпустка',
  expelled: 'відраховано',
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Копіювати: ${label}`}
      title={`Копіювати: ${label}`}
      onClick={async () => {
        if (await copyText(value)) {
          setDone(true)
          window.setTimeout(() => setDone(false), 1600)
        }
      }}
      className="grid size-7 shrink-0 place-items-center rounded-lg border border-white/8 bg-white/[.04] text-slate-400 transition hover:text-white"
    >
      {done ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />}
    </button>
  )
}

function CredentialRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[9px] uppercase tracking-[0.12em] text-slate-600">
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate rounded-lg bg-black/20 px-2 py-1.5 font-mono text-[11px] text-slate-200 select-all">
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  )
}

function StudentsSection({
  grades,
  groups,
  students,
  canManage,
  onImport,
  onPasswordReset,
  onNotice,
}: {
  grades: GradeRow[]
  groups: AcademyGroup[]
  students: StudentRow[]
  canManage: boolean
  onImport: () => void
  onPasswordReset: (id: string, password: string) => void
  onNotice: (text: string) => void
}) {
  const [groupFilter, setGroupFilter] = useState('')
  const [search, setSearch] = useState('')
  const [resettingId, setResettingId] = useState<string | null>(null)

  const cards: StudentCard[] = canManage
    ? students.map((student) => ({
        id: student.id,
        name: student.fullName,
        groupId: student.groupId,
        status: student.status,
        login: student.login,
        password: student.password,
        scores: grades.find((grade) => grade.studentId === student.id)?.scores,
      }))
    : grades.map((grade) => ({
        id: grade.id,
        name: grade.studentName,
        groupId: grade.groupId,
        status: 'active',
        scores: grade.scores,
      }))

  const visible = cards.filter(
    (card) =>
      (!groupFilter || card.groupId === groupFilter) &&
      `${card.name} ${card.login ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()),
  )

  async function reset(card: StudentCard) {
    if (!window.confirm(`Скинути пароль для ${card.name}? Старий пароль перестане діяти.`)) return
    setResettingId(card.id)
    const result = await resetStudentPassword(card.id)
    setResettingId(null)
    if (result.ok) {
      onPasswordReset(card.id, result.password)
      onNotice('Новий тимчасовий пароль створено.')
    } else {
      onNotice(result.error)
    }
  }

  return (
    <>
      {!canManage && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-[#b59a63]/25 bg-[#b59a63]/[.06] p-4 text-xs text-slate-300">
          <KeyRound size={16} className="mt-0.5 shrink-0 text-[#b59a63]" />
          <p className="leading-5">
            Щоб створювати студентів і бачити їхні логіни та паролі, увійдіть як адміністратор через{' '}
            <a href="/admin" className="font-semibold text-blue-300 underline underline-offset-2">
              /admin
            </a>{' '}
            і поверніться на цю сторінку.
          </p>
        </div>
      )}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <label className="flex flex-1 items-center gap-2 rounded-xl border border-white/7 bg-white/[.035] px-3 py-2.5">
          <Search size={15} className="text-slate-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Пошук за ПІБ або логіном…"
            className="w-full bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600"
          />
        </label>
        <select
          value={groupFilter}
          onChange={(event) => setGroupFilter(event.target.value)}
          className="rounded-xl border border-white/7 bg-[#0b1d35] px-3 py-2.5 text-xs text-slate-200 outline-none focus:border-blue-400/40"
        >
          <option value="">Усі групи</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <button
          onClick={onImport}
          className="flex items-center justify-center gap-2 rounded-xl border border-white/7 bg-white/[.035] px-3 py-2.5 text-xs text-slate-300 hover:text-white"
        >
          <Upload size={14} /> Імпорт
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible.length === 0 && (
          <EmptyState
            title="Студентів не знайдено"
            description={
              canManage
                ? 'Натисніть «Створити студента», щоб додати першого.'
                : 'Змініть фільтр або пошуковий запит.'
            }
          />
        )}
        {visible.map((student) => {
          const group = groups.find((item) => item.id === student.groupId)
          return (
            <article
              key={student.id}
              className="rounded-2xl border border-white/7 bg-white/[.025] p-5"
            >
              <div className="flex items-start gap-3">
                <div className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-blue-500/25 to-[#142b45] text-xs font-bold">
                  {initials(student.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{student.name}</p>
                  <p className="mt-1 text-[10px] text-slate-600">
                    {group?.name ?? 'Без групи'} · {studentStatusLabel[student.status] ?? student.status}
                  </p>
                </div>
              </div>
              {canManage && student.login && (
                <div className="mt-4 space-y-2 rounded-xl border border-white/6 bg-black/10 p-3">
                  <CredentialRow label="Логін" value={student.login} />
                  {student.password ? (
                    <CredentialRow label="Пароль" value={student.password} />
                  ) : (
                    <p className="text-[10px] text-slate-600">
                      Тимчасовий пароль не збережено — скиньте пароль, щоб видати новий.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={resettingId === student.id}
                    onClick={() => reset(student)}
                    className="flex items-center gap-1.5 pt-1 text-[10px] font-semibold text-blue-300 hover:text-white disabled:opacity-50"
                  >
                    {resettingId === student.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RotateCcw size={12} />
                    )}
                    Скинути пароль
                  </button>
                </div>
              )}
              {student.scores && (
                <>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <MiniMetric label="Середній" value={average(student.scores).toFixed(1)} />
                    <MiniMetric label="Разом" value={String(total(student.scores))} />
                    <MiniMetric label="Прогрес" value={`${Math.round(average(student.scores))}%`} />
                  </div>
                  <div className="mt-4">
                    <Progress value={average(student.scores)} />
                  </div>
                </>
              )}
            </article>
          )
        })}
      </div>
    </>
  )
}

function StudentCreateModal({
  groups,
  onClose,
  onCreated,
}: {
  groups: AcademyGroup[]
  onClose: () => void
  onCreated: (student: CreatedStudent) => void
}) {
  const available = groups.filter((group) => group.status !== 'archived')
  const [fullName, setFullName] = useState('')
  const [groupId, setGroupId] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    setError('')
    setSubmitting(true)
    try {
      const result = await createStudent({ fullName, groupId })
      if (result.ok) onCreated(result.student)
      else setError(result.error)
    } catch {
      setError('Помилка зʼєднання із сервером. Спробуйте ще раз.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0b1d35] p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-base font-semibold">Створити студента</p>
            <p className="mt-1 text-[10px] text-slate-600">
              Логін і тимчасовий пароль будуть згенеровані автоматично.
            </p>
          </div>
          <button
            type="button"
            aria-label="Закрити"
            onClick={onClose}
            className="grid size-9 place-items-center rounded-xl bg-white/5 text-slate-500"
          >
            <X size={16} />
          </button>
        </div>
        <div className="mt-5 space-y-3">
          <label className="block text-[10px] text-slate-500">
            ПІБ
            <input
              autoFocus
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Коваленко Олена Петрівна"
              maxLength={120}
              className="mt-2 w-full rounded-xl border border-white/7 bg-white/[.025] px-3 py-2.5 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-blue-400/40"
            />
          </label>
          <label className="block text-[10px] text-slate-500">
            Група
            <select
              value={groupId}
              onChange={(event) => setGroupId(event.target.value)}
              className="mt-2 w-full rounded-xl border border-white/7 bg-[#0b1d35] px-3 py-2.5 text-xs text-slate-200 outline-none focus:border-blue-400/40"
            >
              <option value="">
                {available.length ? 'Оберіть групу' : 'Груп ще немає — спершу створіть групу'}
              </option>
              {available.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} · {group.faculty}, {group.course} курс
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/8 px-4 py-2.5 text-[11px] text-slate-400"
          >
            Скасувати
          </button>
          <button
            type="submit"
            disabled={submitting || !fullName.trim() || !groupId}
            className="flex items-center gap-2 rounded-xl bg-[#2457a6] px-4 py-2.5 text-[11px] font-semibold text-white hover:bg-[#3478d4] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting && <Loader2 size={13} className="animate-spin" />}
            Створити
          </button>
        </div>
      </form>
    </div>
  )
}

function CredentialsModal({
  student,
  onClose,
}: {
  student: CreatedStudent
  onClose: () => void
}) {
  const [all, setAll] = useState(false)
  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-label="Дані для входу"
        className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0b1d35] p-5 shadow-2xl"
      >
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300">
            <Check size={20} />
          </div>
          <div className="min-w-0">
            <p className="text-base font-semibold">Студента створено</p>
            <p className="mt-0.5 truncate text-[11px] text-slate-500">
              {student.fullName} · {student.groupName}
            </p>
          </div>
        </div>
        <div className="mt-5 space-y-2.5 rounded-2xl border border-white/8 bg-black/15 p-4">
          <CredentialRow label="Логін" value={student.login} />
          <CredentialRow label="Пароль" value={student.password} />
        </div>
        <p className="mt-3 text-[10px] leading-4 text-slate-500">
          Передайте ці дані студенту. Логін і пароль завжди доступні адміністратору у вкладці
          «Студенти».
        </p>
        <div className="mt-5 flex justify-between gap-2">
          <button
            type="button"
            onClick={async () => {
              if (await copyText(`Логін: ${student.login}\nПароль: ${student.password}`)) {
                setAll(true)
                window.setTimeout(() => setAll(false), 1600)
              }
            }}
            className="flex items-center gap-2 rounded-xl border border-white/8 px-4 py-2.5 text-[11px] text-slate-300 hover:text-white"
          >
            {all ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />}
            {all ? 'Скопійовано' : 'Копіювати все'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-[#2457a6] px-5 py-2.5 text-[11px] font-semibold text-white hover:bg-[#3478d4]"
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/[.025] p-2.5">
      <p className="text-[9px] text-slate-700">{label}</p>
      <p className="mt-1 text-xs font-semibold tabular-nums text-slate-300">{value}</p>
    </div>
  )
}

const weekdayNames = ['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'П’ятниця', 'Субота', 'Неділя']

function ScheduleSection({
  group,
  groups,
  onSelectGroup,
  onOpenSettings,
}: {
  group?: AcademyGroup
  groups?: AcademyGroup[]
  onSelectGroup?: (id: string) => void
  onOpenSettings: () => void
}) {
  const lessons = useMemo(() => group?.schedule?.lessons ?? [], [group?.schedule])
  const weeks = useMemo(
    () => Array.from(new Set(lessons.map((lesson) => mondayOf(lesson.date)))).sort(),
    [lessons],
  )
  const today = kyivNow().date
  const currentWeek = weeks.findIndex((monday) => addDays(monday, 6) >= today)
  const defaultWeek = currentWeek === -1 ? Math.max(0, weeks.length - 1) : currentWeek
  const [picked, setPicked] = useState<{ groupId: string; index: number } | null>(null)
  const weekIndex = Math.min(
    picked && picked.groupId === group?.id ? picked.index : defaultWeek,
    Math.max(0, weeks.length - 1),
  )
  const monday = weeks[weekIndex]
  const links = new Set((group?.subjectLinks ?? []).map((link) => link.key))

  const heading = (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-sm font-semibold">Розклад {group?.name}</p>
        <p className="mt-1 text-[10px] text-slate-600">
          {group?.schedule
            ? `${group.schedule.fileName}${group.schedule.period ? ` · ${group.schedule.period}` : ''}`
            : 'Розклад не завантажено'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {groups && groups.length > 1 && onSelectGroup && (
          <select
            value={group?.id}
            onChange={(event) => onSelectGroup(event.target.value)}
            aria-label="Група"
            className="rounded-xl border border-white/7 bg-[#0b1d35] px-3 py-2 text-[10px] text-slate-300 outline-none"
          >
            {groups.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2 rounded-xl border border-white/7 px-3 py-2 text-[10px] text-slate-400 hover:text-white"
        >
          <Upload size={13} /> {group?.schedule ? 'Замінити з Excel' : 'Завантажити з Excel'}
        </button>
      </div>
    </div>
  )

  if (!group?.schedule || !monday) {
    return (
      <section>
        {heading}
        <EmptyState
          title="Розклад ще не завантажено"
          description="Підключіть портал НАВС у вкладці «Розклад» групи або завантажте Excel у параметрах групи."
        />
      </section>
    )
  }

  const days = weekdayNames
    .map((name, index) => ({ name, date: addDays(monday, index) }))
    .filter((day, index) => index < 5 || lessons.some((lesson) => lesson.date === day.date))

  return (
    <section>
      {heading}
      <div className="mb-3 flex items-center gap-2">
        <button
          disabled={weekIndex === 0}
          onClick={() => setPicked({ groupId: group.id, index: weekIndex - 1 })}
          className="rounded-xl border border-white/7 px-3 py-2 text-[10px] text-slate-400 disabled:opacity-30"
        >
          ← Попередній
        </button>
        <p className="min-w-40 text-center text-[11px] font-semibold">
          {shortDate(monday)} – {shortDate(addDays(monday, 6))}
        </p>
        <button
          disabled={weekIndex >= weeks.length - 1}
          onClick={() => setPicked({ groupId: group.id, index: weekIndex + 1 })}
          className="rounded-xl border border-white/7 px-3 py-2 text-[10px] text-slate-400 disabled:opacity-30"
        >
          Наступний →
        </button>
      </div>
      <div className={`grid gap-3 ${days.length > 5 ? 'xl:grid-cols-7' : 'xl:grid-cols-5'}`}>
        {days.map((day) => {
          const items = lessons.filter((lesson) => lesson.date === day.date)
          return (
            <div key={day.date} className="rounded-2xl border border-white/7 bg-white/[.02] p-3">
              <div className="mb-3 flex items-center justify-between px-1">
                <div>
                  <p className="text-[11px] font-semibold">{day.name}</p>
                  <p className="text-[9px] text-slate-600">{shortDate(day.date)}</p>
                </div>
                <span className="text-[9px] text-slate-700">{items.length} зан.</span>
              </div>
              <div className="space-y-2">
                {items.map((lesson) => (
                  <article
                    key={`${lesson.date}-${lesson.start}-${lesson.subjectKey}-${lesson.detail}`}
                    className="rounded-xl border border-white/6 bg-gradient-to-br from-blue-500/[.07] to-transparent p-3"
                  >
                    <span className="text-[9px] font-semibold text-blue-300">
                      {lesson.start}–{lesson.end}
                    </span>
                    <p className="mt-2 text-[11px] font-semibold leading-4">{lesson.subject}</p>
                    <p className="mt-2 text-[9px] text-slate-600">
                      {lesson.kind || 'Заняття'}
                      {lesson.detail ? ` ${lesson.detail}` : ''} ·{' '}
                      {isRemote(lesson.room) ? 'дистанційно' : lesson.room || '—'}
                    </p>
                    <p className="mt-1 text-[9px] text-slate-700">{lesson.teacher}</p>
                    <p
                      className={`mt-2 text-[9px] ${links.has(lesson.subjectKey) ? 'text-emerald-300/80' : 'text-amber-300/70'}`}
                    >
                      {links.has(lesson.subjectKey) ? 'Посилання додано' : 'Немає посилання'}
                    </p>
                  </article>
                ))}
                {!items.length && (
                  <div className="rounded-xl border border-dashed border-white/6 py-8 text-center text-[9px] text-slate-700">
                    Занять немає
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function AnalyticsSection({ grades, groups }: { grades: GradeRow[]; groups: AcademyGroup[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5 lg:col-span-2">
        <p className="text-sm font-semibold">Успішність за дисциплінами</p>
        <div className="mt-6 space-y-4">
          {subjects.map((subject) => {
            const value = grades.length
              ? grades.reduce((sum, row) => sum + row.scores[subject.key], 0) / grades.length
              : 0
            return (
              <div key={subject.key} className="grid grid-cols-[90px_1fr_45px] items-center gap-3">
                <span className="text-[10px] text-slate-500">{subject.label}</span>
                <Progress value={value} />
                <span className="text-right text-[10px] tabular-nums text-slate-400">
                  {value.toFixed(1)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
        <p className="text-sm font-semibold">Стан груп</p>
        <div className="mt-5 grid place-items-center">
          <div className="grid size-40 place-items-center rounded-full bg-[conic-gradient(#3478d4_0_78%,rgba(255,255,255,.05)_78%)]">
            <div className="grid size-28 place-items-center rounded-full bg-[#0b1d35] text-center">
              <div>
                <p className="text-2xl font-semibold">
                  {groups.filter((group) => group.status === 'active').length}
                </p>
                <p className="text-[9px] text-slate-600">активних груп</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function HistorySection({ activities }: { activities: ActivityRow[] }) {
  return (
    <section className="rounded-2xl border border-white/7 bg-white/[.025]">
      <div className="border-b border-white/6 p-4">
        <Toolbar />
      </div>
      <div>
        {activities.map((item) => (
          <div
            key={item.id}
            className="grid gap-3 border-b border-white/5 p-4 last:border-0 sm:grid-cols-[44px_1fr_auto] sm:items-center"
          >
            <div className="grid size-9 place-items-center rounded-xl bg-blue-500/8 text-blue-400">
              <History size={15} />
            </div>
            <div>
              <p className="text-[11px] text-slate-300">{item.summary}</p>
              <p className="mt-1 text-[9px] text-slate-600">
                {item.administrator} · {new Date(item.createdAt).toLocaleString('uk-UA')}
              </p>
            </div>
            {item.previousValue && (
              <div className="flex items-center gap-2 text-[10px] tabular-nums">
                <span className="rounded-lg bg-rose-500/7 px-2 py-1 text-rose-300">
                  {item.previousValue}
                </span>
                <ChevronRight size={12} className="text-slate-700" />
                <span className="rounded-lg bg-emerald-500/7 px-2 py-1 text-emerald-300">
                  {item.newValue}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function SettingsSection() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
        <p className="text-sm font-semibold">Загальні параметри</p>
        <div className="mt-5 space-y-4">
          {[
            ['Навчальний рік', '2049 / 2050'],
            ['Мова інтерфейсу', 'Українська'],
            ['Часовий пояс', 'Київ (UTC+2)'],
          ].map(([label, value]) => (
            <label key={label} className="block text-[10px] text-slate-600">
              {label}
              <input
                defaultValue={value}
                className="mt-2 w-full rounded-xl border border-white/7 bg-white/[.025] px-3 py-3 text-[11px] text-slate-300 outline-none"
              />
            </label>
          ))}
        </div>
      </section>
      <section className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
        <p className="text-sm font-semibold">Безпека й дозволи</p>
        <div className="mt-4 space-y-2">
          {[
            'Двофакторна автентифікація',
            'Журнал адміністративних дій',
            'Підтвердження видалення',
            'Обмеження доступу за ролями',
          ].map((label, index) => (
            <div
              key={label}
              className="flex items-center justify-between rounded-xl border border-white/5 p-3"
            >
              <div className="flex items-center gap-3">
                <ShieldCheck size={15} className="text-blue-400" />
                <span className="text-[11px]">{label}</span>
              </div>
              <div
                className={`h-5 w-9 rounded-full p-0.5 ${index < 3 ? 'bg-blue-600' : 'bg-white/10'}`}
              >
                <div
                  className={`size-4 rounded-full bg-white transition ${index < 3 ? 'translate-x-4' : ''}`}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function StudentHomepage({
  student,
  rank,
  groupCount,
  peers,
  activities,
}: {
  student?: GradeRow
  rank: number
  groupCount: number
  peers: GradeRow[]
  activities: ActivityRow[]
}) {
  if (!student)
    return (
      <EmptyState
        title="Профіль студента недоступний"
        description="Адміністратор ще не додав академічні дані."
      />
    )
  return (
    <>
      <PageHeading
        eyebrow="Особистий академічний простір"
        title={`Вітаємо, ${student.studentName.split(' ')[1] ?? student.studentName}`}
        description="Ваші актуальні результати, позиція у групі та динаміка навчання."
      />
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="Позиція у групі"
          value={`${rank} / ${groupCount}`}
          detail="Рейтинг оновлюється автоматично"
          icon={TrendingUp}
          trend="+1 місце"
        />
        <StatCard
          label="Загальний бал"
          value={String(total(student.scores))}
          detail="За 8 дисциплін"
          icon={BookOpen}
        />
        <StatCard
          label="Середній бал"
          value={average(student.scores).toFixed(1)}
          detail="Поточний семестр"
          icon={BarChart3}
          trend="+2,4"
        />
        <StatCard
          label="Академічний прогрес"
          value={`${Math.round(average(student.scores))}%`}
          detail="Високий рівень"
          icon={Activity}
        />
      </section>
      <section className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
          <p className="text-sm font-semibold">Результати за дисциплінами</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {subjects.map((subject) => (
              <div
                key={subject.key}
                className="rounded-xl border border-white/6 bg-white/[.018] p-3"
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-[11px] font-medium">{subject.label}</span>
                  <span className="text-sm font-semibold tabular-nums text-blue-300">
                    {student.scores[subject.key]}
                  </span>
                </div>
                <Progress value={student.scores[subject.key]} />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
          <p className="text-sm font-semibold">Порівняння у групі</p>
          <div className="mt-5 space-y-3">
            {peers.slice(0, 6).map((peer, index) => (
              <div
                key={peer.id}
                className={`flex items-center gap-3 rounded-xl p-2 ${peer.id === student.id ? 'border border-blue-300/15 bg-blue-500/8' : ''}`}
              >
                <span className="w-5 text-center text-[10px] font-bold text-slate-600">
                  {index + 1}
                </span>
                <div className="grid size-7 place-items-center rounded-lg bg-white/5 text-[8px] font-bold">
                  {initials(peer.studentName)}
                </div>
                <span className="min-w-0 flex-1 truncate text-[10px]">
                  {peer.id === student.id ? 'Ви' : peer.studentName}
                </span>
                <span className="text-[10px] tabular-nums text-slate-400">
                  {average(peer.scores).toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
          <p className="text-sm font-semibold">Прогрес у часі</p>
          <div className="mt-5 flex h-40 items-end gap-3">
            {[64, 68, 71, 73, 78, 82, Math.round(average(student.scores))].map((value, index) => (
              <div key={index} className="flex h-full flex-1 items-end">
                <div
                  className="w-full rounded-t-md bg-gradient-to-t from-blue-700/35 to-blue-400/80"
                  style={{ height: `${value}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-between text-[9px] text-slate-700">
            {['Вер', 'Жов', 'Лис', 'Гру', 'Січ', 'Лют', 'Бер'].map((month) => (
              <span key={month}>{month}</span>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-white/7 bg-white/[.025] p-5">
          <p className="text-sm font-semibold">Останні зміни оцінок</p>
          <div className="mt-4 space-y-2">
            {activities
              .filter((item) => item.entityType === 'grade')
              .slice(0, 4)
              .map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-xl border border-white/5 p-3"
                >
                  <Clock3 size={14} className="text-blue-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] text-slate-300">{item.summary}</p>
                    <p className="mt-1 text-[9px] text-slate-700">
                      {new Date(item.createdAt).toLocaleDateString('uk-UA')}
                    </p>
                  </div>
                  <span className="text-[10px] text-emerald-300">
                    +{Number(item.newValue ?? 0) - Number(item.previousValue ?? 0)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </section>
    </>
  )
}

function GroupCreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (group: AcademyGroup) => void
}) {
  const [form, setForm] = useState({
    name: '',
    faculty: '',
    course: '1',
    academicYear: '',
    curator: '',
    status: 'active',
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((value) => ({ ...value, [key]: event.target.value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting) return
    setError('')
    setSubmitting(true)
    const result = await createGroup({ ...form, course: Number(form.course) })
    setSubmitting(false)
    if (result.ok) onCreated(result.group)
    else setError(result.error)
  }

  const input =
    'mt-2 w-full rounded-xl border border-white/7 bg-white/[.025] px-3 py-2.5 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-blue-400/40'
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#0b1d35] p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-base font-semibold">Створити групу</p>
            <p className="mt-1 text-[10px] text-slate-600">Заповніть дані українською мовою.</p>
          </div>
          <button
            type="button"
            aria-label="Закрити"
            onClick={onClose}
            className="grid size-9 place-items-center rounded-xl bg-white/5 text-slate-500"
          >
            <X size={16} />
          </button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="text-[10px] text-slate-500">
            Назва групи
            <input required maxLength={40} value={form.name} onChange={set('name')} placeholder="КН-21" className={input} />
          </label>
          <label className="text-[10px] text-slate-500">
            Факультет
            <input required maxLength={120} value={form.faculty} onChange={set('faculty')} placeholder="Факультет" className={input} />
          </label>
          <label className="text-[10px] text-slate-500">
            Курс
            <select value={form.course} onChange={set('course')} className={`${input} bg-[#0b1d35]`}>
              {[1, 2, 3, 4, 5, 6].map((course) => (
                <option key={course} value={course}>
                  {course} курс
                </option>
              ))}
            </select>
          </label>
          <label className="text-[10px] text-slate-500">
            Навчальний рік
            <input required maxLength={20} value={form.academicYear} onChange={set('academicYear')} placeholder="2026/2027" className={input} />
          </label>
          <label className="text-[10px] text-slate-500">
            Куратор
            <input required maxLength={120} value={form.curator} onChange={set('curator')} placeholder="ПІБ куратора" className={input} />
          </label>
          <label className="text-[10px] text-slate-500">
            Статус групи
            <select value={form.status} onChange={set('status')} className={`${input} bg-[#0b1d35]`}>
              <option value="active">Активна</option>
              <option value="enrollment">Набір</option>
              <option value="archived">Архівна</option>
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/8 px-4 py-2.5 text-[11px] text-slate-400">
            Скасувати
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-2 rounded-xl bg-[#2457a6] px-4 py-2.5 text-[11px] font-semibold text-white hover:bg-[#3478d4] disabled:opacity-50"
          >
            {submitting && <Loader2 size={13} className="animate-spin" />}
            Створити
          </button>
        </div>
      </form>
    </div>
  )
}

function ActionModal({
  type,
  onClose,
}: {
  type: 'group' | 'student' | 'import'
  onClose: () => void
}) {
  const title = type === 'group' ? 'Створити групу' : 'Імпорт даних'
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#0b1d35] p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-base font-semibold">{title}</p>
            <p className="mt-1 text-[10px] text-slate-600">Заповніть дані українською мовою.</p>
          </div>
          <button
            aria-label="Закрити"
            onClick={onClose}
            className="grid size-9 place-items-center rounded-xl bg-white/5 text-slate-500"
          >
            <X size={16} />
          </button>
        </div>
        {type === 'import' ? (
          <div className="mt-5 rounded-2xl border border-dashed border-blue-300/20 bg-blue-500/[.035] p-8 text-center">
            <FileSpreadsheet size={28} className="mx-auto text-blue-400" />
            <p className="mt-4 text-xs font-semibold">Перетягніть Excel або CSV</p>
            <p className="mt-2 text-[10px] text-slate-600">Підтримуються файли до 10 МБ</p>
            <button className="mt-5 rounded-xl bg-blue-600 px-4 py-2.5 text-[10px] font-semibold">
              Вибрати файл
            </button>
          </div>
        ) : (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {(type === 'group'
              ? ['Назва групи', 'Факультет', 'Курс', 'Навчальний рік', 'Куратор', 'Статус групи']
              : []
            ).map((label) => (
              <label key={label} className="text-[10px] text-slate-600">
                {label}
                <input
                  placeholder={label}
                  className="mt-2 w-full rounded-xl border border-white/7 bg-white/[.025] px-3 py-2.5 text-[11px] text-slate-200 outline-none focus:border-blue-400/35"
                />
              </label>
            ))}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl border border-white/8 px-4 py-2.5 text-[10px] text-slate-400"
          >
            Скасувати
          </button>
          <button
            onClick={onClose}
            className="rounded-xl bg-blue-600 px-4 py-2.5 text-[10px] font-semibold"
          >
            {type === 'import' ? 'Імпортувати' : 'Зберегти'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog({
  type,
  onClose,
  onConfirm,
}: {
  type: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0b1d35] p-6 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-rose-500/9 text-rose-300">
          {type === 'delete' ? <Trash2 size={20} /> : <Archive size={20} />}
        </div>
        <p className="mt-4 text-base font-semibold">
          {type === 'delete' ? 'Видалити групу?' : 'Архівувати групу?'}
        </p>
        <p className="mt-2 text-[11px] leading-5 text-slate-500">
          {type === 'delete'
            ? 'Цю дію буде записано в історію. Перед остаточним видаленням дані потраплять до кошика.'
            : 'Група та її дані залишаться доступними в архіві.'}
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            onClick={onClose}
            className="rounded-xl border border-white/8 px-4 py-3 text-[10px]"
          >
            Скасувати
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl bg-rose-600 px-4 py-3 text-[10px] font-semibold"
          >
            {type === 'delete' ? 'Видалити' : 'Архівувати'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="col-span-full grid min-h-40 place-items-center rounded-2xl border border-dashed border-white/7 p-6 text-center">
      <div>
        <div className="mx-auto grid size-10 place-items-center rounded-xl bg-white/5 text-slate-600">
          <CircleHelp size={17} />
        </div>
        <p className="mt-3 text-xs font-semibold">{title}</p>
        <p className="mt-1 text-[10px] text-slate-600">{description}</p>
      </div>
    </div>
  )
}
