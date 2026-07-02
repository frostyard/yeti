import { Routes, Route, Navigate, Outlet, useLocation } from "react-router-dom";
import { useSession } from "./lib/queries";
import { RealtimeProvider } from "./lib/realtime";
import { AppShell } from "./components/shell/AppShell";
import { Overview } from "./routes/Overview";
import { Queue } from "./routes/Queue";
import { Jobs } from "./routes/Jobs";
import { Logs } from "./routes/Logs";
import { LogDetail } from "./routes/LogDetail";
import { IssueLogs } from "./routes/IssueLogs";
import { Repos } from "./routes/Repos";
import { Notifications } from "./routes/Notifications";
import { Config } from "./routes/Config";
import { Login } from "./routes/Login";
import { NotFound } from "./routes/NotFound";
import { Snowflake } from "lucide-react";

function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Snowflake size={28} className="animate-spin text-ice" />
    </div>
  );
}

function RequireAuth() {
  const { data: session, isLoading } = useSession();
  const location = useLocation();
  if (isLoading) return <Loading />;
  if (session?.authEnabled && !session.authenticated) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <Outlet />;
}

function Shell() {
  return (
    <RealtimeProvider>
      <AppShell />
    </RealtimeProvider>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route path="/" element={<Overview />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/logs/issue" element={<IssueLogs />} />
          <Route path="/logs/:runId" element={<LogDetail />} />
          <Route path="/repos" element={<Repos />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/config" element={<Config />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
