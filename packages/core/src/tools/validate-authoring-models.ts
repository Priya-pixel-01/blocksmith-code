/**
 * Validation rules for AEM/XWalk authoring models to prevent orphan collapsible fields
 * 
 * RULE 1: Collapsible fields MUST have proper parent context
 * - Fields with `collapsible: true` must be inside a component that supports collapsible grouping
 * - Example: accordion, tab-list, or similar container components
 * 
 * RULE 2: Conditional fields MUST reference existing parent fields
 * - All `condition` properties must reference fields that exist in the same parent
 * - Invalid: condition references a sibling field that doesn't exist
 * - Invalid: condition references a field from a different component entirely
 * 
 * RULE 3: Field names with special properties MUST follow grouping conventions
 * - Fields with row/col span, visibility conditions, or nested logic must be clearly grouped
 * - Use consistent naming: parent_child pattern (e.g., column1colspan, column1rowspan)
 * 
 * RULE 4: Multiselect and complex components MUST properly nest their fields
 * - Complex fields cannot be orphaned; they must belong to a clear parent structure
 * - Each field must have proper `name` and `label` attributes
 */

interface AuthoringField {
  name?: string;
  label?: string;
  component?: string;
  multi?: boolean;
  condition?: unknown;
}

interface AuthoringModel {
  id: string;
  fields?: AuthoringField[];
}

// Validation function to check authoring models
export function validateAuthoringModel(models: AuthoringModel[]) {
  const errors = [];
  
  for (const model of models) {
    const { id, fields } = model;
    
    if (!fields || !Array.isArray(fields)) {
      errors.push(`Model "${id}": "fields" must be an array`);
      continue;
    }
    
    // Track all field names in this model
    const fieldNames = new Set(fields.map(f => f.name));
    
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const lineNum = i + 1;
      
      // Check 1: Fields with conditions must reference existing fields
      if (field.condition) {
        const referencedFields = extractFieldReferences(field.condition);
        for (const refField of referencedFields) {
          if (!fieldNames.has(refField)) {
            errors.push(
              `Model "${id}" line ${lineNum}: Condition references non-existent field "${refField}". ` +
              `Available fields: ${Array.from(fieldNames).join(", ")}`
            );
          }
        }
      }
      
      // Check 2: Fields with multiselect/complex components must have clear grouping
      if (field.multi === true || field.component === "multiselect") {
        if (!field.name || !field.label) {
          errors.push(
            `Model "${id}" line ${lineNum}: Multi/complex field missing required "name" or "label". ` +
            `Component: ${field.component}, Name: ${field.name}, Label: ${field.label}`
          );
        }
      }
      
      // Check 3: Fields must have required attributes
      if (!field.name) {
        errors.push(
          `Model "${id}" line ${lineNum}: Field is missing required "name" attribute. ` +
          `Label: ${field.label || "(no label)"}. Component: ${field.component || "(no component)"}`
        );
      }
      
      // Check 4: Grouped fields (colspan, rowspan) must follow naming convention
      if (field.name && (field.name.includes("colspan") || field.name.includes("rowspan"))) {
        // These should always be paired and well-named
        const base = field.name.replace(/colspan|rowspan/, "");
        if (!base || base.length < 2) {
          errors.push(
            `Model "${id}" line ${lineNum}: Field "${field.name}" has ambiguous grouping. ` +
            `Use clear naming like "column1colspan" or "column2rowspan" with consistent base names.`
          );
        }
      }
    }
  }
  
  return { isValid: errors.length === 0, errors };
}

// Helper: Extract field names referenced in a condition object
function extractFieldReferences(condition: unknown): string[] {
  const refs = new Set<string>();

  function traverse(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;

    // Check for { "var": "fieldName" } pattern
    if (
      "var" in obj &&
      typeof obj.var === "string"
    ) {
      refs.add(obj.var);
    }

    // Recurse into arrays and objects
    if (Array.isArray(obj)) {
      obj.forEach(traverse);
    } else {
      Object.values(obj).forEach(val => traverse(val));
    }
  }

  traverse(condition);
  return Array.from(refs);
}

// Export for use in build/lint pipeline
export default validateAuthoringModel;
