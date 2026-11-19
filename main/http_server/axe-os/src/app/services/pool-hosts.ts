export function isZpoolSha256(host?: string | null): boolean {
  return !!host && /^sha256\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?mine\.zpool\.ca\.?$/i.test(host);
}
