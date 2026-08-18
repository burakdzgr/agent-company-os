// GitHub bağlantısı (2026-08-18, Founder kararı: "github adresimi tam
// yetkiyle bağlamak istiyorum — repo açsınlar, publish etsinler").
//
// S2 korunur: PAT yalnız secrets seam'inde (MASTER_KEY ile mühürlü) yaşar,
// hiçbir ajan girdisinden/çıktısından geçmez; ajanlar GitHub'a DOĞRUDAN
// dokunmaz — iç bare repo tek gerçek kaynaktır (ADR-010), GitHub bir YANSIdır:
// lead merge sonrası sunucu default branch'i uzağa iter (publish), repo yoksa
// Founder'ın hesabında açar. Token URL'e gömülü gider ama asla loglanmaz.
import { and, eq } from "drizzle-orm";
import { companyContext, type CompanyContext, type GuardedDb } from "@acos/db";
import { projects, repositories, secrets } from "@acos/db/schema";
import { sealSecret, unsealSecret } from "../auth/crypto.js";

const TOKEN_SECRET = "github.token";
const OWNER_SECRET = "github.owner";
const API = "https://api.github.com";

export class GithubError extends Error {
  constructor(
    readonly code: "NOT_CONNECTED" | "TOKEN_INVALID" | "API_FAILED",
    message: string,
  ) {
    super(message);
  }
}

export interface GithubStatus {
  connected: boolean;
  owner: string | null;
}

export class GithubService {
  constructor(
    private readonly db: GuardedDb,
    private readonly masterKey: string | undefined,
  ) {}

  private requireKey(): string {
    if (!this.masterKey) throw new GithubError("API_FAILED", "MASTER_KEY not configured");
    return this.masterKey;
  }

  private async readSecret(ctx: CompanyContext, name: string): Promise<string | null> {
    const [row] = await this.db
      .select({ ciphertext: secrets.ciphertext })
      .from(secrets)
      .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, name)));
    if (!row) return null;
    return unsealSecret(this.requireKey(), Buffer.from(row.ciphertext as Uint8Array));
  }

  private async writeSecret(
    ctx: CompanyContext,
    name: string,
    value: string,
    userId: string,
  ): Promise<void> {
    const sealed = await sealSecret(this.requireKey(), value);
    const existing = await this.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, name)));
    if (existing[0]) {
      await this.db
        .update(secrets)
        .set({ ciphertext: sealed })
        .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, name)));
    } else {
      await this.db.insert(secrets).values({
        companyId: ctx.companyId,
        name,
        scope: "company",
        ciphertext: sealed,
        createdByUserId: userId,
      });
    }
  }

  async status(ctx: CompanyContext): Promise<GithubStatus> {
    if (!this.masterKey) return { connected: false, owner: null };
    const owner = await this.readSecret(ctx, OWNER_SECRET);
    const token = await this.readSecret(ctx, TOKEN_SECRET);
    return { connected: token !== null, owner };
  }

  /** PAT'i GitHub'a karşı doğrular (GET /user), login'i owner olarak saklar. */
  async connect(ctx: CompanyContext, token: string, userId: string): Promise<GithubStatus> {
    const res = await fetch(`${API}/user`, { headers: this.headers(token) });
    if (res.status === 401 || res.status === 403) {
      throw new GithubError("TOKEN_INVALID", "GitHub token reddedildi (401/403)");
    }
    if (!res.ok) throw new GithubError("API_FAILED", `GitHub /user → ${res.status}`);
    const user = (await res.json()) as { login?: string };
    if (!user.login) throw new GithubError("API_FAILED", "GitHub /user cevabında login yok");
    await this.writeSecret(ctx, TOKEN_SECRET, token, userId);
    await this.writeSecret(ctx, OWNER_SECRET, user.login, userId);
    return { connected: true, owner: user.login };
  }

  async disconnect(ctx: CompanyContext): Promise<void> {
    await this.db
      .delete(secrets)
      .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, TOKEN_SECRET)));
    await this.db
      .delete(secrets)
      .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, OWNER_SECRET)));
  }

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "acos",
      "x-github-api-version": "2022-11-28",
    };
  }

  /**
   * Projenin GitHub yansımasını garanti eder: repositories.github_remote
   * doluysa onu döner; boşsa Founder hesabında private repo AÇAR ve bağlar.
   * Ad çakışırsa (422) mevcut repo bağlanır — idempotent.
   */
  async ensureRemote(
    ctx: CompanyContext,
    projectId: string,
    repoName: string,
  ): Promise<{ remoteUrl: string; token: string } | null> {
    const token = await this.readSecret(ctx, TOKEN_SECRET).catch(() => null);
    const owner = await this.readSecret(ctx, OWNER_SECRET).catch(() => null);
    if (!token || !owner) return null; // bağlı değil — sessizce atla (yansı opsiyonel)

    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.companyId, ctx.companyId), eq(repositories.projectId, projectId)));
    if (!repo) return null;
    if (repo.githubRemote) return { remoteUrl: repo.githubRemote, token };

    const safeName = repoName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || `acos-${projectId.slice(0, 8)}`;
    const res = await fetch(`${API}/user/repos`, {
      method: "POST",
      headers: { ...this.headers(token), "content-type": "application/json" },
      body: JSON.stringify({ name: safeName, private: true, auto_init: false }),
    });
    let remoteUrl: string;
    if (res.ok) {
      const created = (await res.json()) as { clone_url?: string };
      remoteUrl = created.clone_url ?? `https://github.com/${owner}/${safeName}.git`;
    } else if (res.status === 422) {
      // ad zaten var — mevcut repoya bağlan (idempotent yeniden yayın)
      remoteUrl = `https://github.com/${owner}/${safeName}.git`;
    } else {
      throw new GithubError("API_FAILED", `GitHub repo create → ${res.status}`);
    }
    await this.db
      .update(repositories)
      .set({ githubRemote: remoteUrl })
      .where(and(eq(repositories.companyId, ctx.companyId), eq(repositories.id, repo.id)));
    return { remoteUrl, token };
  }

  /** https://github.com/o/r.git → tokenlı push URL'i (asla loglanmaz). */
  static tokenizedUrl(remoteUrl: string, token: string): string {
    return remoteUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  }
}

/**
 * Projeyi GitHub'a yayınlar: remote yoksa Founder hesabında açar + bağlar,
 * sonra iç bare repo'yu iter. Route'tan (Founder tetikler) ve merge-sonrası
 * hook'tan (otomatik senkron) çağrılır. GitHub bağlı değilse sessiz no-op.
 */
export async function publishProjectToGithub(deps: {
  db: GuardedDb;
  masterKey: string | undefined;
  sandbox: { url: string; token: string };
  companyId: string;
  projectId: string;
}): Promise<{ published: boolean; remoteUrl: string | null }> {
  const ctx = companyContext(deps.companyId);
  const svc = new GithubService(deps.db, deps.masterKey);
  const [project] = await deps.db
    .select({ slug: projects.slug, name: projects.name })
    .from(projects)
    .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, deps.projectId)));
  if (!project) return { published: false, remoteUrl: null };
  const remote = await svc.ensureRemote(ctx, deps.projectId, project.slug ?? project.name);
  if (!remote) return { published: false, remoteUrl: null };
  const authB64 = Buffer.from(`x-access-token:${remote.token}`).toString("base64");
  const res = await fetch(`${deps.sandbox.url}/internal/v1/repos/publish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.sandbox.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ projectId: deps.projectId, remoteUrl: remote.remoteUrl, authB64 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubError("API_FAILED", `publish → ${res.status}: ${text.slice(0, 300)}`);
  }
  return { published: true, remoteUrl: remote.remoteUrl };
}

export function githubServiceFactory(
  guardedDb: () => GuardedDb,
  masterKey: string | undefined,
): (companyId: string) => { svc: GithubService; ctx: CompanyContext } {
  return (companyId) => ({
    svc: new GithubService(guardedDb(), masterKey),
    ctx: companyContext(companyId),
  });
}
