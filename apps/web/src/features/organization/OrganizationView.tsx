// Organization view (24 §6.6): org chart + unit/position editors + hire.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Card, DataTable, Field, Input, Select } from "@acos/ui";
import { AcosApiError } from "@acos/contracts/client";
import { api, keys, queryClient } from "../../lib/api.js";
import { OrgChart } from "./OrgChart.js";
import { HireWizard } from "../agents/HireWizard.js";

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
  const [unitName, setUnitName] = useState("");
  const [unitSlug, setUnitSlug] = useState("");
  const [unitKind, setUnitKind] = useState<"department" | "team" | "office" | "division">("department");
  const [unitParent, setUnitParent] = useState("");
  const [positionTitle, setPositionTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    onError: (err) =>
      setError(err instanceof AcosApiError ? err.problem.detail ?? err.problem.code : String(err)),
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-ink-900">Organization</h1>
        <Button onClick={() => setHireOpen(true)} data-testid="hire-button">
          Hire agent
        </Button>
      </div>

      <Card title="Reporting lines (reports_to forest)">
        {(agents.data?.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            No agents yet — hire the first one to see the chart.
          </p>
        ) : (
          <OrgChart agents={agents.data ?? []} edges={edges.data ?? []} />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Units">
          <form
            className="mb-3 grid grid-cols-2 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createUnit.mutate();
            }}
          >
            <Field label="Name">
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
            <Field label="Kind">
              <Select value={unitKind} onChange={(e) => setUnitKind(e.target.value as never)}>
                <option value="department">department</option>
                <option value="team">team</option>
                <option value="office">office</option>
                <option value="division">division</option>
              </Select>
            </Field>
            <Field label="Parent">
              <Select value={unitParent} onChange={(e) => setUnitParent(e.target.value)}>
                <option value="">— top level —</option>
                {units.data?.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="col-span-2">
              <Button type="submit" disabled={createUnit.isPending}>
                Create unit
              </Button>
              {error && <span className="ml-3 text-sm text-danger">{error}</span>}
            </div>
          </form>
          <DataTable
            rows={units.data ?? []}
            rowKey={(unit) => unit.id}
            empty="No units yet."
            columns={[
              { header: "Name", cell: (unit) => unit.name },
              { header: "Kind", cell: (unit) => unit.kind },
              {
                header: "Parent",
                cell: (unit) => units.data?.find((u) => u.id === unit.parentId)?.name ?? "—",
              },
            ]}
          />
        </Card>

        <Card title="Positions">
          <form
            className="mb-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createPosition.mutate();
            }}
          >
            <div className="flex-1">
              <Field label="Title">
                <Input
                  name="positionTitle"
                  value={positionTitle}
                  onChange={(e) => setPositionTitle(e.target.value)}
                  required
                />
              </Field>
            </div>
            <Button type="submit" disabled={createPosition.isPending}>
              Create position
            </Button>
          </form>
          <DataTable
            rows={positions.data ?? []}
            rowKey={(position) => position.id}
            empty="No positions yet."
            columns={[
              { header: "Title", cell: (position) => position.title },
              { header: "Default role", cell: (position) => position.defaultRole },
            ]}
          />
        </Card>
      </div>

      <HireWizard companyId={companyId} open={hireOpen} onClose={() => setHireOpen(false)} />
    </div>
  );
}
