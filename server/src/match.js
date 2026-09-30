// URL glob matching shared by bot targeting and the privacy blocklist.
// Patterns without a "/" match the hostname; patterns with one match host+path.
//   "*"              everything
//   "*.github.io/*"  any subdomain of github.io (and github.io itself)
//   "*bank*"         any hostname containing "bank"
export function globToRegex(pattern) {
  let p = pattern.trim().toLowerCase().replace(/^https?:\/\//, "");
  let prefix = "";
  if (p.startsWith("*.")) {
    prefix = "(?:[^/]*\\.)?";
    p = p.slice(2);
  }
  const body = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${prefix}${body}$`);
}

export function urlMatches(url, patterns = []) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const hostPath = host + u.pathname.toLowerCase();
  return patterns.some((pattern) => {
    if (!pattern || !pattern.trim()) return false;
    if (pattern.trim() === "*") return true;
    const re = globToRegex(pattern);
    return pattern.includes("/") ? re.test(hostPath) : re.test(host);
  });
}
