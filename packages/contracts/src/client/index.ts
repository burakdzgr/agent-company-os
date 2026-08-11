// Typed client SDK (21 §6) — generated from the same Zod source, NOT from an
// OpenAPI round-trip. apps/web consumes ONLY this client + @acos/ui.
// Namespaces grow with the endpoint catalog (tasks, agents, … in T16+).
import { HealthResponseSchema, type HealthResponse } from "../health.js";
import { ProblemJsonSchema, type ProblemJson } from "../errors.js";

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
  /** X-Company-Id for company-scoped calls (21 §2.3). */
  companyId?: string;
  fetch?: typeof fetch;
}

export interface AcosClient {
  health: { get(): Promise<HealthResponse> };
}

export function createAcosClient(options: AcosClientOptions): AcosClient {
  const fetchImpl = options.fetch ?? fetch;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.companyId) headers["x-company-id"] = options.companyId;

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

  return {
    health: {
      async get() {
        return HealthResponseSchema.parse(await request("GET", "/api/health"));
      },
    },
  };
}
