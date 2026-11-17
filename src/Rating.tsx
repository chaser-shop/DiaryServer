import { Check, Crown, Pencil, Trophy, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchGroupRatings, type GroupStudent } from "./ratingApi";
import {
  averageScore,
  formatAverage,
  SUBJECTS,
  type Scores,
  type SubjectKey,
} from "./subjects";

type Tab = "mine" | "group";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";

function SubjectScoreCard({
  label,
  value,
  onSave,
}: {
  label: string;
  value: number;
  onSave: (value: number) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    setDraft(String(value));
    setError("");
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError("");
  };

  const submit = async () => {
    const text = draft.trim().replace(",", ".");
    const number = Number(text);
    if (text === "" || !Number.isFinite(number) || number < 0 || number > 100) {
      setError("Введіть число від 0 до 100");
      return;
    }
    setSaving(true);
    const failure = await onSave(Math.round(number));
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    setEditing(false);
    setError("");
  };

  return (
    <article className={`rating-card ${editing ? "rating-card-editing" : ""}`}>
      <div className="rating-card-top">
        <h3>{label}</h3>
        {!editing && (
          <button
            type="button"
            className="rating-edit"
            onClick={start}
            aria-label={`Редагувати оцінку: ${label}`}
            title="Редагувати"
          >
            <Pencil size={14} />
          </button>
        )}
      </div>

      {editing ? (
        <div className="rating-editor">
          <input
            ref={inputRef}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={draft}
            disabled={saving}
            aria-label={`Оцінка: ${label}`}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") cancel();
            }}
          />
          <span className="rating-editor-max">/ 100</span>
          <button
            type="button"
            className="rating-editor-save"
            onClick={() => void submit()}
            disabled={saving}
            aria-label="Зберегти"
            title="Зберегти"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            className="rating-editor-cancel"
            onClick={cancel}
            disabled={saving}
            aria-label="Скасувати"
            title="Скасувати"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <p className="rating-value">
          {value}
          <small>/ 100</small>
        </p>
      )}

      {error && <p className="rating-error">{error}</p>}

      <span className="progress-track rating-progress" aria-hidden="true">
        <span style={{ width: `${value}%` }} />
      </span>
    </article>
  );
}

function MyRating({
  scores,
  onSave,
}: {
  scores: Scores | null;
  onSave: (key: SubjectKey, value: number) => Promise<string | null>;
}) {
  if (!scores) {
    return (
      <div className="rating-empty">
        <p>Оцінки недоступні для цього облікового запису.</p>
      </div>
    );
  }
  const avg = averageScore(scores);
  return (
    <>
      <div className="rating-summary">
        <span>Середній бал</span>
        <strong>{formatAverage(avg)}</strong>
        <small>за {SUBJECTS.length} дисциплінами</small>
      </div>
      <div className="rating-grid">
        {SUBJECTS.map((subject) => (
          <SubjectScoreCard
            key={subject.key}
            label={subject.label}
            value={scores[subject.key]}
            onSave={(value) => onSave(subject.key, value)}
          />
        ))}
      </div>
    </>
  );
}

type Filter = "total" | SubjectKey;

function GroupRating({ refreshKey }: { refreshKey: number }) {
  const [students, setStudents] = useState<GroupStudent[] | null>(null);
  const [me, setMe] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("total");

  useEffect(() => {
    let cancelled = false;
    fetchGroupRatings().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setStudents(result.data.students);
        setMe(result.data.me);
        setError("");
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const rows = useMemo(() => {
    if (!students) return [];
    const withValue = students.map((student) => ({
      ...student,
      value: filter === "total" ? averageScore(student.scores) : student.scores[filter],
    }));
    withValue.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "uk"));
    let rank = 0;
    return withValue.map((row, index) => {
      if (index === 0 || row.value !== withValue[index - 1].value) rank = index + 1;
      return { ...row, rank };
    });
  }, [students, filter]);

  const format = (value: number) => (filter === "total" ? formatAverage(value) : String(value));
  const topValue = rows[0]?.value ?? 0;
  const leaders = rows.filter((row) => row.rank === 1 && row.value > 0);
  const filterLabel =
    filter === "total" ? "загальним балом" : (SUBJECTS.find((s) => s.key === filter)?.label ?? "");

  return (
    <>
      <div className="rating-filters" role="tablist" aria-label="Предмет">
        <button
          type="button"
          role="tab"
          aria-selected={filter === "total"}
          className={`rating-chip ${filter === "total" ? "rating-chip-active" : ""}`}
          onClick={() => setFilter("total")}
        >
          Загальний
        </button>
        {SUBJECTS.map((subject) => (
          <button
            key={subject.key}
            type="button"
            role="tab"
            aria-selected={filter === subject.key}
            className={`rating-chip ${filter === subject.key ? "rating-chip-active" : ""}`}
            onClick={() => setFilter(subject.key)}
          >
            {subject.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rating-empty">
          <p>{error}</p>
        </div>
      ) : !students ? (
        <div className="rating-empty">
          <p>Завантаження…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="rating-empty">
          <p>У вашій групі ще немає студентів з оцінками.</p>
        </div>
      ) : (
        <>
          <div className="rating-leader">
            <span className="rating-leader-icon">
              <Trophy size={20} />
            </span>
            <div className="min-w-0">
              <small>Лідер за {filterLabel}</small>
              <strong>
                {leaders.length === 0
                  ? "Поки немає лідера"
                  : leaders.map((leader) => leader.name).join(", ")}
              </strong>
            </div>
            {leaders.length > 0 && (
              <span className="rating-leader-score">{format(topValue)}</span>
            )}
          </div>

          <ol className="rating-list">
            {rows.map((row) => (
              <li
                key={row.id}
                className={`rating-row ${row.id === me ? "rating-row-me" : ""} ${
                  row.rank === 1 && row.value > 0 ? "rating-row-leader" : ""
                }`}
              >
                <span className="rating-rank">
                  {row.rank === 1 && row.value > 0 ? <Crown size={15} /> : row.rank}
                </span>
                <span className="rating-avatar">{initials(row.name)}</span>
                <span className="rating-row-main">
                  <span className="rating-row-name">
                    {row.name}
                    {row.id === me && <em>Ви</em>}
                  </span>
                  <span className="progress-track" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, row.value)}%` }} />
                  </span>
                </span>
                <span className="rating-row-score">{format(row.value)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

export default function Rating({
  scores,
  onSave,
  refreshKey,
}: {
  scores: Scores | null;
  onSave: (key: SubjectKey, value: number) => Promise<string | null>;
  refreshKey: number;
}) {
  const [tab, setTab] = useState<Tab>("mine");
  const [groupVersion, setGroupVersion] = useState(0);

  return (
    <section className="glass-panel content-card rating-panel" aria-labelledby="rating-heading">
      <div className="content-card-header">
        <div>
          <p className="section-kicker">Успішність</p>
          <h2 id="rating-heading" className="section-title">
            Рейтинг
          </h2>
        </div>
      </div>

      <div className="rating-tabs" role="tablist" aria-label="Розділи рейтингу">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "mine"}
          className={`rating-tab ${tab === "mine" ? "rating-tab-active" : ""}`}
          onClick={() => setTab("mine")}
        >
          Свій рейтинг
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "group"}
          className={`rating-tab ${tab === "group" ? "rating-tab-active" : ""}`}
          onClick={() => {
            setTab("group");
            setGroupVersion((value) => value + 1);
          }}
        >
          Рейтинг групи
        </button>
      </div>

      {tab === "mine" ? (
        <MyRating scores={scores} onSave={onSave} />
      ) : (
        <GroupRating refreshKey={groupVersion + refreshKey} />
      )}
    </section>
  );
}
