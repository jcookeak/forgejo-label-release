export type BumpKind = "major" | "minor" | "patch";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
}

export interface Inputs {
  token: string;
  serverUrl: string;
  owner: string;
  repo: string;
  targetCommitish: string;
  majorLabels: string[];
  minorLabels: string[];
  patchLabels: string[];
  tagPrefix: string;
  releaseTemplatePath: string;
  draft: boolean;
  prerelease: boolean;
  dryRun: boolean;
}

export interface PullRequestRef {
  number: number;
  title: string;
  author: string;
  labels: string[];
  url: string;
  mergeCommitSha: string;
}

export interface ReleaseRef {
  id: number;
  tagName: string;
  targetCommitish: string;
}

export interface TemplateCategory {
  title: string;
  labels: string[];
  exclude?: { labels?: string[]; authors?: string[] };
}

export interface ReleaseTemplate {
  categories: TemplateCategory[];
  exclude?: { labels?: string[]; authors?: string[] };
}
