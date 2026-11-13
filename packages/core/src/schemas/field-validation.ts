/**
 * Field Validation Schema
 * Enforces xwalk/no-orphan-collapsible-fields rule and other AEM authoring constraints
 */

const RESERVED_SUFFIXES = ["Alt", "Text", "Title", "Type", "MimeType"];
const SUFFIX_REGEX = new RegExp(`(${RESERVED_SUFFIXES.join("|")})$`);

export interface FieldValidationError {
  fieldName: string;
  error: string;
  severity: "error" | "warning";
}

/**
 * RULE: Validate that all suffix fields have their base field present
 * 
 * Examples:
 * ✓ CORRECT: fields = ["image", "imageAlt"] → collapses to <img>
 * ✓ CORRECT: fields = ["button", "buttonText"] → collapses to <a>
 * ✗ WRONG: fields = ["buttonText", "buttonLink"] → orphans (missing "button")
 * ✗ WRONG: fields = ["imageAlt"] → orphan (missing "image")
 */
export function validateFieldCollapse(fields: Array<{ name: string; component?: string }>): FieldValidationError[] {
  const errors: FieldValidationError[] = [];
  const fieldNames = new Set(fields.map(f => f.name));
  
  for (const field of fields) {
    // Check if this field name is a suffix
    const match = field.name.match(SUFFIX_REGEX);
    if (match) {
      const suffix = match[0];
      const baseFieldName = field.name.slice(0, -suffix.length);
      
      if (!baseFieldName) {
        errors.push({
          fieldName: field.name,
          error: `Field "${field.name}" ends with reserved suffix "${suffix}" but has no base name. Use format: "<baseName>${suffix}" (e.g., "button${suffix}")`,
          severity: "error",
        });
        continue;
      }
      
      if (!fieldNames.has(baseFieldName)) {
        errors.push({
          fieldName: field.name,
          error: `Field "${field.name}" uses reserved suffix "${suffix}" but base field "${baseFieldName}" is missing. Add base field "${baseFieldName}" to the fields array.`,
          severity: "error",
        });
      }
    }
  }
  
  return errors;
}

/**
 * RULE: Validate field names follow xwalk naming conventions
 * - Must start with letter
 * - Only letters, numbers, _, -, : allowed
 * - No spaces, no consecutive _, :
 */
export function validateFieldNames(fields: Array<{ name: string }>): FieldValidationError[] {
  const errors: FieldValidationError[] = [];
  const VALID_NAME = /^[a-zA-Z][a-zA-Z0-9_\-:]*$/;
  
  for (const field of fields) {
    if (!VALID_NAME.test(field.name)) {
      errors.push({
        fieldName: field.name,
        error: `Invalid field name "${field.name}". Must start with letter, contain only letters/numbers/_/-/:, no spaces or consecutive _/:`,
        severity: "error",
      });
    }
  }
  
  return errors;
}

/**
 * RULE: No duplicate field names
 */
export function validateNoDuplicates(fields: Array<{ name: string }>): FieldValidationError[] {
  const errors: FieldValidationError[] = [];
  const seen = new Map<string, number>();
  
  for (const field of fields) {
    if (seen.has(field.name)) {
      errors.push({
        fieldName: field.name,
        error: `Duplicate field name "${field.name}". Field names must be unique within a block.`,
        severity: "error",
      });
    }
    seen.set(field.name, (seen.get(field.name) || 0) + 1);
  }
  
  return errors;
}

/**
 * RULE: Limit block complexity (xwalk/max-cells)
 * Blocks should have ≤4 cells to keep Universal Editor manageable
 */
export function validateMaxCells(fields: Array<{ name: string; component?: string }>): FieldValidationError[] {
  const errors: FieldValidationError[] = [];
  const MAX_CELLS = 4;
  
  if (fields.length > MAX_CELLS) {
    errors.push({
      fieldName: "(block)",
      error: `Block has ${fields.length} fields but xwalk/max-cells limit is ${MAX_CELLS}. Use field collapsing to reduce cell count. Collapsible fields don't count as separate cells if properly grouped.`,
      severity: "warning",
    });
  }
  
  return errors;
}

/**
 * Master validation function
 */
export function validateUEFields(fields: Array<{ name: string; component?: string }>): {
  isValid: boolean;
  errors: FieldValidationError[];
  summary: string;
} {
  const allErrors = [
    ...validateNoDuplicates(fields),
    ...validateFieldNames(fields),
    ...validateFieldCollapse(fields),
    ...validateMaxCells(fields),
  ];
  
  const isValid = allErrors.filter(e => e.severity === "error").length === 0;
  
  const summary = isValid
    ? `✓ Fields valid (${fields.length} fields, all naming/collapse rules passed)`
    : `✗ ${allErrors.filter(e => e.severity === "error").length} error(s), ${allErrors.filter(e => e.severity === "warning").length} warning(s)`;
  
  return {
    isValid,
    errors: allErrors,
    summary,
  };
}

export default validateUEFields;
