// Typed client SDK (21 §6) — hand-authored from the same Zod source, NOT an
// OpenAPI round-trip. apps/web consumes ONLY this client + @acos/ui.
import { z } from "zod";
import { HealthResponseSchema, type HealthResponse } from "../health.js";
import { ProblemJsonSchema, type ProblemJson } from "../errors.js";
import {
  LoginResponseSchema,
  TotpRequiredResponseSchema,
  OkSchema,
  PatCreatedSchema,
  PatListItemSchema,
  SetupStatusSchema,
  SessionUserSchema,
  type SessionUser,
} from "../auth.js";
import { CompanySchema, CompanySettingsSchema, type Company, type CompanySettings } from "../companies.js";
import {
  EscalationChainSchema,
  OrgEdgeSchema,
  OrgUnitSchema,
  PositionSchema,
  TeamRosterEntrySchema,
  type EscalationChain,
  type OrgEdge,
  type OrgUnit,
  type Position,
} from "../org.js";
import {
  AgentSchema,
  AgentSessionSchema,
  ModelBindingSchema,
  type Agent,
  type ModelBinding,
} from "../agents.js";

export class AcosApiError extends Error {
  constructor(public readonly problem: ProblemJson) {
    super(`${problem.code}: ${problem.detail ?? problem.title}`);
    this.name = "AcosApiError";
  }
}

export interface AcosClientOptions {
  baseUrl: string;
  /** PAT bearer; session-cookie auth needs no token (browser sends the cookie). */
  token?: string;
  fetch?: typeof fetch;
}

const LoginResultSchema = z.union([LoginResponseSchema, TotpRequiredResponseSchema]);

function readCsrfCookie(): string | null {
  // contracts compiles without DOM libs; the browser document is probed lazily.
  const doc = (globalThis as { document?: { cookie: string } }).document;
  if (!doc) return null;
  const match = /(?:^|;\s*)acos_csrf=([^;]+)/.exec(doc.cookie);
  return match?.[1] ?? null;
}

export function createAcosClient(options: AcosClientOptions) {
  const fetchImpl = options.fetch ?? fetch;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (method !== "GET") {
      const csrf = readCsrfCookie();
      if (csrf) headers["x-csrf-token"] = csrf;
    }
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      credentials: "include",
    });
    const text = await response.text();
    const json: unknown = text === "" ? null : JSON.parse(text);
    if (!response.ok) {
      const problem = ProblemJsonSchema.safeParse(json);
      if (problem.success) throw new AcosApiError(problem.data);
      throw new Error(`HTTP ${response.status} at ${path}`);
    }
    return json;
  }

  const get = (path: string) => request("GET", path);
  const post = (path: string, body?: unknown) => request("POST", path, body);

  return {
    health: {
      get: async (): Promise<HealthResponse> => HealthResponseSchema.parse(await get("/api/health")),
    },
    auth: {
      setupStatus: async () => SetupStatusSchema.parse(await get("/api/v1/auth/setup")),
      setup: async (body: { email: string; password: string; displayName: string }) =>
        LoginResponseSchema.parse(await post("/api/v1/auth/setup", body)),
      login: async (body: { email: string; password: string; totpCode?: string }) =>
        LoginResultSchema.parse(await post("/api/v1/auth/login", body)),
      logout: async () => OkSchema.parse(await post("/api/v1/auth/logout")),
      me: async (): Promise<SessionUser> => SessionUserSchema.parse(await get("/api/v1/auth/me")),
      createPat: async (body: { name: string; scopes: string[]; expiresAt?: string }) =>
        PatCreatedSchema.parse(await post("/api/v1/auth/pats", body)),
      listPats: async () => z.array(PatListItemSchema).parse(await get("/api/v1/auth/pats")),
    },
    companies: {
      list: async (): Promise<Company[]> => z.array(CompanySchema).parse(await get("/api/v1/companies")),
      create: async (body: { name: string; slug: string; currency?: string }): Promise<Company> =>
        CompanySchema.parse(await post("/api/v1/companies", body)),
      get: async (companyId: string): Promise<Company> =>
        CompanySchema.parse(await get(`/api/v1/companies/${companyId}`)),
      settings: async (companyId: string): Promise<CompanySettings> =>
        CompanySettingsSchema.parse(await get(`/api/v1/companies/${companyId}/settings`)),
      updateSettings: async (companyId: string, body: Partial<CompanySettings>) =>
        CompanySettingsSchema.parse(await request("PATCH", `/api/v1/companies/${companyId}/settings`, body)),
    },
    org: {
      listUnits: async (companyId: string): Promise<OrgUnit[]> =>
        z.array(OrgUnitSchema).parse(await get(`/api/v1/companies/${companyId}/org/units`)),
      createUnit: async (
        companyId: string,
        body: { name: string; slug: string; kind: "department" | "team" | "office" | "division"; parentId?: string | null },
      ): Promise<OrgUnit> =>
        OrgUnitSchema.parse(await post(`/api/v1/companies/${companyId}/org/units`, body)),
      listPositions: async (companyId: string): Promise<Position[]> =>
        z.array(PositionSchema).parse(await get(`/api/v1/companies/${companyId}/org/positions`)),
      createPosition: async (
        companyId: string,
        body: { title: string; seniorityTrack: string[]; defaultRole: string; description?: string },
      ): Promise<Position> =>
        PositionSchema.parse(await post(`/api/v1/companies/${companyId}/org/positions`, body)),
      listEdges: async (companyId: string): Promise<OrgEdge[]> =>
        z.array(OrgEdgeSchema).parse(await get(`/api/v1/companies/${companyId}/org/edges`)),
      createEdge: async (
        companyId: string,
        body: { fromAgentId: string; kind: string; toAgentId?: string; toUnitId?: string },
      ): Promise<OrgEdge> =>
        OrgEdgeSchema.parse(await post(`/api/v1/companies/${companyId}/org/edges`, body)),
      chain: async (companyId: string, agentId: string): Promise<EscalationChain> =>
        EscalationChainSchema.parse(
          await get(`/api/v1/companies/${companyId}/org/agents/${agentId}/chain`),
        ),
      roster: async (companyId: string, unitId: string) =>
        z
          .array(TeamRosterEntrySchema)
          .parse(await get(`/api/v1/companies/${companyId}/org/units/${unitId}/roster`)),
    },
    agents: {
      list: async (companyId: string): Promise<Agent[]> =>
        z.array(AgentSchema).parse(await get(`/api/v1/companies/${companyId}/agents`)),
      get: async (companyId: string, agentId: string): Promise<Agent> =>
        AgentSchema.parse(await get(`/api/v1/companies/${companyId}/agents/${agentId}`)),
      hire: async (
        companyId: string,
        body: {
          name: string;
          positionId: string;
          orgUnitId: string;
          seniority: string;
          autonomyLevel: number;
          persona: string;
          managerAgentId?: string | null;
          leadsUnit?: boolean;
          activate?: boolean;
        },
      ): Promise<Agent> =>
        AgentSchema.parse(await post(`/api/v1/companies/${companyId}/agents`, body)),
      lifecycle: async (
        companyId: string,
        agentId: string,
        action: "activate" | "pause" | "resume" | "offboard",
        body?: { reason?: string; topLevel?: boolean },
      ): Promise<Agent> =>
        AgentSchema.parse(
          await post(`/api/v1/companies/${companyId}/agents/${agentId}/${action}`, body ?? {}),
        ),
      listBindings: async (companyId: string, agentId: string): Promise<ModelBinding[]> =>
        z
          .array(ModelBindingSchema)
          .parse(await get(`/api/v1/companies/${companyId}/agents/${agentId}/model-bindings`)),
      listSessions: async (companyId: string, agentId: string) =>
        z
          .array(AgentSessionSchema)
          .parse(await get(`/api/v1/companies/${companyId}/agents/${agentId}/sessions`)),
    },
  };
}

export type AcosClient = ReturnType<typeof createAcosClient>;
