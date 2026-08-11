export const packageName = "@acos/contracts" as const;

export {
  ERROR_CODES,
  ProblemJsonSchema,
  PROBLEM_TYPE_BASE,
  problemFor,
  type ErrorCode,
  type ProblemJson,
} from "./errors.js";
export {
  HealthResponseSchema,
  DependencyStatusSchema,
  type HealthResponse,
  type DependencyStatus,
} from "./health.js";
export {
  SessionUserSchema,
  SetupStatusSchema,
  SetupRequestSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  TotpRequiredResponseSchema,
  PatCreateRequestSchema,
  PatCreatedSchema,
  PatListItemSchema,
  TotpEnableRequestSchema,
  TotpEnableResponseSchema,
  TotpConfirmRequestSchema,
  TotpDisableRequestSchema,
  OkSchema,
  type SessionUser,
} from "./auth.js";
export {
  CompanySchema,
  CreateCompanyRequestSchema,
  CompanySettingsSchema,
  UpdateCompanySettingsRequestSchema,
  type Company,
  type CompanySettings,
} from "./companies.js";
export {
  UnitKindSchema,
  EdgeKindSchema,
  OrgUnitSchema,
  CreateOrgUnitRequestSchema,
  MoveOrgUnitRequestSchema,
  PositionSchema,
  CreatePositionRequestSchema,
  OrgEdgeSchema,
  CreateOrgEdgeRequestSchema,
  EscalationChainSchema,
  TeamRosterEntrySchema,
  type OrgUnit,
  type Position,
  type OrgEdge,
  type EscalationChain,
} from "./org.js";
export {
  AgentSchema,
  AgentStatusSchema,
  SenioritySchema,
  BindingPurposeSchema,
  HireAgentRequestSchema,
  UpdateAgentRequestSchema,
  LifecycleActionRequestSchema,
  ModelBindingSchema,
  SetModelBindingRequestSchema,
  AgentSessionSchema,
  type Agent,
  type ModelBinding,
} from "./agents.js";
