import { describe, expect, it } from "vitest";
import { publishExplicit } from "../src/publish.ts";
import type { ForgejoClient, ReleasePublisherClient, CreateReleaseInput } from "../src/forgejo.ts";
import type { ReleaseRef } from "../src/types.ts";
const input: CreateReleaseInput = {
  tagName: "v1.4.3",
  targetCommitish: "a".repeat(40),
  name: "v1.4.3",
  body: "Repair",
  draft: false,
  prerelease: false,
};
function fake() {
  const state: {
    release: ReleaseRef | null;
    tag: string | null;
    posts: number;
    fail: boolean;
    ambiguous: boolean;
  } = { release: null, tag: null, posts: 0, fail: false, ambiguous: false };
  const client: ForgejoClient & ReleasePublisherClient = {
    listTags: async () => {
      throw new Error("must not recalculate");
    },
    getLatestRelease: async () => {
      throw new Error("must not recalculate");
    },
    listMergedPullRequests: async () => {
      throw new Error("must not recalculate");
    },
    requireCommitPullLookup: async () => {
      throw new Error("must not recalculate");
    },
    getCommitPullRequest: async () => {
      throw new Error("must not recalculate");
    },
    getPullRequest: async () => {
      throw new Error("must not recalculate");
    },
    getTagCommit: async () => state.tag,
    getReleaseByTag: async () => state.release,
    createRelease: async (input) => {
      state.posts++;
      if (state.fail && !state.ambiguous) throw new Error("network failure");
      state.tag = input.targetCommitish;
      state.release = {
        id: 1,
        tagName: input.tagName,
        targetCommitish: input.targetCommitish,
        body: input.body,
        draft: input.draft,
        prerelease: input.prerelease,
      };
      if (state.fail) throw new Error("response lost");
      return state.release;
    },
  };
  return { state, client };
}

describe("explicit publication", () => {
  it("publishes and retries supplied values without rediscovery", async () => {
    const { client, state } = fake();
    await publishExplicit(client, input);
    await publishExplicit(client, input);
    expect(state.posts).toBe(1);
  });
  it("reconciles a lost successful create response", async () => {
    const { client, state } = fake();
    state.fail = true;
    state.ambiguous = true;
    await publishExplicit(client, input);
    expect(state.posts).toBe(1);
  });
  it("leaves a genuine failure retryable", async () => {
    const { client, state } = fake();
    state.fail = true;
    await expect(publishExplicit(client, input)).rejects.toThrow("network failure");
    state.fail = false;
    await publishExplicit(client, input);
    expect(state.tag).toBe(input.targetCommitish);
  });
  it("rejects a conflicting tag", async () => {
    const { client, state } = fake();
    state.tag = "b".repeat(40);
    await expect(publishExplicit(client, input)).rejects.toThrow("different commit");
    expect(state.posts).toBe(0);
  });
  it("rejects changed notes", async () => {
    const { client, state } = fake();
    await publishExplicit(client, input);
    await expect(publishExplicit(client, { ...input, body: "Different" })).rejects.toThrow(
      "conflicts",
    );
    expect(state.posts).toBe(1);
  });
  it("completes a matching orphan tag", async () => {
    const { client, state } = fake();
    state.tag = input.targetCommitish;
    await publishExplicit(client, input);
    expect(state.posts).toBe(1);
  });
});
