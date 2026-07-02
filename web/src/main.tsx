import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { AppRoutes } from "./router";
import { TickProvider } from "./lib/time";
import { setUnauthorizedHandler } from "./lib/api";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, err) => (err as { status?: number })?.status === 401 ? false : count < 2, refetchOnWindowFocus: true },
  },
});

/** Wire global 401 handling to client-side navigation. */
function AuthWiring() {
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!location.pathname.startsWith("/login")) {
        navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
      }
    });
  }, [navigate]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthWiring />
        <TickProvider>
          <AppRoutes />
        </TickProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
