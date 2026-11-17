import { useEffect, useState } from "react";
import Login from "./Login";
import Dashboard, { type SessionUser } from "./Dashboard";

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.user) setUser(json.user);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = async () => {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      setUser(null);
    }
  };

  if (checking) return <div className="min-h-screen" style={{ background: "#071426" }} />;
  if (!user) return <Login onLogin={setUser} />;
  return <Dashboard user={user} onLogout={logout} />;
}
