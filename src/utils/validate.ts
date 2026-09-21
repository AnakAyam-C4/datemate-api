import { AppError } from "./http/AppError";
import { STATUS } from "./http/statusCodes";

/**
 * Small hand-rolled validators.
 *
 * The request surface here is half a dozen endpoints with a handful of fields
 * each, so this stays dependency-free rather than pulling in a schema library.
 * Every failure is an `AppError`, so it lands in the existing ErrorController.
 */

const fail = (message: string): never => {
  throw new AppError(message, STATUS.BAD_REQUEST);
};

export const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`"${field}" must be a non-empty string`);
  }

  return (value as string).trim();
};

export const optionalString = (
  value: unknown,
  field: string,
): string | null => {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field);
};

export const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") fail(`"${field}" must be a boolean`);
  return value as boolean;
};

export const requireNumber = (
  value: unknown,
  field: string,
  bounds?: { min?: number; max?: number },
): number => {
  const parsed = typeof value === "string" ? Number(value) : value;

  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    fail(`"${field}" must be a number`);
  }

  const numeric = parsed as number;

  if (bounds?.min !== undefined && numeric < bounds.min) {
    fail(`"${field}" must be >= ${bounds.min}`);
  }

  if (bounds?.max !== undefined && numeric > bounds.max) {
    fail(`"${field}" must be <= ${bounds.max}`);
  }

  return numeric;
};

export const optionalNumber = (
  value: unknown,
  field: string,
  bounds?: { min?: number; max?: number },
): number | null => {
  if (value === undefined || value === null || value === "") return null;
  return requireNumber(value, field, bounds);
};

export const requireStringArray = (
  value: unknown,
  field: string,
  options?: { maxLength?: number; allowEmpty?: boolean },
): string[] => {
  if (!Array.isArray(value)) fail(`"${field}" must be an array of strings`);

  const items = value as unknown[];
  const maxLength = options?.maxLength ?? 50;

  if (items.length > maxLength) {
    fail(`"${field}" must contain at most ${maxLength} items`);
  }

  if (items.length === 0 && !options?.allowEmpty) {
    fail(`"${field}" must contain at least one item`);
  }

  return [
    ...new Set(
      items.map((item, index) => requireString(item, `${field}[${index}]`)),
    ),
  ];
};

export const optionalStringArray = (
  value: unknown,
  field: string,
  options?: { maxLength?: number },
): string[] => {
  if (value === undefined || value === null) return [];
  return requireStringArray(value, field, { ...options, allowEmpty: true });
};

export const optionalNumberArray = (
  value: unknown,
  field: string,
  bounds?: { min?: number; max?: number },
): number[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`"${field}" must be an array of numbers`);

  return [
    ...new Set(
      (value as unknown[]).map((item, index) =>
        requireNumber(item, `${field}[${index}]`, bounds),
      ),
    ),
  ];
};

/** ISO-8601 string or epoch milliseconds, in the future. */
export const requireFutureDate = (value: unknown, field: string): Date => {
  const parsed =
    typeof value === "number" ? new Date(value) : new Date(String(value));

  if (Number.isNaN(parsed.getTime())) {
    fail(`"${field}" must be an ISO-8601 date string or epoch milliseconds`);
  }

  if (parsed.getTime() <= Date.now()) {
    fail(`"${field}" must be in the future`);
  }

  return parsed;
};

/**
 * Express types a path/query value as possibly repeated. Route params here are
 * always single-valued, so collapse a repeated value to its first entry rather
 * than sprinkling casts through the controllers.
 */
const firstOf = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

export const pathParam = (value: unknown, field: string): string =>
  requireString(firstOf(value), field);

export const queryString = (value: unknown, field: string): string | null =>
  optionalString(firstOf(value), field);
