import {
  CalendarDays,
  ExternalLink,
  FileSpreadsheet,
  Link2,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { saveGroupSchedule, updateGroup } from './adminApi'
import { parseScheduleFile } from './scheduleFile'
import type { AcademyGroup } from './AcademyDashboard'
import {
  longDate,
  normalizeUrl,
  pluralUk,
  shortDate,
  type ParsedSchedule,
  type SubjectLink,
} from '../schedule'

const card = 'rounded-2xl border border-white/7 bg-white/[.025] p-5'
const inputClass =
  'mt-2 w-full rounded-xl border border-white/7 bg-white/[.025] px-3 py-2.5 text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-blue-400/35'
const primaryButton =
  'flex items-center gap-2 rounded-xl bg-[#2457a6] px-4 py-2.5 text-[11px] font-semibold text-white hover:bg-[#3478d4] disabled:opacity-50'
const ghostButton =
  'flex items-center gap-2 rounded-xl border border-white/8 px-3 py-2.5 text-[11px] text-slate-400 hover:text-white disabled:opacity-50'

type CardProps = {
  group: AcademyGroup
  onSaved: (group: AcademyGroup) => void
  notify: (text: string) => void
}

function ErrorLine({ text }: { text: string }) {
  if (!text) return null
  return (
    <p role="alert" className="mt-3 rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
      {text}
    </p>
  )
}

/* ------------------------------------------------------------------ */
/* Дата початку сесії                                                  */
/* ------------------------------------------------------------------ */
export function SessionDateCard({ group, onSaved, notify }: CardProps) {
  const saved = group.sessionStart ?? ''
  const [value, setValue] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function save(next: string) {
    setBusy(true)
    setError('')
    const result = await updateGroup(group.id, { sessionStart: next || null })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setValue(result.group.sessionStart ?? '')
    onSaved(result.group)
    notify(next ? `Дату сесії для ${group.name} збережено.` : 'Дату сесії очищено.')
  }

  return (
    <div className={card}>
      <div className="flex items-center gap-2">
        <CalendarDays size={16} className="text-blue-300" />
        <p className="text-sm font-semibold">Початок сесії</p>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        Студенти групи бачать у блоці «До сесії» кількість днів до цієї дати.
      </p>
      <label className="mt-4 block text-[10px] text-slate-600">
        Дата початку сесії
        <input
          type="date"
          min="2000-01-01"
          max="2100-12-31"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setError('')
          }}
          className={`${inputClass} [color-scheme:dark]`}
        />
      </label>
      {saved && (
        <p className="mt-2 text-[10px] text-slate-600">Зараз збережено: {longDate(saved)}</p>
      )}
      <ErrorLine text={error} />
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy || !value || value === saved}
          onClick={() => void save(value)}
          className={primaryButton}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Зберегти дату
        </button>
        {saved && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save('')}
            className={ghostButton}
          >
            Очистити
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Завантаження розкладу з Excel                                       */
/* ------------------------------------------------------------------ */
export function ScheduleUploadCard({ group, onSaved, notify }: CardProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [preview, setPreview] = useState<{ fileName: string; data: ParsedSchedule } | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const schedule = group.schedule

  async function pick(file: File | undefined) {
    if (!file) return
    setError('')
    setPreview(null)
    setReading(true)
    try {
      setPreview({ fileName: file.name, data: await parseScheduleFile(file) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не вдалося прочитати файл.')
    } finally {
      setReading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function save() {
    if (!preview) return
    setBusy(true)
    setError('')
    const result = await saveGroupSchedule({
      groupId: group.id,
      fileName: preview.fileName,
      groupLabel: preview.data.groupLabel,
      period: preview.data.period,
      lessons: preview.data.lessons,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setPreview(null)
    onSaved(result.group)
    notify(`Розклад групи ${group.name} збережено. Студенти побачать його одразу.`)
  }

  async function remove() {
    if (!window.confirm(`Видалити розклад групи ${group.name}?`)) return
    setBusy(true)
    setError('')
    const result = await saveGroupSchedule({
      groupId: group.id,
      fileName: '',
      groupLabel: '',
      period: '',
      lessons: [],
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onSaved(result.group)
    notify('Розклад видалено.')
  }

  const previewDates = preview?.data.lessons.map((lesson) => lesson.date) ?? []
  const previewSubjects = preview ? new Set(preview.data.lessons.map((l) => l.subjectKey)).size : 0

  return (
    <div className={card}>
      <div className="flex items-center gap-2">
        <FileSpreadsheet size={16} className="text-blue-300" />
        <p className="text-sm font-semibold">Розклад занять</p>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        Завантажте файл розкладу з порталу (.xls або .xlsx). Блок «Наступна пара» у студентів
        рахується від поточного часу за цим розкладом.
      </p>

      {schedule ? (
        <div className="mt-4 rounded-xl border border-white/7 bg-white/[.02] p-3 text-[11px]">
          <p className="font-semibold text-slate-200">{schedule.fileName}</p>
          <p className="mt-1 text-slate-500">
            {schedule.lessons.length}{' '}
            {pluralUk(schedule.lessons.length, 'пара', 'пари', 'пар')}
            {schedule.period ? ` · ${schedule.period}` : ''}
          </p>
          <p className="mt-1 text-[10px] text-slate-600">
            Завантажено {new Date(schedule.uploadedAt).toLocaleString('uk-UA')}
          </p>
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed border-white/8 px-3 py-4 text-center text-[11px] text-slate-600">
          Розклад ще не завантажено
        </p>
      )}

      {group.portal && <p className="mt-3 text-xs text-amber-200">Заміна або видалення розкладу вручну вимкне автооновлення НАВС.</p>}
      <input
        ref={inputRef}
        type="file"
        accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(event) => void pick(event.target.files?.[0])}
      />

      {preview && (
        <div className="mt-4 rounded-xl border border-blue-300/20 bg-blue-500/[.06] p-3 text-[11px]">
          <p className="font-semibold text-blue-200">Перевірте перед збереженням</p>
          <ul className="mt-2 space-y-1 text-slate-400">
            <li>
              Файл: <span className="text-slate-200">{preview.fileName}</span>
            </li>
            {preview.data.groupLabel && (
              <li>
                Розклад групи у файлі:{' '}
                <span className="text-slate-200">{preview.data.groupLabel}</span>
              </li>
            )}
            <li>
              Знайдено{' '}
              <span className="text-slate-200">
                {preview.data.lessons.length}{' '}
                {pluralUk(preview.data.lessons.length, 'пару', 'пари', 'пар')}
              </span>
              , предметів: <span className="text-slate-200">{previewSubjects}</span>
            </li>
            <li>
              Дати:{' '}
              <span className="text-slate-200">
                {shortDate(previewDates[0])} — {shortDate(previewDates[previewDates.length - 1])}
              </span>
            </li>
          </ul>
          <p className="mt-2 text-[10px] text-slate-500">
            Збереження замінить поточний розклад групи {group.name}.
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void save()} className={primaryButton}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Зберегти розклад
            </button>
            <button type="button" disabled={busy} onClick={() => setPreview(null)} className={ghostButton}>
              Скасувати
            </button>
          </div>
        </div>
      )}

      <ErrorLine text={error} />

      {!preview && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={reading || busy}
            onClick={() => inputRef.current?.click()}
            className={primaryButton}
          >
            {reading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {schedule ? 'Замінити файл' : 'Завантажити файл'}
          </button>
          {schedule && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="flex items-center gap-2 rounded-xl border border-rose-300/15 bg-rose-500/8 px-3 py-2.5 text-[11px] text-rose-300 disabled:opacity-50"
            >
              <Trash2 size={13} /> Видалити
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Предмети групи: посилання, куди приєднуватись на пару               */
/* ------------------------------------------------------------------ */
export function SubjectLinksCard({
  group,
  knownSubjects,
  onSaved,
  notify,
}: CardProps & { knownSubjects: { key: string; label: string }[] }) {
  const savedLinks = group.subjectLinks ?? []
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(savedLinks.map((link) => [link.key, link.url])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Предмети: 8 основних + усе, чого немає серед них, але є в розкладі чи вже має посилання
  const fromSchedule = new Map<string, { name: string; count: number }>()
  for (const lesson of group.schedule?.lessons ?? []) {
    const current = fromSchedule.get(lesson.subjectKey)
    fromSchedule.set(lesson.subjectKey, {
      name: current?.name ?? lesson.subject,
      count: (current?.count ?? 0) + 1,
    })
  }
  const rows: { key: string; name: string; hint: string; count: number }[] = knownSubjects.map(
    (subject) => {
      const found = fromSchedule.get(subject.key)
      return {
        key: subject.key,
        name: found?.name ?? subject.label,
        hint: found && found.name !== subject.label ? subject.label : '',
        count: found?.count ?? 0,
      }
    },
  )
  const known = new Set(knownSubjects.map((subject) => subject.key))
  for (const [key, info] of fromSchedule) {
    if (!known.has(key)) rows.push({ key, name: info.name, hint: '', count: info.count })
  }
  for (const link of savedLinks) {
    if (!known.has(link.key) && !fromSchedule.has(link.key)) {
      rows.push({ key: link.key, name: link.key.replace(/^x-/, ''), hint: 'немає в розкладі', count: 0 })
    }
  }

  const savedMap = Object.fromEntries(savedLinks.map((link) => [link.key, link.url]))
  const dirty = rows.some((row) => (drafts[row.key] ?? '').trim() !== (savedMap[row.key] ?? ''))

  async function save() {
    const links: SubjectLink[] = []
    for (const row of rows) {
      const raw = drafts[row.key] ?? ''
      const url = normalizeUrl(raw)
      if (url === null) {
        setError(`Некоректне посилання для «${row.name}». Потрібна адреса виду https://…`)
        return
      }
      if (url) links.push({ key: row.key, url })
    }
    setBusy(true)
    setError('')
    const result = await updateGroup(group.id, { subjectLinks: links })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setDrafts(Object.fromEntries((result.group.subjectLinks ?? []).map((l) => [l.key, l.url])))
    onSaved(result.group)
    notify(`Посилання для групи ${group.name} збережено.`)
  }

  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link2 size={16} className="text-blue-300" />
            <p className="text-sm font-semibold">Предмети та посилання на пари</p>
          </div>
          <p className="mt-2 max-w-2xl text-[11px] leading-5 text-slate-500">
            Вставте посилання (Zoom, Meet, Teams…), куди студенти приєднуються до пари. Воно
            відкривається кнопкою «Перейти до заняття» у блоці «Наступна пара» для всіх занять
            цього предмета.
          </p>
        </div>
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void save()}
          className={primaryButton}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Зберегти посилання
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {rows.map((row) => {
          const draft = drafts[row.key] ?? ''
          const valid = normalizeUrl(draft)
          return (
            <label key={row.key} className="block rounded-xl border border-white/6 bg-white/[.015] p-3">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-semibold text-slate-200">
                  {row.name}
                  {row.hint && <span className="ml-2 text-[10px] font-normal text-slate-600">{row.hint}</span>}
                </span>
                <span className="text-[10px] text-slate-600">
                  {row.count > 0
                    ? `${row.count} ${pluralUk(row.count, 'пара', 'пари', 'пар')} у розкладі`
                    : 'немає в розкладі'}
                </span>
              </span>
              <span className="mt-2 flex items-center gap-2">
                <input
                  type="url"
                  inputMode="url"
                  value={draft}
                  maxLength={500}
                  placeholder="https://meet.google.com/…"
                  onChange={(event) => {
                    setDrafts((current) => ({ ...current, [row.key]: event.target.value }))
                    setError('')
                  }}
                  className="w-full rounded-xl border border-white/7 bg-white/[.025] px-3 py-2.5 text-[11px] text-slate-200 outline-none placeholder:text-slate-700 focus:border-blue-400/35"
                />
                {valid && (
                  <a
                    href={valid}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Відкрити посилання: ${row.name}`}
                    title="Перевірити посилання"
                    className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/8 text-slate-400 hover:text-white"
                  >
                    <ExternalLink size={14} />
                  </a>
                )}
              </span>
            </label>
          )
        })}
      </div>
      <ErrorLine text={error} />
    </div>
  )
}
