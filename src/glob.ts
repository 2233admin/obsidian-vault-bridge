function escapeRegex(segment: string): string {
  return segment.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function matchGlob(pattern: string, path: string): boolean {
  const regex = escapeRegex(pattern)
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\\\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

// Self-test examples:
// matchGlob("KB/**", "KB/foo/bar.md") === true
// matchGlob("KB/**", "Daily/foo.md") === false
// matchGlob("**/*.md", "Daily/foo.md") === true
// matchGlob("Daily/*.md", "Daily/sub/x.md") === false
// matchGlob("Daily/?.md", "Daily/a.md") === true
