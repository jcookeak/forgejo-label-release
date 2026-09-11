import type { PullRequestRef, ReleaseRef } from "./types.ts";

export interface ForgejoClient {
  listTags(): Promise<string[]>;
  getLatestRelease(): Promise<ReleaseRef | null>;
  compareCommits(base: string, head: string): Promise<{ sha: string; message: string }[]>;
  getPullRequest(number: number): Promise<PullRequestRef>;
  /** Merged PRs in descending merge-time order, across all pages. */
  listMergedPullRequests(): Promise<PullRequestRef[]>;
  createRelease(input: CreateReleaseInput): Promise<ReleaseRef>;
}

export interface CreateReleaseInput {
  tagName: string;
  targetCommitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

interface HttpClient {
  request(method: string, path: string, body?: unknown): Promise<Response>;
}

export class HttpForgejoClient implements ForgejoClient {
  constructor(
    private readonly http: HttpClient,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  private path(p: string): string {
    return `/api/v1/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${p}`;
  }

  async listTags(): Promise<string[]> {
    const tags: string[] = [];
    let page = 1;
    for (;;) {
      const res = await this.http.request("GET", this.path(`/tags?page=${page}&limit=50`));
      await assertOk(res, "list tags");
      const batch = (await res.json()) as { name: string }[];
      if (batch.length === 0) break;
      for (const t of batch) tags.push(t.name);
      if (batch.length < 50) break;
      page++;
    }
    return tags;
  }

  async getLatestRelease(): Promise<ReleaseRef | null> {
    const res = await this.http.request("GET", this.path(`/releases/latest`));
    if (res.status === 404) return null;
    await assertOk(res, "get latest release");
    const r = (await res.json()) as { id: number; tag_name: string; target_commitish: string };
    return { id: r.id, tagName: r.tag_name, targetCommitish: r.target_commitish };
  }

  async compareCommits(base: string, head: string): Promise<{ sha: string; message: string }[]> {
    const res = await this.http.request(
      "GET",
      this.path(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`),
    );
    await assertOk(res, "compare commits");
    const data = (await res.json()) as { commits?: { sha: string; commit: { message: string } }[] };
    return (data.commits ?? []).map((c) => ({ sha: c.sha, message: c.commit.message }));
  }

  async getPullRequest(number: number): Promise<PullRequestRef> {
    const res = await this.http.request("GET", this.path(`/pulls/${number}`));
    await assertOk(res, `get PR #${number}`);
    const pr = (await res.json()) as {
      number: number;
      title: string;
      html_url: string;
      user: { login: string } | null;
      labels: { name: string }[];
      merge_commit_sha: string | null;
    };
    return {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "",
      labels: pr.labels.map((l) => l.name),
      url: pr.html_url,
      mergeCommitSha: pr.merge_commit_sha ?? "",
    };
  }

  async listMergedPullRequests(): Promise<PullRequestRef[]> {
    const out: { pr: PullRequestRef; mergedAt: number }[] = [];
    let page = 1;
    for (;;) {
      const res = await this.http.request(
        "GET",
        this.path(`/pulls?state=closed&sort=newest&page=${page}&limit=50`),
      );
      await assertOk(res, "list pulls");
      const batch = (await res.json()) as {
        number: number;
        title: string;
        html_url: string;
        user: { login: string } | null;
        labels: { name: string }[];
        merge_commit_sha: string | null;
        merged: boolean;
        merged_at: string | null;
      }[];
      if (batch.length === 0) break;
      for (const pr of batch) {
        if (!pr.merged) continue;
        const mergedAt = pr.merged_at === null ? NaN : Date.parse(pr.merged_at);
        if (!Number.isFinite(mergedAt)) {
          throw new Error(`Merged PR #${pr.number} has no valid merge timestamp`);
        }
        out.push({
          mergedAt,
          pr: {
            number: pr.number,
            title: pr.title,
            author: pr.user?.login ?? "",
            labels: pr.labels.map((l) => l.name),
            url: pr.html_url,
            mergeCommitSha: pr.merge_commit_sha ?? "",
          },
        });
      }
      if (batch.length < 50) break;
      page++;
    }
    // sort=newest orders by creation time. An old PR can merge after a newer
    // release baseline, including when it appears on a later API page.
    return out.sort((a, b) => b.mergedAt - a.mergedAt).map(({ pr }) => pr);
  }

  async createRelease(input: CreateReleaseInput): Promise<ReleaseRef> {
    const res = await this.http.request("POST", this.path(`/releases`), {
      tag_name: input.tagName,
      target_commitish: input.targetCommitish,
      name: input.name,
      body: input.body,
      draft: input.draft,
      prerelease: input.prerelease,
    });
    await assertOk(res, "create release");
    const r = (await res.json()) as { id: number; tag_name: string; target_commitish: string };
    return { id: r.id, tagName: r.tag_name, targetCommitish: r.target_commitish };
  }
}

export class ForgejoApiError extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`Forgejo API ${what} failed: ${status} ${statusText} ${body}`);
    this.name = "ForgejoApiError";
  }
}

async function assertOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  throw new ForgejoApiError(what, res.status, res.statusText, text);
}

export class FetchHttp implements HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `token ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
