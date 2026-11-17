import { useEffect, useState } from "react";
import AcademyDashboard from "./AcademyDashboard";
import { loadBootstrap, type Bootstrap } from "./adminApi";
import "./admin.css";

export default function AdminApp({
  adminName,
  onLogout,
}: {
  adminName: string;
  onLogout: () => void;
}) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadBootstrap().then((result) => {
      if (cancelled) return;
      if (result.ok) setData(result);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="admin-theme grid min-h-screen place-items-center bg-[#071426] p-6 text-center text-[#f3f6fa]">
        <div>
          <p className="text-base font-semibold">Не вдалося завантажити панель</p>
          <p className="mt-2 text-xs text-slate-400">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-5 rounded-xl bg-[#2457a6] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#3478d4]"
          >
            Спробувати ще раз
          </button>
        </div>
      </div>
    );
  }

  if (!data) return <div className="admin-theme min-h-screen bg-[#071426]" />;

  return (
    <div className="admin-theme">
      <AcademyDashboard
        initialGroups={data.groups}
        initialGrades={data.grades}
        initialLessons={data.lessons}
        initialActivity={data.activity}
        initialStudents={data.students}
        canManage
        adminName={adminName}
        onLogout={onLogout}
      />
    </div>
  );
}
