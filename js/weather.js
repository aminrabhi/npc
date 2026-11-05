// Live weather for Jersey City, New Jersey, from Open-Meteo.
//
// The forecast endpoint is polled every ten minutes (and only then), the last good
// answer is cached in local storage, and a failed request leaves the previous
// conditions on screen instead of blanking the weather. A debug override replaces the
// conditions and temperature without stopping the live poller, so switching it off
// returns to whatever the last real reading was.

export const JERSEY_CITY = {
  name: 'Jersey City, NJ',
  latitude: 40.7282,
  longitude: -74.0776,
  timezone: 'America/New_York',
};

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const CURRENT_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'wind_speed_10m',
];
const STORAGE_KEY = 'sunnyside.weather.v1';
const REFRESH_MS = 10 * 60 * 1000;

// WMO weather codes, grouped the way the village draws them.
export const CONDITIONS = [
  { code: 0, key: 'clear', label: 'Clear sky' },
  { code: 1, key: 'mostly-clear', label: 'Mostly clear' },
  { code: 2, key: 'partly-cloudy', label: 'Partly cloudy' },
  { code: 3, key: 'overcast', label: 'Overcast' },
  { code: 45, key: 'fog', label: 'Fog' },
  { code: 48, key: 'fog', label: 'Rime fog' },
  { code: 51, key: 'drizzle', label: 'Light drizzle' },
  { code: 53, key: 'drizzle', label: 'Drizzle' },
  { code: 55, key: 'drizzle', label: 'Heavy drizzle' },
  { code: 61, key: 'rain', label: 'Light rain' },
  { code: 63, key: 'rain', label: 'Rain' },
  { code: 65, key: 'rain', label: 'Heavy rain' },
  { code: 71, key: 'snow', label: 'Light snow' },
  { code: 73, key: 'snow', label: 'Snow' },
  { code: 75, key: 'snow', label: 'Heavy snow' },
  { code: 77, key: 'snow', label: 'Snow grains' },
  { code: 80, key: 'rain', label: 'Light showers' },
  { code: 81, key: 'rain', label: 'Showers' },
  { code: 82, key: 'rain', label: 'Heavy showers' },
  { code: 85, key: 'snow', label: 'Snow showers' },
  { code: 86, key: 'snow', label: 'Heavy snow showers' },
  { code: 95, key: 'storm', label: 'Thunderstorm' },
  { code: 96, key: 'storm', label: 'Storm with hail' },
  { code: 99, key: 'storm', label: 'Heavy storm with hail' },
];

export function describe(code) {
  const known = CONDITIONS.find((entry) => entry.code === Number(code));
  if (known) return known;
  if (Number(code) >= 95) return CONDITIONS[CONDITIONS.length - 1];
  return { code: Number(code) || 0, key: 'clear', label: 'Clear sky' };
}

const isWet = (key) => key === 'rain' || key === 'drizzle' || key === 'storm';
const isSnowy = (key) => key === 'snow';

export function createWeather({ refreshMs = REFRESH_MS, storage } = {}) {
  let live = null; // last successful reading
  let error = null;
  let busy = false;
  let timer = null;
  let override = null; // { code, temperature } while the debug weather is on
  const listeners = new Set();

  const store = storage === undefined
    ? (typeof localStorage !== 'undefined' ? localStorage : null)
    : storage;

  function readCache() {
    try {
      const raw = store && store.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.code !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeCache(snapshot) {
    try {
      if (store) store.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // private mode or a full quota: the village still runs without a cache
    }
  }

  live = readCache();

  function emit() {
    for (const fn of listeners) fn(weather.state());
  }

  async function refresh() {
    if (busy) return weather.state();
    busy = true;
    try {
      const params = new URLSearchParams({
        latitude: String(JERSEY_CITY.latitude),
        longitude: String(JERSEY_CITY.longitude),
        current: CURRENT_FIELDS.join(','),
        timezone: JERSEY_CITY.timezone,
      });
      const res = await fetch(`${ENDPOINT}?${params}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
      const body = await res.json();
      const current = body && body.current;
      if (!current || typeof current.weather_code !== 'number') {
        throw new Error('Open-Meteo returned no current weather');
      }
      live = {
        code: current.weather_code,
        temperature: current.temperature_2m,
        apparent: current.apparent_temperature,
        humidity: current.relative_humidity_2m,
        precipitation: current.precipitation,
        rain: current.rain,
        showers: current.showers,
        snowfall: current.snowfall,
        cloudCover: current.cloud_cover,
        wind: current.wind_speed_10m,
        isDay: current.is_day === 1,
        at: Date.now(),
      };
      error = null;
      writeCache(live);
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    } finally {
      busy = false;
      emit();
    }
    return weather.state();
  }

  function start() {
    if (timer !== null) return;
    refresh();
    timer = setInterval(refresh, Math.max(60 * 1000, refreshMs));
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  const weather = {
    location: JERSEY_CITY,

    state() {
      const source = override || live || { code: 0, temperature: null };
      const info = describe(source.code);
      return {
        key: info.key,
        code: Number(source.code) || 0,
        label: info.label,
        temperature: source.temperature === null || source.temperature === undefined
          ? null
          : Math.round(source.temperature),
        apparent: live && live.apparent !== undefined ? Math.round(live.apparent) : null,
        humidity: live ? live.humidity : null,
        wind: live ? live.wind : null,
        cloudCover: live ? live.cloudCover : null,
        isDay: live ? live.isDay : null,
        overridden: !!override,
        live: !!live,
        error,
        at: live ? live.at : null,
        wet: isWet(info.key),
        snowy: isSnowy(info.key),
      };
    },

    refresh,
    start,
    stop,

    // Debug override: independent of the clock override.
    setOverride(code, temperature) {
      override = { code: Number(code) || 0, temperature };
      emit();
    },

    clearOverride() {
      override = null;
      emit();
    },

    isOverridden: () => !!override,

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  return weather;
}
