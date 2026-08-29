import { describe, expect, it } from "vitest";
import { parseRepoUrl } from "./github.js";

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/owner/repo", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo/", { owner: "owner", repo: "repo" }],
    ["http://github.com/owner/repo", { owner: "owner", repo: "repo" }],
    ["github.com/owner/repo", { owner: "owner", repo: "repo" }],
    ["git@github.com:owner/repo.git", { owner: "owner", repo: "repo" }],
    ["git@github.com:owner/repo", { owner: "owner", repo: "repo" }],
    ["owner/repo", { owner: "owner", repo: "repo" }],
    ["owner/repo.git", { owner: "owner", repo: "repo" }],
    ["  https://github.com/owner/repo  ", { owner: "owner", repo: "repo" }],
    ["https://github.com/my-org/my.repo-name", { owner: "my-org", repo: "my.repo-name" }],
  ])("accepts %s", (input, expected) => {
    expect(parseRepoUrl(input)).toEqual(expected);
  });

  it.each([
    [""],
    ["   "],
    ["not a url"],
    ["https://gitlab.com/owner/repo"],
    ["https://github.com/owner"],
    ["https://github.com/"],
    ["owner/repo/extra"],
    ["ftp://github.com/owner/repo"],
  ])("rejects %s", (input) => {
    expect(() => parseRepoUrl(input)).toThrow();
  });
});
