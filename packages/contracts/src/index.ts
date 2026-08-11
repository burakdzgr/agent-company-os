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
