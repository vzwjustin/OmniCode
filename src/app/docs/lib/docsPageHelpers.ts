import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";
import { autoAllSlugs, autoNavSections } from "./docs-auto-generated";
import { docsNavigation } from "./docsNavigation";

export function getDocItemBySlug(slug: string) {
  for (const section of docsNavigation) {
    const item = section.items.find((item) => item.slug === slug);
    if (item) {
      return { sectionTitle: section.title, item };
    }
  }
  for (const section of autoNavSections) {
    const item = section.items.find((i) => i.slug === slug);
    if (item) {
      return {
        sectionTitle: section.title,
        item: { slug: item.slug, title: item.title, fileName: item.fileName },
      };
    }
  }
  return null;
}

export function getAllDocSlugsFlat(): string[] {
  return autoAllSlugs;
}

export function getPrevNextSlugs(currentSlug: string) {
  const allSlugs = getAllDocSlugsFlat();
  const idx = allSlugs.indexOf(currentSlug);
  return {
    prev: idx > 0 ? allSlugs[idx - 1] : null,
    next: idx < allSlugs.length - 1 ? allSlugs[idx + 1] : null,
  };
}

export function extractHeadings(content: string): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = [];
  const regex = /^(#{2,4})\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "");
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");
    headings.push({ id, text, level });
  }
  return headings;
}

export function extractMermaidCharts(content: string): string[] {
  const charts: string[] = [];
  const regex = /```mermaid\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    charts.push(match[1].trim());
  }
  return charts;
}

const PROSE_CLASSES: Record<string, string> = {
  h1: "text-3xl font-bold mb-4",
  h2: "text-2xl font-bold mb-4 mt-10",
  h3: "text-xl font-bold mb-3 mt-8",
  h4: "text-lg font-bold mb-2 mt-6",
  p: "mb-4 leading-relaxed",
  ul: "list-disc ml-6 mb-4",
  ol: "list-decimal ml-6 mb-4",
  li: "mb-1",
  a: "text-primary hover:underline",
  blockquote: "border-l-4 border-primary/30 pl-4 italic text-text-muted mb-4",
  code: "bg-bg-subtle px-2 py-1 rounded text-sm",
  pre: "bg-bg-subtle p-4 rounded-lg overflow-x-auto mb-4",
  hr: "border-border my-8",
  table: "w-full border-collapse mb-4 text-sm",
  th: "border border-border p-2 text-left font-semibold bg-bg-subtle",
  td: "border border-border p-2 text-sm",
  img: "max-w-full rounded-lg my-4",
};

marked.use({
  gfm: true,
  breaks: false,
});

export function renderMarkdown(content: string): string {
  const mermaidReplaced = content.replace(
    /```mermaid\n([\s\S]*?)```/g,
    (_match, code: string) =>
      `<div class="mermaid-diagram-fallback my-6" data-mermaid="${encodeURIComponent(code.trim())}">${code.trim()}</div>`
  );

  const rawHtml = marked.parse(mermaidReplaced) as string;

  const sanitized = DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ["mermaid-diagram"],
    ADD_ATTR: ["data-mermaid"],
  });

  return addProseClasses(sanitized);
}

function addProseClasses(html: string): string {
  let result = html;
  for (const [tag, classes] of Object.entries(PROSE_CLASSES)) {
    const regex = new RegExp(`<${tag}(\\s|>)`, "g");
    result = result.replace(regex, `<${tag} class="${classes}"`);
  }
  return result;
}
