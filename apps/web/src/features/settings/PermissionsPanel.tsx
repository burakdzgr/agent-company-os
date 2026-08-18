import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Dialog, Field, Input, Select } from "@acos/ui";
import { api } from "../../lib/api.js";
import type { ToolDefinition, ToolPermissionItem, GrantToolPermissionRequest } from "@acos/contracts";

export function PermissionsPanel() {
  const queryClient = useQueryClient();
  const [grantDialogOpen, setGrantDialogOpen] = useState(false);

  const toolsQuery = useQuery({
    queryKey: ["tools"],
    queryFn: () => api.tools.list(),
  });

  const permissionsQuery = useQuery({
    queryKey: ["toolPermissions"],
    queryFn: () => api.tools.permissions.list(),
  });

  const grantMutation = useMutation({
    mutationFn: (body: GrantToolPermissionRequest) => api.tools.permissions.grant(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["toolPermissions"] });
      setGrantDialogOpen(false);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (permissionId: string) => api.tools.permissions.revoke(permissionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["toolPermissions"] });
    },
  });

  if (toolsQuery.isLoading || permissionsQuery.isLoading) {
    return <p className="text-sm text-acos-fg2">Yükleniyor...</p>;
  }

  const tools = toolsQuery.data ?? [];
  const permissions = permissionsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <Card
        title="Araç İzinleri"
        description="Ajanların ve departmanların kullanabileceği araçları yönetin."
      >
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setGrantDialogOpen(true)}>İzin Ekle</Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-acos-line text-xs text-acos-fg1">
              <tr>
                <th className="pb-2 font-medium">Araç</th>
                <th className="pb-2 font-medium">Hedef</th>
                <th className="pb-2 font-medium">Tür</th>
                <th className="pb-2 font-medium">Risk</th>
                <th className="pb-2 font-medium">Oluşturulma</th>
                <th className="pb-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-acos-line">
              {permissions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-acos-fg2">
                    Hiç izin tanımlanmamış. "İzin Ekle" butonuna tıklayarak başlayın.
                  </td>
                </tr>
              ) : (
                permissions.map((perm) => {
                  const tool = tools.find((t) => t.name === perm.toolName);
                  return (
                    <tr key={perm.id}>
                      <td className="py-2 font-mono text-xs text-acos-fg0">{perm.toolName}</td>
                      <td className="py-2 text-acos-fg0">{perm.subjectLabel ?? perm.subjectId}</td>
                      <td className="py-2">
                        <span className="rounded-full bg-acos-bg2 px-2 py-0.5 text-xs text-acos-fg1">
                          {perm.subjectKind}
                        </span>
                      </td>
                      <td className="py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            tool?.risk === "R0"
                              ? "bg-green-500/10 text-green-400"
                              : tool?.risk === "R1"
                                ? "bg-yellow-500/10 text-yellow-400"
                                : "bg-red-500/10 text-red-400"
                          }`}
                        >
                          {tool?.risk ?? "?"}
                        </span>
                      </td>
                      <td className="py-2 text-xs text-acos-fg2">
                        {new Date(perm.createdAt).toLocaleDateString("tr-TR")}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          onClick={() => {
                            if (confirm(`"${perm.toolName}" iznini iptal et?`)) {
                              revokeMutation.mutate(perm.id);
                            }
                          }}
                          disabled={revokeMutation.isPending}
                          className="text-xs"
                        >
                          İptal
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog
        open={grantDialogOpen}
        title="Yeni İzin Ekle"
        onClose={() => setGrantDialogOpen(false)}
      >
        <GrantPermissionForm
          tools={tools}
          onSubmit={(data) => grantMutation.mutate(data)}
          isPending={grantMutation.isPending}
          error={grantMutation.error}
        />
      </Dialog>
    </div>
  );
}

function GrantPermissionForm({
  tools,
  onSubmit,
  isPending,
  error,
}: {
  tools: ToolDefinition[];
  onSubmit: (data: GrantToolPermissionRequest) => void;
  isPending: boolean;
  error: unknown;
}) {
  const [toolName, setToolName] = useState("");
  const [subjectKind, setSubjectKind] = useState<"agent" | "org_unit" | "position">("org_unit");
  const [subjectId, setSubjectId] = useState("");

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ toolName, subjectKind, subjectId });
      }}
    >
      <Field label="Araç">
        <Select value={toolName} onChange={(e) => setToolName(e.target.value)} required>
          <option value="">Seçin...</option>
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} — {t.description}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Hedef Türü">
        <Select
          value={subjectKind}
          onChange={(e) => setSubjectKind(e.target.value as typeof subjectKind)}
          required
        >
          <option value="org_unit">Departman (org_unit)</option>
          <option value="agent">Ajan (agent)</option>
          <option value="position">Pozisyon (position)</option>
        </Select>
      </Field>

      <Field label="Hedef ID (UUID)">
        <Input
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
          placeholder="ör. 123e4567-e89b-12d3-a456-426614174000"
          pattern="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
          required
        />
        <p className="mt-1 text-xs text-acos-fg2">
          İpucu: Departman ID'lerini Organizasyon sayfasından, ajan ID'lerini Ajanlar sayfasından
          kopyalayabilirsiniz.
        </p>
      </Field>

      {error && <p className="text-sm text-danger">{String(error)}</p>}

      <Button type="submit" disabled={isPending} className="w-full justify-center">
        {isPending ? "Ekleniyor..." : "İzin Ekle"}
      </Button>
    </form>
  );
}
