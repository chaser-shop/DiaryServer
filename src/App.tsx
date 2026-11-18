import { useEffect, useState } from "react";
import Login from "./Login";
import Dashboard, { type SessionUser } from "./Dashboard";
import AdminApp from "./admin/AdminApp";

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
      const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
      const sub = await reg?.pushManager?.getSubscription().catch(() => null);
      if (sub) {
        await fetch("/api/diary-device", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint, remove: true }) }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      setUser(null);
    }
  };

  if (checking) return <div className="min-h-screen" style={{ background: "#071426" }} />;
  if (!user) return <Login onLogin={setUser} />;
  if (window.location.pathname.replace(/\/+$/, "") === "/admin") {
    if (user.role === "admin") return <AdminApp adminName={user.name} onLogout={logout} />;
    window.location.replace("/");
    return null;
  }
  return <Dashboard user={user} onLogout={logout} />;
}
