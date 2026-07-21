const BASE_COMPONENTS = [
  "Text",
  "Markdown",
  "Card",
  "Button",
  "Input",
  "Form",
  "Column",
] as const;

const PLATFORM_EXTENSIONS = [
  "ToolCall",
  "Plan",
  "Attachment",
  "Progress",
  "Status",
  "Table",
] as const;

const ALL_COMPONENTS = new Set<string>([...BASE_COMPONENTS, ...PLATFORM_EXTENSIONS]);

const CATALOG_ID = "person-agent/v1" as const;

export class A2uiCatalog {
  isAllowed(type: string): boolean {
    return ALL_COMPONENTS.has(type);
  }

  getCatalogId(): string {
    return CATALOG_ID;
  }

  listComponents(): string[] {
    return [...ALL_COMPONENTS].sort();
  }
}
