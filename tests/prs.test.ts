import { describe, expect, it, vi } from "vitest";
import { findMergedPrs } from "../src/prs.ts";
import { HttpForgejoClient, type ForgejoClient } from "../src/forgejo.ts";

const sha = "a".repeat(40);
const apiPr = {
  number: 42,
  title: "Custom merge",
  html_url: "https://forgejo/42",
  user: { login: "alice" },
  labels: [{ name: "bug" }],
  merge_commit_sha: sha,
  merged: true,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function httpClient(responses: (Response | Error)[]) {
  const request = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("unexpected request");
    return response;
  });
  return { client: new HttpForgejoClient({ request }, "base-owner", "repo"), request };
}

describe("exact commit-to-PR attribution", () => {
  it("maps one object from the base repository with a full SHA", async () => {
    const { client, request } = httpClient([json(apiPr)]);
    expect(await client.getCommitPullRequest(sha)).toEqual({
      number: 42,
      title: "Custom merge",
      url: "https://forgejo/42",
      author: "alice",
      labels: ["bug"],
      mergeCommitSha: sha,
    });
    expect(request).toHaveBeenCalledWith(
      "GET",
      `/api/v1/repos/base-owner/repo/commits/${sha}/pull`,
    );
  });
  it("accepts 404 only when the exact commit remains readable", async () => {
    const { client, request } = httpClient([json({}, 404), json({ sha })]);
    expect(await client.getCommitPullRequest(sha)).toBeNull();
    expect(request).toHaveBeenLastCalledWith(
      "GET",
      `/api/v1/repos/base-owner/repo/git/commits/${sha}`,
    );
  });
  it("rejects a mismatched commit-read response after an ambiguous 404", async () => {
    const { client } = httpClient([json({}, 404), json({ sha: "b".repeat(40) })]);
    await expect(client.getCommitPullRequest(sha)).rejects.toThrow(
      "Cannot verify unmatched commit",
    );
  });
  it.each([401, 403, 404, 500])(
    "propagates inaccessible commit/repository status %s",
    async (status) => {
      const { client } = httpClient([json({}, 404), json({}, status)]);
      await expect(client.getCommitPullRequest(sha)).rejects.toThrow(`failed: ${status}`);
    },
  );
  it.each([401, 403, 500])("propagates lookup status %s without fallback", async (status) => {
    const { client, request } = httpClient([json({}, status)]);
    await expect(client.getCommitPullRequest(sha)).rejects.toThrow(`failed: ${status}`);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("propagates network errors", async () => {
    const { client } = httpClient([new Error("connection lost")]);
    await expect(client.getCommitPullRequest(sha)).rejects.toThrow("connection lost");
  });
  it.each(["main", "abcdef", "--all"])("rejects non-full SHA %s", async (ref) => {
    const { client, request } = httpClient([]);
    await expect(client.getCommitPullRequest(ref)).rejects.toThrow("full commit SHA");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{ ...apiPr, merged: false }, { ...apiPr, merge_commit_sha: "b".repeat(40) }, [apiPr]])(
    "rejects a malformed or non-exact association",
    async (body) => {
      const { client } = httpClient([json(body)]);
      await expect(client.getCommitPullRequest(sha)).rejects.toThrow(
        "Invalid commit-to-PR response",
      );
    },
  );
  it("requires Forgejo 17 and repository access before discovery", async () => {
    const { client, request } = httpClient([
      json({ version: "17.0.1+gitea-1.22.0" }),
      json({ permissions: { pull: true } }),
    ]);
    await client.requireCommitPullLookup();
    expect(request.mock.calls).toEqual([
      ["GET", "/api/forgejo/v1/version"],
      ["GET", "/api/v1/repos/base-owner/repo"],
    ]);
  });
  it.each(["16.0.0", "unknown", "1.22.0"])("rejects unsupported version %s", async (version) => {
    const { client } = httpClient([json({ version })]);
    await expect(client.requireCommitPullLookup()).rejects.toThrow("Forgejo 17 or newer");
  });
  it.each([401, 403, 404, 500])("propagates version endpoint status %s", async (status) => {
    const { client } = httpClient([json({}, status)]);
    await expect(client.requireCommitPullLookup()).rejects.toThrow(`failed: ${status}`);
  });
  it("rejects a hidden repository before any commit lookup", async () => {
    const { client } = httpClient([json({ version: "17.0.0" }), json({}, 404)]);
    await expect(client.requireCommitPullLookup()).rejects.toThrow(
      "check release repository access failed: 404",
    );
  });
});

describe("baseline discovery", () => {
  it("deduplicates associations and ignores ordinary commits across a large range", async () => {
    const commits = Array.from({ length: 125 }, (_, n) => n.toString(16).padStart(40, "0"));
    const getCommitPullRequest = vi.fn(async (sha: string) =>
      sha === commits[50]
        ? null
        : {
            number: 42,
            title: "One PR",
            author: "alice",
            labels: ["bug"],
            url: "",
            mergeCommitSha: sha,
          },
    );
    const requireCommitPullLookup = vi.fn(async () => {});
    const client = { getCommitPullRequest, requireCommitPullLookup } as unknown as ForgejoClient;
    expect((await findMergedPrs(client, commits)).map((pr) => pr.number)).toEqual([42]);
    expect(getCommitPullRequest.mock.calls.map(([sha]) => sha)).toEqual(commits);
    expect(requireCommitPullLookup).toHaveBeenCalledOnce();
  });
  it("checks compatibility even for an empty range", async () => {
    const { client } = httpClient([json({}, 404)]);
    await expect(findMergedPrs(client, [])).rejects.toThrow("lookup support failed: 404");
  });
});
