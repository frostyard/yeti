import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Snowflake, LogIn } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "../lib/queries";
import { api } from "../lib/api";
import { Card, Button } from "../components/ui/base";
import { TextInput } from "../components/ui/FormField";

const OAUTH_ERRORS: Record<string, string> = {
  oauth_denied: "Sign-in was cancelled.",
  oauth_error: "OAuth sign-in failed. Please try again.",
  not_org_member: "Your GitHub account is not a member of an allowed organization.",
};

export function Login() {
  const { data: session } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(OAUTH_ERRORS[params.get("error") ?? ""] ?? null);
  const [busy, setBusy] = useState(false);

  const next = params.get("next") || "/";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(token);
      await qc.invalidateQueries();
      navigate(next, { replace: true });
    } catch {
      setError("Invalid token.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-2">
          <Snowflake size={22} className="text-ice" />
          <span className="text-[17px] font-semibold text-text">frostyard<span className="text-muted"> / </span><span className="text-accent">yeti</span></span>
        </div>

        {error && <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

        {session?.methods.oauth && (
          <a href={`${session.oauthLoginUrl}`} className="mb-3 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-accent text-[13px] font-medium text-[#04121f] hover:bg-accent-bright">
            <LogIn size={15} /> Sign in with GitHub
          </a>
        )}

        {session?.methods.token && (
          <form onSubmit={submit} className="space-y-2">
            {session.methods.oauth && <div className="my-3 text-center text-[11px] uppercase tracking-wide text-muted">or token</div>}
            <TextInput type="password" placeholder="Access token" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
            <Button type="submit" variant="primary" size="md" className="w-full" loading={busy} disabled={!token}>Sign in</Button>
          </form>
        )}

        {session && !session.methods.oauth && !session.methods.token && (
          <p className="text-[13px] text-muted">Authentication is not configured.</p>
        )}
      </Card>
    </div>
  );
}
