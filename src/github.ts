import { Octokit } from "@octokit/rest";
import type { DependencyMap, RepoRef } from "./types.js";

/**
 * Accepts https://github.com/owner/repo(.git)?(/)?, git@github.com:owner/repo.git,
 * bare github.com/owner/repo, and the owner/repo shorthand. Rejects everything else
 * (including non-GitHub hosts) with a message safe to surface directly to a user.
 */
export function parseRepoUrl(input: string): RepoRef {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Repository URL must not be empty");
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const looksLikeBareHost = /^github\.com\//i.test(trimmed);

  if (hasScheme || looksLikeBareHost) {
    let url: URL;
    try {
      url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    } catch {
      throw new Error(`Not a valid repository URL: "${input}"`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported URL scheme "${url.protocol}" in "${input}"`);
    }
    if (url.hostname.toLowerCase() !== "github.com") {
      throw new Error(`Only github.com repositories are supported, got host "${url.hostname}"`);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`URL is missing an owner/repo path: "${input}"`);
    }
    const owner = parts[0]!;
    const repo = parts[1]!.replace(/\.git$/, "");
    if (!owner || !repo) {
      throw new Error(`Could not parse owner/repo from "${input}"`);
    }
    return { owner, repo };
  }

  const shorthandMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (shorthandMatch) {
    return { owner: shorthandMatch[1]!, repo: shorthandMatch[2]! };
  }

  throw new Error(`Not a valid repository URL: "${input}"`);
}

let cachedClient: Octokit | null = null;

/** Reads GITHUB_TOKEN from the environment — never accept a token as a literal in code. */
export function createGitHubClient(): Octokit {
  if (!cachedClient) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is not set");
    }
    cachedClient = new Octokit({ auth: token });
  }
  return cachedClient;
}

export interface PackageJsonResult {
  defaultBranch: string;
  dependencies: DependencyMap;
  devDependencies: DependencyMap;
}

export async function fetchPackageJson(client: Octokit, ref: RepoRef): Promise<PackageJsonResult> {
  const { data: repoData } = await client.rest.repos.get({ owner: ref.owner, repo: ref.repo });
  const defaultBranch = repoData.default_branch;

  const { data: fileData } = await client.rest.repos.getContent({
    owner: ref.owner,
    repo: ref.repo,
    path: "package.json",
    ref: defaultBranch,
  });

  if (Array.isArray(fileData) || fileData.type !== "file" || !fileData.content) {
    throw new Error(`package.json not found at the root of ${ref.owner}/${ref.repo}`);
  }

  const raw = Buffer.from(fileData.content, "base64").toString("utf-8");
  const parsed = JSON.parse(raw) as { dependencies?: DependencyMap; devDependencies?: DependencyMap };

  return {
    defaultBranch,
    dependencies: parsed.dependencies ?? {},
    devDependencies: parsed.devDependencies ?? {},
  };
}

export interface FileChange {
  path: string;
  content: string;
  message?: string;
}

export interface OpenPullRequestInput {
  ref: RepoRef;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
  files: FileChange[];
}

export interface OpenPullRequestResult {
  url: string;
  number: number;
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status?: number }).status === 404;
}

/** Creates a branch off `baseBranch`, commits `files`, and opens a PR. The one irreversible write path in this codebase — callers must gate this behind an explicit approval. */
export async function openPullRequest(
  client: Octokit,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  const { data: baseRef } = await client.rest.git.getRef({
    owner: input.ref.owner,
    repo: input.ref.repo,
    ref: `heads/${input.baseBranch}`,
  });

  await client.rest.git.createRef({
    owner: input.ref.owner,
    repo: input.ref.repo,
    ref: `refs/heads/${input.branchName}`,
    sha: baseRef.object.sha,
  });

  for (const file of input.files) {
    let sha: string | undefined;
    try {
      const { data: existing } = await client.rest.repos.getContent({
        owner: input.ref.owner,
        repo: input.ref.repo,
        path: file.path,
        ref: input.branchName,
      });
      if (!Array.isArray(existing) && existing.type === "file") {
        sha = existing.sha;
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }

    await client.rest.repos.createOrUpdateFileContents({
      owner: input.ref.owner,
      repo: input.ref.repo,
      path: file.path,
      message: file.message ?? `Update ${file.path}`,
      content: Buffer.from(file.content, "utf-8").toString("base64"),
      branch: input.branchName,
      sha,
    });
  }

  const { data: pr } = await client.rest.pulls.create({
    owner: input.ref.owner,
    repo: input.ref.repo,
    title: input.title,
    body: input.body,
    head: input.branchName,
    base: input.baseBranch,
  });

  return { url: pr.html_url, number: pr.number };
}
