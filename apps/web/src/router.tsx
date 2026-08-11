// Route tree (24 §2): /login, /setup, / (company select), /c/$companyId
// layout with organization + agents views. Remaining views land with their
// tasks (tasks T27, office T26, …).
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { AcosApiError } from "@acos/contracts/client";
import { api } from "./lib/api.js";
import { AppShell } from "./shell/AppShell.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { SetupPage } from "./features/auth/SetupPage.js";
import { CompanySelectPage } from "./features/home/CompanySelectPage.js";
import { OrganizationView } from "./features/organization/OrganizationView.js";
import { AgentsView } from "./features/agents/AgentsView.js";
import { AgentDetailView } from "./features/agents/AgentDetailView.js";
import { EventsView } from "./features/events/EventsView.js";

const rootRoute = createRootRoute();

async function requireAuth() {
  try {
    await api.auth.me();
  } catch (err) {
    if (err instanceof AcosApiError && err.problem.code === "unauthenticated") {
      throw redirect({ to: "/login" });
    }
    throw err;
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireAuth,
  component: CompanySelectPage,
});

const companyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$companyId",
  beforeLoad: requireAuth,
  component: AppShell,
});

const companyIndexRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/c/$companyId/agents", params });
  },
});

const organizationRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "organization",
  component: OrganizationView,
});

const agentsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "agents",
  component: AgentsView,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "agents/$agentId",
  component: AgentDetailView,
});

const eventsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "events",
  component: EventsView,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  indexRoute,
  companyRoute.addChildren([
    companyIndexRoute,
    organizationRoute,
    agentsRoute,
    agentDetailRoute,
    eventsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
