// Organizasyon görünümü (24 §6.6 + org yönetimi): şema + birim/pozisyon
// editörleri + işe alma + YÖNETİM: ajan yerleşimi (birim/pozisyon/kıdem/
// yönetici — PATCH /agents/:id/placement), birim arşivleme ve "sıfırdan kur"
// akışı. Tüm yazmalar mevcut denetimli API'lardan geçer; org kuralları
// (tek yönetici, döngüsüzlük, arşiv ön koşulları) sunucuda doğrulanır ve
// gerçek 409'lar burada aynen gösterilir.
import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Agent } from "@acos/contracts";
import { Button, Card, DataTable, Dialog, Field, Input, Select } from "@acos/ui";
import { AcosApiError } from "@acos/contracts/client";
import { api, keys, queryClient } from "../../lib/api.js";
import { OrgChart } from "./OrgChart.js";
import { HireWizard } from "../agents/HireWizard.js";

const STATUS_TR: Record<string, string> = {
  draft: "taslak",
  active: "aktif",
  paused: "duraklatıldı",
  offboarded: "işten çıkarıldı",
};

const SENIORITIES = ["junior", "mid", "senior", "staff", "lead", "expert"] as const;

function problemText(err: unknown): string {
  return err instanceof AcosApiError
    ? (err.problem.detail ?? err.problem.code)
    : String(err);
}

/** Yerleşim düzenleme modalı — birim / pozisyon / kıdem / yönetici. */
function PlacementModal({
  companyId,
  agent,
  agents,
  managerOf,
  onClose,
}: {
  companyId: string;
  agent: Agent;
  agents: Agent[];
  managerOf: Map<string, string>;
  onClose: () => void;
}) {
  const units = useQuery({ queryKey: keys.orgUnits(companyId), queryFn: () => api.org.listUnits(companyId) });
  const positions = useQuery({
    queryKey: keys.orgPositions(companyId),
    queryFn: () => api.org.listPositions(companyId),
  });
  const [orgUnitId, setOrgUnitId] = useState(agent.orgUnitId ?? "");
  const [positionId, setPositionId] = useState(agent.positionId ?? "");
  const [seniority, setSeniority] = useState(agent.seniority);
  const [managerId, setManagerId] = useState(managerOf.get(agent.id) ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const currentManager = managerOf.get(agent.id) ?? "";
      const body: Parameters<typeof api.agents.changePlacement>[2] = {};
      if (orgUnitId && orgUnitId !== agent.orgUnitId) body.orgUnitId = orgUnitId;
      if (positionId && positionId !== agent.positionId) body.positionId = positionId;
      if (seniority !== agent.seniority) body.seniority = seniority;
      if (managerId !== currentManager) body.managerAgentId = managerId === "" ? null : managerId;
      if (Object.keys(body).length === 0) return Promise.resolve(agent);
      return api.agents.changePlacement(companyId, agent.id, body);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.agents(companyId) }),
        queryClient.invalidateQueries({ queryKey: keys.orgEdges(companyId) }),
      ]);
      onClose();
    },
    onError: (err) => setError(problemText(err)),
  });

  return (
    <Dialog open title={`Yerleşimi düzenle — ${agent.name}`} onClose={onClose}>
      <form
        className="space-y-3"
        data-testid="placement-modal"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Birim">
          <Select value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)}>
            {units.data?.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Pozisyon">
          <Select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
            {positions.data?.map((position) => (
              <option key={position.id} value={position.id}>
                {position.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kıdem">
          <Select value={seniority} onChange={(e) => setSeniority(e.target.value as never)}>
            {SENIORITIES.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Yönetici">
          <Select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">— üst seviye (yönetici yok) —</option>
            {agents
              .filter((a) => a.id !== agent.id && a.status !== "offboarded")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>
        {error && (
          <p className="text-sm text-danger" data-testid="placement-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" disabled={save.isPending} data-testid="placement-save">
            {save.isPending ? "Kaydediliyor…" : "Kaydet"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function OrganizationView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const units = useQuery({ queryKey: keys.orgUnits(companyId), queryFn: () => api.org.listUnits(companyId) });
  const positions = useQuery({
    queryKey: keys.orgPositions(companyId),
    queryFn: () => api.org.listPositions(companyId),
  });
  const agents = useQuery({ queryKey: keys.agents(companyId), queryFn: () => api.agents.list(companyId) });
  const edges = useQuery({ queryKey: keys.orgEdges(companyId), queryFn: () => api.org.listEdges(companyId) });

  const [hireOpen, setHireOpen] = useState(false);
  const [placementFor, setPlacementFor] = useState<Agent | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [unitName, setUnitName] = useState("");
  const [unitSlug, setUnitSlug] = useState("");
  const [unitKind, setUnitKind] = useState<"department" | "team" | "office" | "division">("department");
  const [unitParent, setUnitParent] = useState("");
  const [positionTitle, setPositionTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const unitName_ = (id: string | null) => units.data?.find((u) => u.id === id)?.name ?? "—";
  const positionName = (id: string | null) =>
    positions.data?.find((p) => p.id === id)?.title ?? "—";

  // aktif reports_to kenarlarından yönetici haritası (ajan → yönetici)
  const managerOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const edge of edges.data ?? []) {
      if (edge.kind === "reports_to" && edge.endedAt === null && edge.toAgentId) {
        map.set(edge.fromAgentId, edge.toAgentId);
      }
    }
    return map;
  }, [edges.data]);
  const agentNameOf = (id: string | undefined) =>
    (agents.data ?? []).find((a) => a.id === id)?.name ?? "—";

  const invalidateOrg = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.agents(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgUnits(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgEdges(companyId) }),
    ]);

  const createUnit = useMutation({
    mutationFn: () =>
      api.org.createUnit(companyId, {
        name: unitName,
        slug: unitSlug,
        kind: unitKind,
        parentId: unitParent === "" ? null : unitParent,
      }),
    onSuccess: async () => {
      setUnitName("");
      setUnitSlug("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: keys.orgUnits(companyId) });
    },
    onError: (err) => setError(problemText(err)),
  });

  const createPosition = useMutation({
    mutationFn: () =>
      api.org.createPosition(companyId, {
        title: positionTitle,
        seniorityTrack: ["junior", "mid", "senior", "staff", "lead", "expert"],
        defaultRole: "member",
      }),
    onSuccess: async () => {
      setPositionTitle("");
      await queryClient.invalidateQueries({ queryKey: keys.orgPositions(companyId) });
    },
  });

  const archiveUnit = useMutation({
    mutationFn: (unitId: string) => api.org.archiveUnit(companyId, unitId),
    onSuccess: async () => {
      setError(null);
      await invalidateOrg();
    },
    onError: (err) => setError(problemText(err)),
  });

  const lifecycle = useMutation({
    mutationFn: ({ agentId, action }: { agentId: string; action: "pause" | "resume" | "offboard" }) =>
      api.agents.lifecycle(companyId, agentId, action, { reason: "Founder org yönetimi" }),
    onSuccess: async () => {
      setError(null);
      await invalidateOrg();
    },
    onError: (err) => setError(problemText(err)),
  });

  // Sıfırdan kur: tüm ajanları işten çıkar (hafıza korunur), sonra birimleri
  // yapraktan köke doğru arşivle. Her adım mevcut denetimli endpoint'tir.
  const resetOrg = useMutation({
    mutationFn: async () => {
      for (const agent of (agents.data ?? []).filter((a) => a.status !== "offboarded")) {
        if (agent.status === "draft") continue; // draft→offboarded geçişi yok; arşivi de bloklamaz
        await api.agents.lifecycle(companyId, agent.id, "offboard", {
          reason: "Founder: organizasyon sıfırlama",
        });
      }
      // çocukları önce: kalan birimlerden, başka birimin ebeveyni olmayanları
      // arşivle; liste bitene dek tekrarla
      let remaining = [...(units.data ?? [])];
      while (remaining.length > 0) {
        const parentIds = new Set(remaining.map((u) => u.parentId).filter(Boolean));
        const leaves = remaining.filter((u) => !parentIds.has(u.id));
        if (leaves.length === 0) break; // döngü olamaz ama güvenlik
        for (const unit of leaves) {
          await api.org.archiveUnit(companyId, unit.id);
        }
        const leafIds = new Set(leaves.map((u) => u.id));
        remaining = remaining.filter((u) => !leafIds.has(u.id));
      }
    },
    onSuccess: async () => {
      setResetOpen(false);
      setResetConfirm("");
      setError(null);
      await invalidateOrg();
    },
    onError: async (err) => {
      setError(problemText(err));
      await invalidateOrg(); // kısmi ilerleme görünür kalsın
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-ink-900">Organizasyon</h1>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => setResetOpen(true)}
            data-testid="org-reset-button"
            title="Tüm ajanları işten çıkarır ve birimleri arşivler — sıfırdan kurulum için"
          >
            Sıfırdan kur
          </Button>
          <Button onClick={() => setHireOpen(true)} data-testid="hire-button">
            Ajan işe al
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger" data-testid="org-error">
          {error}
        </p>
      )}

      <Card title="Raporlama hatları (reports_to ormanı)">
        {(agents.data?.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            Henüz ajan yok — şemayı görmek için ilk ajanı işe alın.
          </p>
        ) : (
          <OrgChart agents={agents.data ?? []} edges={edges.data ?? []} />
        )}
      </Card>

      <Card title="Çalışanlar — rol ve yerleşim">
        <DataTable
          rows={agents.data ?? []}
          rowKey={(agent) => agent.id}
          empty="Henüz ajan yok."
          columns={[
            { header: "No", cell: (a) => <span className="font-mono text-xs">{a.displayNumber}</span> },
            { header: "İsim", cell: (a) => a.name },
            { header: "Durum", cell: (a) => STATUS_TR[a.status] ?? a.status },
            { header: "Birim", cell: (a) => unitName_(a.orgUnitId) },
            { header: "Pozisyon", cell: (a) => positionName(a.positionId) },
            { header: "Kıdem", cell: (a) => a.seniority },
            { header: "Yönetici", cell: (a) => agentNameOf(managerOf.get(a.id)) },
            {
              header: "İşlemler",
              cell: (a) =>
                a.status === "offboarded" ? (
                  <span className="text-xs text-ink-400">—</span>
                ) : (
                  <div className="flex gap-1.5">
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5 text-xs"
                      onClick={() => setPlacementFor(a)}
                      data-testid={`placement-open-${a.employeeNumber}`}
                    >
                      Rol / birim
                    </Button>
                    {a.status === "active" && (
                      <Button
                        variant="ghost"
                        className="px-2 py-0.5 text-xs"
                        onClick={() => lifecycle.mutate({ agentId: a.id, action: "pause" })}
                      >
                        Duraklat
                      </Button>
                    )}
                    {a.status === "paused" && (
                      <Button
                        variant="ghost"
                        className="px-2 py-0.5 text-xs"
                        onClick={() => lifecycle.mutate({ agentId: a.id, action: "resume" })}
                      >
                        Devam
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5 text-xs text-danger"
                      onClick={() => {
                        if (window.confirm(`${a.name} işten çıkarılsın mı? Hafızası korunur.`)) {
                          lifecycle.mutate({ agentId: a.id, action: "offboard" });
                        }
                      }}
                      data-testid={`offboard-${a.employeeNumber}`}
                    >
                      İşten çıkar
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Birimler">
          <form
            className="mb-3 grid grid-cols-2 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createUnit.mutate();
            }}
          >
            <Field label="Ad">
              <Input name="unitName" value={unitName} onChange={(e) => setUnitName(e.target.value)} required />
            </Field>
            <Field label="Slug">
              <Input
                name="unitSlug"
                value={unitSlug}
                pattern="[a-z0-9][a-z0-9-]*"
                onChange={(e) => setUnitSlug(e.target.value)}
                required
              />
            </Field>
            <Field label="Tür">
              <Select value={unitKind} onChange={(e) => setUnitKind(e.target.value as never)}>
                <option value="department">departman</option>
                <option value="team">takım</option>
                <option value="office">ofis</option>
                <option value="division">bölüm</option>
              </Select>
            </Field>
            <Field label="Üst birim">
              <Select value={unitParent} onChange={(e) => setUnitParent(e.target.value)}>
                <option value="">— en üst seviye —</option>
                {units.data?.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="col-span-2">
              <Button type="submit" disabled={createUnit.isPending}>
                Birim oluştur
              </Button>
            </div>
          </form>
          <DataTable
            rows={units.data ?? []}
            rowKey={(unit) => unit.id}
            empty="Henüz birim yok."
            columns={[
              { header: "Ad", cell: (unit) => unit.name },
              { header: "Tür", cell: (unit) => unit.kind },
              {
                header: "Üst birim",
                cell: (unit) => units.data?.find((u) => u.id === unit.parentId)?.name ?? "—",
              },
              {
                header: "İşlemler",
                cell: (unit) => (
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5 text-xs text-danger"
                    onClick={() => {
                      if (window.confirm(`"${unit.name}" birimi arşivlensin mi?`)) {
                        archiveUnit.mutate(unit.id);
                      }
                    }}
                    data-testid={`unit-archive-${unit.slug}`}
                  >
                    Arşivle
                  </Button>
                ),
              },
            ]}
          />
        </Card>

        <Card title="Pozisyonlar">
          <form
            className="mb-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createPosition.mutate();
            }}
          >
            <div className="flex-1">
              <Field label="Unvan">
                <Input
                  name="positionTitle"
                  value={positionTitle}
                  onChange={(e) => setPositionTitle(e.target.value)}
                  required
                />
              </Field>
            </div>
            <Button type="submit" disabled={createPosition.isPending}>
              Pozisyon oluştur
            </Button>
          </form>
          <DataTable
            rows={positions.data ?? []}
            rowKey={(position) => position.id}
            empty="Henüz pozisyon yok."
            columns={[
              { header: "Unvan", cell: (position) => position.title },
              { header: "Varsayılan rol", cell: (position) => position.defaultRole },
            ]}
          />
        </Card>
      </div>

      <HireWizard companyId={companyId} open={hireOpen} onClose={() => setHireOpen(false)} />
      {placementFor && (
        <PlacementModal
          companyId={companyId}
          agent={placementFor}
          agents={agents.data ?? []}
          managerOf={managerOf}
          onClose={() => setPlacementFor(null)}
        />
      )}

      <Dialog open={resetOpen} title="Organizasyonu sıfırdan kur" onClose={() => setResetOpen(false)}>
        <div className="space-y-3" data-testid="org-reset-dialog">
          <p className="text-sm text-ink-700">
            Bu işlem <strong>tüm ajanları işten çıkarır</strong> (hafızaları ve geçmişleri korunur)
            ve <strong>tüm birimleri arşivler</strong>. Ardından birimleri ve kadroyu sıfırdan
            kurabilirsiniz. Görev geçmişi, olay akışı ve maliyet kayıtları silinmez.
          </p>
          <Field label='Onaylamak için "SIFIRLA" yazın'>
            <Input
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              data-testid="org-reset-confirm"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Vazgeç
            </Button>
            <Button
              disabled={resetConfirm !== "SIFIRLA" || resetOrg.isPending}
              onClick={() => resetOrg.mutate()}
              data-testid="org-reset-run"
            >
              {resetOrg.isPending ? "Sıfırlanıyor…" : "Sıfırla"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
