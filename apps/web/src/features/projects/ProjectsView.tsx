// Projects view — /c/$companyId/projects (T42; 14 §2/§6 MVP slice): list +
// the 3-field Founder import form (name, objective/goal, constraints +
// optional git URL — nothing technical, P4) + detail pane with Overview and
// the rendered Intake Report (imported projects). Live-updated via the
// project.* invalidation family.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Field, Input, StatusPill, Textarea, cn } from "@acos/ui";
import type { ProjectDto } from "@acos/contracts";
import { api } from "../../lib/api.js";

const STATUS_TONE: Record<string, "ok" | "warn" | "accent" | "neutral"> = {
  active: "ok",
  intake: "accent",
  proposed: "neutral",
  paused: "warn",
  completed: "ok",
  archived: "neutral",
  cancelled: "warn",
};

function CreateProjectForm({ companyId, onDone }: { companyId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [constraints, setConstraints] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.projects.create(companyId, {
        name,
        objective,
        ...(constraints.trim() && { constraints: constraints.trim() }),
        ...(sourceUrl.trim() && { source: { kind: "git_url" as const, url: sourceUrl.trim() } }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [companyId, "projects"] });
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div data-testid="project-create-form" className="contents" />
      <h3 className="text-sm font-semibold">Yeni proje</h3>
      <Field label="Ad">
        <Input name="name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="İş hedefi / istenen sonuç">
        <Textarea
          name="objective"
          rows={3}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Bu proje iş açısından neyi başarmalı?"
        />
      </Field>
      <Field label="Kısıtlar (opsiyonel)">
        <Textarea
          name="constraints"
          rows={2}
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          placeholder="Bütçe, son tarih, 'X'e dokunma'…"
        />
      </Field>
      <Field label="Git URL'den içe aktar (opsiyonel — boş = sıfırdan)">
        <Input
          name="sourceUrl"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://…/repo.git"
        />
      </Field>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || name.length < 2 || objective.length < 4}
          data-testid="project-create-submit"
        >
          {create.isPending ? "Oluşturuluyor…" : "Proje oluştur"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Vazgeç
        </Button>
      </div>
    </Card>
  );
}

function ProjectDetail({ companyId, project }: { companyId: string; project: ProjectDto }) {
  const [tab, setTab] = useState<"overview" | "report">("overview");
  const report = useQuery({
    queryKey: [companyId, "projects", project.id, "report"],
    queryFn: () => api.projects.report(companyId, project.id),
    enabled: tab === "report" && project.intakeReportArtifactId !== null,
  });

  return (
    // Card swallows unknown props — the testid rides an inner wrapper
    <Card className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div data-testid="project-detail" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{project.name}</h2>
        <StatusPill tone={STATUS_TONE[project.status] ?? "neutral"}>{project.status}</StatusPill>
        <StatusPill tone="neutral">{project.kind}</StatusPill>
        <div className="ml-auto flex gap-1">
          {(["overview", "report"] as const).map((t) => (
            <Button
              key={t}
              variant={tab === t ? "primary" : "ghost"}
              onClick={() => setTab(t)}
              data-testid={`project-tab-${t}`}
            >
              {t === "overview" ? "Genel" : "Analiz Raporu"}
            </Button>
          ))}
        </div>
      </div>
      {tab === "overview" ? (
        <div className="flex flex-col gap-3 overflow-y-auto text-sm">
          <section>
            <h4 className="text-xs font-semibold uppercase text-acos-fg2">Hedef</h4>
            <p className="whitespace-pre-wrap">{project.objective}</p>
          </section>
          {project.constraints && (
            <section>
              <h4 className="text-xs font-semibold uppercase text-acos-fg2">Kısıtlar</h4>
              <p className="whitespace-pre-wrap">{project.constraints}</p>
            </section>
          )}
          {project.repository && (
            <section>
              <h4 className="text-xs font-semibold uppercase text-acos-fg2">Depo</h4>
              <p>
                <code className="text-xs">{project.repository.barePath}</code> — varsayılan dal{" "}
                <code className="text-xs">{project.repository.defaultBranch}</code>
                {project.repository.originUrl && (
                  <>
                    {" "}
                    · içe aktarıldı: <code className="text-xs">{project.repository.originUrl}</code>
                  </>
                )}
              </p>
            </section>
          )}
        </div>
      ) : project.intakeReportArtifactId === null ? (
        <p className="text-sm text-acos-fg2" data-testid="report-missing">
          {project.status === "intake"
            ? "Analiz sürüyor — rapor buraya düşecek."
            : "Analiz raporu yok (sıfırdan proje)."}
        </p>
      ) : report.isLoading ? (
        <p className="text-sm text-acos-fg2">Rapor yükleniyor…</p>
      ) : (
        <pre
          className="flex-1 overflow-auto whitespace-pre-wrap rounded bg-acos-bg1 p-3 text-xs leading-relaxed"
          data-testid="intake-report"
        >
          {report.data?.contentMd ?? ""}
        </pre>
      )}
      </div>
    </Card>
  );
}

export function ProjectsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: [companyId, "projects"],
    queryFn: () => api.projects.list(companyId),
    refetchInterval: 10_000, // intake progress without a dedicated ws family yet
  });
  const items = projects.data?.items ?? [];
  const selected = items.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <div className="flex w-80 shrink-0 flex-col gap-2">
        <Button onClick={() => setCreating(true)} data-testid="project-create-open">
          + Yeni proje
        </Button>
        <Card className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {projects.isLoading && <div className="p-2 text-sm text-acos-fg2">Yükleniyor…</div>}
          {!projects.isLoading && items.length === 0 && (
            <div className="p-2 text-sm text-acos-fg2">Henüz proje yok.</div>
          )}
          {items.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              data-testid="project-row"
              className={cn(
                "rounded px-2 py-1.5 text-left text-sm hover:bg-acos-bg3",
                selectedId === p.id && "bg-acos-bg2",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{p.name}</span>
                <StatusPill tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status}</StatusPill>
              </div>
              <div className="mt-0.5 text-xs text-acos-fg2">
                {p.kind} · {new Date(p.createdAt).toLocaleDateString()}
              </div>
            </button>
          ))}
        </Card>
      </div>
      {creating ? (
        <CreateProjectForm companyId={companyId} onDone={() => setCreating(false)} />
      ) : selected ? (
        <ProjectDetail key={selected.id} companyId={companyId} project={selected} />
      ) : (
        <Card className="flex flex-1 items-center justify-center text-sm text-acos-fg2">
          Bir proje seçin ya da oluşturun.
        </Card>
      )}
    </div>
  );
}
