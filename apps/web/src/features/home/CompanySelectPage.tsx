import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Card, Dialog, Field, Input } from "@acos/ui";
import { api, keys, queryClient } from "../../lib/api.js";

export function CompanySelectPage() {
  const navigate = useNavigate();
  const companies = useQuery({ queryKey: keys.companies, queryFn: api.companies.list });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const create = useMutation({
    mutationFn: () => api.companies.create({ name, slug, currency: "USD" }),
    onSuccess: async (company) => {
      await queryClient.invalidateQueries({ queryKey: keys.companies });
      setOpen(false);
      await navigate({ to: "/c/$companyId", params: { companyId: company.id } });
    },
  });

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">Your companies</h1>
        <Button onClick={() => setOpen(true)}>New company</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2" data-testid="company-list">
        {companies.data?.map((company) => (
          <Link key={company.id} to="/c/$companyId" params={{ companyId: company.id }}>
            <Card className="transition-shadow hover:shadow-md">
              <p className="font-semibold text-ink-900">{company.name}</p>
              <p className="text-sm text-ink-400">
                /{company.slug} · {company.currency} · {company.role}
              </p>
            </Card>
          </Link>
        ))}
        {companies.data?.length === 0 && (
          <p className="text-sm text-ink-400">No companies yet — create the first one.</p>
        )}
      </div>

      <Dialog open={open} title="Create company" onClose={() => setOpen(false)}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name">
            <Input name="companyName" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Slug (kebab-case)">
            <Input
              name="companySlug"
              value={slug}
              pattern="[a-z0-9][a-z0-9-]*"
              onChange={(e) => setSlug(e.target.value)}
              required
            />
          </Field>
          {create.isError && <p className="text-sm text-danger">{String(create.error)}</p>}
          <Button type="submit" disabled={create.isPending} className="w-full justify-center">
            Create
          </Button>
        </form>
      </Dialog>
    </main>
  );
}
