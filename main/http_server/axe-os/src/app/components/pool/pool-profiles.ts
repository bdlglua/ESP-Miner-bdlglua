export const PROFILE_LIMIT = 8;

export interface PoolSettings {
  URL: string;
  Port: number;
  User: string;
  Coin: number;
  TLS: number;
  Cert: string;
  SuggestedDifficulty: number;
  ExtranonceSubscribe: boolean;
  DecodeCoinbase: boolean;
}

export interface PoolProfile {
  name: string;
  settings: PoolSettings;
}

export function poolProfile(name: string, value: Record<string, unknown>): PoolProfile | null {
  name = name.trim();
  const {URL, Port, User, Coin, TLS, Cert, SuggestedDifficulty, ExtranonceSubscribe, DecodeCoinbase} = value;
  const fits = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  if (!name || name.length > 32 || typeof URL !== 'string' || !URL.trim() || URL.length > 255 ||
      typeof User !== 'string' || !User.trim() || User.length > 3999 ||
      typeof Cert !== 'string' || Cert.length > 3999 || !fits(Port, 1, 65535) ||
      !fits(Coin, 0, 3) || !fits(TLS, 0, 2) || !fits(SuggestedDifficulty, 0, 65535) ||
      typeof ExtranonceSubscribe !== 'boolean' || typeof DecodeCoinbase !== 'boolean') return null;
  return {name, settings: {URL, Port, User, Coin, TLS, Cert, SuggestedDifficulty, ExtranonceSubscribe, DecodeCoinbase}};
}

export function readPoolProfiles(value: string | null): PoolProfile[] {
  try {
    const entries: unknown = JSON.parse(value ?? '[]');
    if (!Array.isArray(entries)) return [];
    return entries.slice(0, PROFILE_LIMIT).flatMap(entry => {
      if (typeof entry?.name !== 'string' || !entry.settings || typeof entry.settings !== 'object') return [];
      const profile = poolProfile(entry.name, entry.settings);
      return profile ? [profile] : [];
    });
  } catch {
    return [];
  }
}
