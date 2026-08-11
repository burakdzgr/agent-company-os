import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, Card, Field, Input } from "@acos/ui";
import { api } from "../../lib/api.js";

export function SetupPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.auth.setup({ email, password, displayName });
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "setup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-50 p-4">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-center text-2xl font-bold text-ink-900">ACOS — first run</h1>
        <Card title="Create the Founder account">
          <form onSubmit={submit} className="space-y-3">
            <Field label="Display name">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </Field>
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Password (min 12 chars)">
              <Input
                type="password"
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full justify-center">
              {busy ? "Creating…" : "Create & sign in"}
            </Button>
          </form>
        </Card>
      </div>
    </main>
  );
}
