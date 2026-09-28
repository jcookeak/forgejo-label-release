import type { ForgejoClient, ReleasePublisherClient, CreateReleaseInput } from "./forgejo.ts";

// Stateless publication of values supplied by the caller. It owns serialization
// and any artifact recovery; this action only reconciles the Forgejo write.
export async function publishExplicit(
  client: ForgejoClient & ReleasePublisherClient,
  input: CreateReleaseInput,
): Promise<void> {
  const exists = async (): Promise<boolean> => {
    const release = await client.getReleaseByTag(input.tagName);
    if (!release) return false;
    if (
      (await client.getTagCommit(input.tagName)) !== input.targetCommitish ||
      release.body !== input.body ||
      release.draft !== input.draft ||
      release.prerelease !== input.prerelease
    )
      throw new Error(
        `Release ${input.tagName} conflicts with the supplied version, commit or notes.`,
      );
    return true;
  };
  if (await exists()) return;
  const tag = await client.getTagCommit(input.tagName);
  if (tag !== null && tag !== input.targetCommitish)
    throw new Error(`Tag ${input.tagName} targets a different commit.`);
  try {
    await client.createRelease(input);
  } catch (error) {
    if (await exists()) return;
    throw error;
  }
  if (!(await exists()))
    throw new Error(`Release ${input.tagName} was not visible after creation.`);
}
