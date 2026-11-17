import { FormEvent, useState } from "react";
import type { SessionUser } from "./Dashboard";

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M2.8 12s3.35-5 9.2-5 9.2 5 9.2 5-3.35 5-9.2 5-9.2-5-9.2-5Z"
        stroke="currentColor"
        strokeWidth="1.45"
      />
      <circle cx="12" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.45" />
      {hidden && (
        <path
          d="M4.2 4.2 19.8 19.8"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export default function Login({
  onLogin,
}: {
  onLogin: (user: SessionUser) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    const data = new FormData(event.currentTarget);
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          login: data.get("login"),
          password: data.get("password"),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          (json.error ?? "Не вдалося увійти. Спробуйте пізніше.") +
            (json.detail ? ` — ${json.detail}` : ""),
        );
        return;
      }
      onLogin(json.user);
    } catch {
      setError("Немає зʼєднання з сервером.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-screen" aria-label="Авторизація в електронному щоденнику">
      <div className="architecture architecture-left" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="architecture architecture-right" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="shield-frame" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="horizon-line" aria-hidden="true" />

      <section className="auth-card" aria-labelledby="academy-title">
        <div className="card-reflection" aria-hidden="true" />

        <header className="brand">
          <div className="emblem" aria-label="Емблема Національної академії внутрішніх справ">
            <img src="/assets/navs-emblem.png" alt="" />
          </div>
          <div className="brand-copy">
            <p className="auth-eyebrow">
              НАВС
            </p>
            <h1 id="academy-title">
              НАЦІОНАЛЬНА АКАДЕМІЯ
              <br />
              ВНУТРІШНІХ СПРАВ
            </h1>
            <p className="subtitle">ЕЛЕКТРОННИЙ ЩОДЕННИК</p>
          </div>
        </header>

        <div className="divider" aria-hidden="true">
          <span />
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field-group">
            <label htmlFor="login">
              Логін
            </label>
            <input
              id="login"
              name="login"
              type="text"
              placeholder="Введіть логін"
              autoComplete="username"
              required
            />
          </div>

          <div className="field-group">
            <label htmlFor="password">
              Пароль
            </label>
            <div className="password-wrap">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                placeholder="Введіть пароль"
                autoComplete="current-password"
                required
              />
              <button
                className="visibility-button"
                type="button"
                aria-label={showPassword ? "Приховати пароль" : "Показати пароль"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
              >
                <EyeIcon hidden={!showPassword} />
              </button>
            </div>
          </div>

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button className="login-button" type="submit" disabled={loading}>
            <span>{loading ? "ВХІД…" : "УВІЙТИ ДО СИСТЕМИ"}</span>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12h13M14 8l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>
      </section>
    </main>
  );
}
