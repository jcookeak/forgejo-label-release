import { parse as parseYaml } from "yaml";
import type { PullRequestRef, ReleaseTemplate, TemplateCategory } from "./types.ts";

const WILDCARD = "*";

export function parseTemplate(source: string): ReleaseTemplate {
  const raw = parseYaml(source) as
    | { changelog?: { exclude?: Excludes; categories?: RawCategory[] } }
    | null
    | undefined;
  const cl = raw?.changelog;
  if (!cl) return { categories: [] };
  const categories = (cl.categories ?? []).map(normalizeCategory);
  return {
    categories,
    exclude: normalizeExcludes(cl.exclude),
  };
}

interface RawCategory {
  title?: string;
  labels?: string[];
  exclude?: Excludes;
}
interface Excludes {
  labels?: string[];
  authors?: string[];
}

function normalizeCategory(c: RawCategory): TemplateCategory {
  return {
    title: c.title ?? "Other",
    labels: c.labels ?? [],
    exclude: normalizeExcludes(c.exclude),
  };
}

function normalizeExcludes(e: Excludes | undefined): TemplateCategory["exclude"] {
  if (!e) return undefined;
  return { labels: e.labels ?? [], authors: e.authors ?? [] };
}

export function renderNotes(
  prs: PullRequestRef[],
  template: ReleaseTemplate | null,
  opts: { previousTag: string | null; newTag: string; compareUrl?: string },
): string {
  const included = prs.filter((pr) => !isExcluded(pr, template?.exclude));

  const sections: string[] = [];
  if (!template || template.categories.length === 0) {
    sections.push(bulletsFor(included));
  } else {
    const used = new Set<number>();
    for (const cat of template.categories) {
      const matched = included.filter((pr) => !used.has(pr.number) && categoryMatches(pr, cat));
      for (const pr of matched) used.add(pr.number);
      if (matched.length === 0) continue;
      sections.push(`### ${cat.title}\n\n${bulletsFor(matched)}`);
    }
    const wildcard = template.categories.find((c) => c.labels.includes(WILDCARD));
    if (!wildcard) {
      const leftover = included.filter((pr) => !used.has(pr.number));
      if (leftover.length > 0) {
        sections.push(`### Other Changes\n\n${bulletsFor(leftover)}`);
      }
    }
  }

  let body = sections.filter((s) => s.length > 0).join("\n\n");
  if (included.length === 0) body = "_No user-visible changes._";
  if (opts.compareUrl && opts.previousTag) {
    body += `\n\n**Full Changelog**: ${opts.compareUrl}`;
  }
  return body.trim();
}

function categoryMatches(pr: PullRequestRef, cat: TemplateCategory): boolean {
  if (cat.exclude && isExcluded(pr, cat.exclude)) return false;
  if (cat.labels.includes(WILDCARD)) return true;
  const prLabels = new Set(pr.labels.map((l) => l.toLowerCase()));
  return cat.labels.some((l) => prLabels.has(l.toLowerCase()));
}

function isExcluded(pr: PullRequestRef, exclude: TemplateCategory["exclude"]): boolean {
  if (!exclude) return false;
  const prLabels = new Set(pr.labels.map((l) => l.toLowerCase()));
  if (exclude.labels?.some((l) => prLabels.has(l.toLowerCase()))) return true;
  if (exclude.authors?.some((a) => a.toLowerCase() === pr.author.toLowerCase())) return true;
  return false;
}

function bulletsFor(prs: PullRequestRef[]): string {
  return prs.map((pr) => `* ${pr.title} by @${pr.author} in #${pr.number}`).join("\n");
}
