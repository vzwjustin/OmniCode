import { notFound } from "next/navigation";
import Link from "next/link";
import { autoAllSlugs } from "../lib/docs-auto-generated";
import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { Metadata } from "next";
import { DocCodeBlocks } from "../components/DocCodeBlocks";
import { FeedbackWidget } from "../components/FeedbackWidget";
import { DocsPageAnalytics } from "../components/DocsPageAnalytics";
import { DocsLazyWrapper } from "../components/DocsLazyWrapper";
import { MermaidChartsClient } from "../components/MermaidChartsClient";
import {
  extractHeadings,
  extractMermaidCharts,
  getDocItemBySlug,
  getPrevNextSlugs,
  renderMarkdown,
} from "./docHelpers";

export function generateStaticParams() {
  return autoAllSlugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const docItem = getDocItemBySlug(slug);

  if (!docItem) {
    return {
      title: "Document Not Found",
    };
  }

  return {
    title: `${docItem.item.title} — OmniRoute Docs`,
    description: `OmniRoute documentation: ${docItem.item.title}`,
  };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const docItem = getDocItemBySlug(slug);

  if (!docItem) {
    notFound();
  }

  const { sectionTitle, item } = docItem;

  let pageTitle = item.title;
  let htmlContent = "";
  let headings: { id: string; text: string; level: number }[] = [];
  let loadError: string | null = null;
  let version: string | null = null;
  let lastUpdated: string | null = null;
  let mermaidCharts: string[] = [];

  try {
    const docsRoot = path.join(process.cwd(), "docs");
    const fileContent = fs.readFileSync(path.join(docsRoot, item.fileName), "utf8");
    const { content, data: frontmatter } = matter(fileContent);
    pageTitle = (frontmatter.title as string) || item.title;
    version = (frontmatter.version as string) || null;
    lastUpdated = (frontmatter.lastUpdated as string) || null;
    mermaidCharts = extractMermaidCharts(content);
    headings = extractHeadings(content);
    htmlContent = renderMarkdown(content);
  } catch (error) {
    console.error(`Failed to read doc file for slug: ${slug}`, error);
    loadError = error instanceof Error ? error.message : "Unknown error";
  }

  if (loadError) {
    return (
      <div className="text-red-500 p-4 border border-red-200 bg-red-50 rounded-lg">
        <h2 className="text-xl font-bold mb-2">Error Loading Documentation</h2>
        <p>Failed to load {item.fileName}. Please try again later.</p>
        <p className="text-sm mt-2 text-gray-600">Error: {loadError}</p>
      </div>
    );
  }

  const { prev, next } = getPrevNextSlugs(slug);
  const prevItem = prev ? getDocItemBySlug(prev) : null;
  const nextItem = next ? getDocItemBySlug(next) : null;

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Docs",
        item: `https://omniroute.online/docs`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: sectionTitle,
        item: `https://omniroute.online/docs/${slug}`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: pageTitle,
      },
    ],
  };

  return (
    <>
      <DocsPageAnalytics slug={slug} title={pageTitle} section={sectionTitle} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <div className="flex gap-8">
        <div className="flex-1 min-w-0">
          <nav className="mb-6" aria-label="Breadcrumb">
            <ol className="flex items-center gap-2 text-sm text-text-muted">
              <li>
                <Link href="/docs" className="hover:text-text-main">
                  Docs
                </Link>
              </li>
              <li className='before:content-["&gt;"] before:mx-2'>{sectionTitle}</li>
              <li className='before:content-["&gt;"] before:mx-2'>{pageTitle}</li>
            </ol>
          </nav>

          <div className="flex items-center gap-3 mb-6">
            <h1 className="text-3xl font-bold text-text-main">{pageTitle}</h1>
            {version && (
              <span className="px-2 py-0.5 text-xs font-mono bg-primary/10 text-primary border border-primary/20 rounded">
                v{version}
              </span>
            )}
          </div>

          {lastUpdated && (
            <p className="text-xs text-text-muted mb-4">Last updated: {lastUpdated}</p>
          )}

          <DocsLazyWrapper>
            <div className="prose-content" dangerouslySetInnerHTML={{ __html: htmlContent }} />
          </DocsLazyWrapper>

          {mermaidCharts.length > 0 && (
            <DocsLazyWrapper>
              <MermaidChartsClient charts={mermaidCharts} />
            </DocsLazyWrapper>
          )}

          <DocCodeBlocks />

          <FeedbackWidget slug={slug} />

          <div className="flex items-center justify-between border-t border-border pt-6 mt-12">
            {prevItem ? (
              <Link
                href={`/docs/${prev}`}
                className="flex items-center gap-2 text-sm text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-sm">arrow_back</span>
                {prevItem.item.title}
              </Link>
            ) : (
              <div />
            )}
            {nextItem ? (
              <Link
                href={`/docs/${next}`}
                className="flex items-center gap-2 text-sm text-text-muted hover:text-primary transition-colors"
              >
                {nextItem.item.title}
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </Link>
            ) : (
              <div />
            )}
          </div>
        </div>

        {headings.length > 0 && (
          <aside className="hidden xl:block w-56 shrink-0">
            <div className="sticky top-8">
              <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
                On this page
              </h4>
              <nav className="space-y-1">
                {headings.map((heading) => (
                  <a
                    key={heading.id}
                    href={`#${heading.id}`}
                    className={`block text-sm text-text-muted hover:text-primary transition-colors truncate
                    ${heading.level === 3 ? "pl-3" : ""}
                    ${heading.level === 4 ? "pl-6" : ""}`}
                  >
                    {heading.text}
                  </a>
                ))}
              </nav>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
