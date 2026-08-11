// Auth + routing unit tests — the Docker layer is faked so these run
// anywhere (no daemon). The Docker-gated round-trip lives in the integration
// suite (test/integration).
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { DockerSandbox } from "./docker.js";
import type { Workspace } from "@acos/contracts";

const TOKEN = "internal-token-0123456789";

const workspace: Workspace = {
  workspaceId: "018f0000-0000-7000-8000-000000000001",
  containerId: "deadbeef",
  isolation: "coding",
  status: "running",
  createdAt: "2026-08-11T00:00:00.000Z",
};

const fakeSandbox = {
  createWorkspace: async () => workspace,
  list: async () => [workspace],
  exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 5, timedOut: false }),
  destroyWorkspace: async () => {},
  newTerminalSession: () => ({}) as never,
} as unknown as DockerSandbox;

let app: FastifyInstance;
const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  app = buildApp({ sandbox: fakeSandbox, internalApiToken: TOKEN, logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("sandbox-manager API auth (18 §2)", () => {
  it("serves /healthz without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: "sandbox-manager" });
  });

  it("rejects every internal route without the bearer (401)", async () => {
    expect((await app.inject({ method: "GET", url: "/internal/v1/workspaces" })).statusCode).toBe(401);
    const wrong = await app.inject({
      method: "GET",
      url: "/internal/v1/workspaces",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);
  });
});

describe("sandbox-manager routes", () => {
  it("creates a workspace (201) from a valid request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/workspaces",
      headers: auth,
      payload: { workspaceId: workspace.workspaceId, isolation: "coding" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ workspaceId: workspace.workspaceId, status: "running" });
  });

  it("rejects a malformed create (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/workspaces",
      headers: auth,
      payload: { workspaceId: "not-a-uuid", isolation: "coding" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("buffered exec returns the result inline (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/v1/workspaces/${workspace.workspaceId}/exec`,
      headers: auth,
      payload: { command: ["echo", "ok"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exitCode: 0, stdout: "ok\n", timedOut: false });
  });

  it("streaming exec acks 202 with the sessionId", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/v1/workspaces/${workspace.workspaceId}/exec`,
      headers: auth,
      payload: { command: ["sh"], sessionId: "018f0000-0000-7000-8000-0000000000ff" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ streaming: true });
  });

  it("destroy returns 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/internal/v1/workspaces/${workspace.workspaceId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });
});
