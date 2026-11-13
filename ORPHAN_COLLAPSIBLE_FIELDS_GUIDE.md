# Orphan Collapsible Fields: Prevention & Resolution Guide

## Problem Statement

**xwalk/no-orphan-collapsible-fields** error occurs when Universal Editor field definitions violate Adobe AEM's field collapse rules. This is a **critical linting error** that blocks all builds.

```
Error: Avoid using orphan collapsible field names  xwalk/no-orphan-collapsible-fields
```

## Root Cause

Adobe Edge Delivery Services uses **field collapse** to combine multiple authored values into a single semantic HTML element. This is managed through reserved suffixes.

When a field name ends with a reserved suffix but its corresponding base field is missing, the field becomes "orphaned" — it has no parent to collapse into.

## The Five Reserved Suffixes

These suffixes have special meaning in AEM and can ONLY be used with a matching base field:

| Suffix | Purpose | Example |
|--------|---------|---------|
| `Alt` | Alternative text for images | `image` + `imageAlt` → `<img alt="...">` |
| `Text` | Text content of links/headings | `button` + `buttonText` → button label |
| `Title` | Tooltip/title attribute | `link` + `linkTitle` → `title="..."` |
| `Type` | Semantic type (heading level, button style) | `heading` + `headingType` → `<h2>` vs `<h3>` |
| `MimeType` | MIME type for assets | `document` + `documentMimeType` → determine icon |

## Common Mistakes (WRONG ✗)

### 1. Suffix Without Base

```javascript
// ✗ WRONG — imageAlt orphaned, no image base field
ueFields: [
  { name: "imageAlt", label: "Image Alt Text", component: "text" }
]

// ✗ WRONG — buttonText orphaned, no button base field
ueFields: [
  { name: "buttonText", label: "Button Label", component: "text" },
  { name: "buttonLink", label: "Button URL", component: "text" }
]
```

### 2. Incomplete Pairing

```javascript
// ✗ WRONG — heading without headingType
ueFields: [
  { name: "heading", label: "Heading", component: "text" },
  { name: "headingType", label: "Level", component: "select", options: [...] }
  // headingType has no parent "heading"... wait, it does!
  // But if you only had headingType without heading, it's orphaned
]
```

### 3. Invalid Field Names

```javascript
// ✗ WRONG — field names don't follow xwalk rules
ueFields: [
  { name: "Button Text", label: "...", component: "text" },  // space not allowed
  { name: "123-button", label: "...", component: "text" },   // must start with letter
  { name: "button::type", label: "...", component: "text" }  // consecutive : not allowed
]
```

## Correct Patterns (RIGHT ✓)

### 1. Image with Alt Text

```javascript
// ✓ CORRECT
ueFields: [
  { name: "image", label: "Image", component: "reference" },
  { name: "imageAlt", label: "Alt Text", component: "text" }
]
// Renders as: <img src="..." alt="...">
```

### 2. Button with Text, Title, and Type

```javascript
// ✓ CORRECT — all suffixes paired with base
ueFields: [
  { name: "button", label: "Button Link", component: "aem-content" },
  { name: "buttonText", label: "Button Label", component: "text" },
  { name: "buttonTitle", label: "Button Tooltip", component: "text" },
  { name: "buttonType", label: "Style", component: "select", options: [...] }
]
// Renders as: <a href="..." title="...">TEXT</a> with CSS class for buttonType
```

### 3. Heading with Type Selector

```javascript
// ✓ CORRECT
ueFields: [
  { name: "heading", label: "Heading Text", component: "text" },
  { name: "headingType", label: "Heading Level", component: "select", options: [
    { name: "H1", value: "h1" },
    { name: "H2", value: "h2" },
    { name: "H3", value: "h3" }
  ] }
]
// Renders as: <h1>TEXT</h1> or <h2>TEXT</h2> depending on headingType value
```

### 4. Link with Complete Metadata

```javascript
// ✓ CORRECT — comprehensive link field
ueFields: [
  { name: "link", label: "Link URL", component: "aem-content" },
  { name: "linkText", label: "Link Text", component: "text" },
  { name: "linkTitle", label: "Tooltip", component: "text" },
  { name: "linkType", label: "Style", component: "select", options: [...] }
]
// Renders as: <a href="..." title="...">linkText</a> with class based on linkType
```

## Validation Rules

### Rule 1: Never Orphan a Suffix

Every field ending with a reserved suffix MUST have its base field present.

```javascript
// Check: For every field with suffix, base field exists
const baseField = fieldName.replace(/Alt|Text|Title|Type|MimeType$/, "");
if (!fieldsMap.has(baseField)) {
  throw new Error(`Orphaned suffix: ${fieldName} (missing base: ${baseField})`);
}
```

### Rule 2: Valid Field Names

```
Pattern: /^[a-zA-Z][a-zA-Z0-9_\-:]*$/

✓ Valid:     image, imageAlt, image-2, image:primary, image_v2
✗ Invalid:   123image (starts with digit)
✗ Invalid:   image-alt (space between words — use camelCase imageAlt)
✗ Invalid:   image--alt (consecutive dashes)
✗ Invalid:   image::alt (consecutive colons)
```

### Rule 3: No Duplicates

Each field name must be unique within the block.

```javascript
// ✗ WRONG
ueFields: [
  { name: "title", label: "Title", component: "text" },
  { name: "title", label: "Page Title", component: "text" }  // Duplicate!
]
```

### Rule 4: Keep Blocks ≤4 Fields

Universal Editor becomes unwieldy with too many fields. Use field collapse to reduce cell count.

```javascript
// ✗ WRONG — 8 separate fields
ueFields: [
  { name: "primaryHeading", ... },
  { name: "secondaryHeading", ... },
  { name: "primaryText", ... },
  { name: "secondaryText", ... },
  { name: "primaryButton", ... },
  { name: "primaryButtonText", ... },
  { name: "secondaryButton", ... },
  { name: "secondaryButtonText", ... }
]

// ✓ BETTER — collapse buttons to 4 fields
ueFields: [
  { name: "heading", ... },       // 1 field (includes level via headingType)
  { name: "text", ... },          // 1 field
  { name: "button", ... },        // 1 field
  { name: "buttonText", ... }     // suffix of button, doesn't count as separate cell
]
```

## How Blocksmith Enforces These Rules

### Stage 1: Interpreter (Design → BlockSpec)

The Interpreter analyzes your design and creates a BlockSpec with ueFields. **Validation happens here:**

```typescript
export async function interpretDesign(...) {
  const blockSpec = result.object;
  const validation = validateUEFields(blockSpec.ueFields);
  
  if (!validation.isValid) {
    throw new Error(`BlockSpec failed field validation:\n${validation.errors.join("\n")}`);
  }
  return { blockSpec, ... };
}
```

**What this means:** If the Interpreter generates an orphaned field, the entire job fails immediately with clear error message.

### Stage 2: Planner (Safety Check)

The Planner validates fields again before creating the human-reviewable Plan:

```typescript
export async function createPlan(...) {
  const fieldValidation = validateUEFields(blockSpec.ueFields);
  if (!fieldValidation.isValid) {
    throw new Error(`Plan validation failed: ${fieldValidation.errors}`);
  }
  // Plan is safe to present to human
}
```

### Stage 3: Builder (Final Enforcement)

The Builder passes validated fields to the LLM with explicit xwalk rules in the system prompt:

```
VALIDATION RULES (enforced by linter):
• xwalk/max-cells: Keep ≤4 cells
• xwalk/no-orphan-collapsible-fields: NEVER use suffix without base field
• xwalk/invalid-field-name: Start with letter, only letters/numbers/_/-/:
• xwalk/no-duplicate-fields: No duplicate field names
```

### Stage 4: Lint (Build-Time)

When the Builder writes the block's authoring model to `_<name>.json`, ESLint runs xwalk rules:

```bash
npm run lint
# ESLint plugin:xwalk/no-orphan-collapsible-fields
# If any field violates rules → BUILD FAILS
```

## How to Fix Existing Errors

### If you're seeing build failures:

1. **Identify the orphaned field** — look at the line number in the error
   ```
   455:11  error  Avoid using orphan collapsible field names  xwalk/no-orphan-collapsible-fields
   ```

2. **Find the field definition** in your models.json at line 455

3. **Determine the base field** — remove the suffix
   ```
   "imageAlt" → base should be "image"
   "buttonText" → base should be "button"
   ```

4. **Add the base field** to the same fields array (same block)
   ```javascript
   // Before (WRONG)
   "fields": [
     { "name": "imageAlt", "label": "Alt Text", "component": "text" }
   ]
   
   // After (RIGHT)
   "fields": [
     { "name": "image", "label": "Image", "component": "reference" },
     { "name": "imageAlt", "label": "Alt Text", "component": "text" }
   ]
   ```

5. **Rebuild** and verify lint passes
   ```bash
   npm run build
   ```

## Prevention Checklist

Before submitting a new block design:

- [ ] **Count suffixes** — For every field ending in Alt/Text/Title/Type/MimeType, its base field exists
- [ ] **Check field names** — All start with letter, contain only alphanumeric/_/-/:
- [ ] **No duplicates** — Each field name is unique
- [ ] **Cell count** — ≤4 fields total (suffixes don't add cells)
- [ ] **Semantic grouping** — Related suffix fields are grouped with their base
- [ ] **Test rendering** — Verify the collapsed HTML element matches design intent

## Common Questions

**Q: Can I have a field that looks like a suffix but isn't?**

A: No. If a field name ends with Alt/Text/Title/Type/MimeType, xwalk treats it as a suffix. There's no escaping or opt-out.

**Q: Why does collapsing matter?**

A: When an author edits a block in Universal Editor, each cell (field) becomes a separate UI element. Collapsing reduces visual complexity. Four fields with one expanded base + three suffixes is cleaner than four separate fields.

**Q: Can I use these suffixes in the middle of a name?**

A: No. xwalk only recognizes them at the END of the field name.
```
"buttonText" ✓ (suffix at end)
"textButton" ✗ (suffix in middle — treated as plain name, but confusing; use "button" or "secondaryButton")
```

**Q: What if I need both primary and secondary buttons?**

A: Use base names that distinguish them:
```javascript
ueFields: [
  { name: "primaryButton", component: "aem-content" },
  { name: "primaryButtonText", component: "text" },      // suffix of primaryButton
  { name: "secondaryButton", component: "aem-content" },
  { name: "secondaryButtonText", component: "text" }     // suffix of secondaryButton
]
```

## Resources

- [Adobe aem.live field collapse documentation](https://www.aem.live)
- [ESLint plugin:xwalk rules](https://github.com/adobe/eslint-plugin-xwalk)
- [Blocksmith field validation code](packages/core/src/schemas/field-validation.ts)
- [Blocksmith system prompts](packages/core/src/agents/)

---

**Last updated:** 2026-08-12  
**Severity:** CRITICAL — Blocks all builds  
**Enforcement:** Interpreter → Planner → Builder → ESLint xwalk
