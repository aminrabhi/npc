// The village clock.
//
// It follows the device's own local time, so the village is at whatever time of day
// the player is actually in. A debug override can pin it to a chosen minute instead;
// turning that off simply falls back to reading the real clock again. Nothing here
// knows about villagers or weather - other modules ask this one what time it is.

export const DAY_MINUTES = 24 * 60;
export const SLEEP_START = 22 * 60; // 22:00
export const SLEEP_END = 8 * 60; // 08:00

const wrap = (minutes) => ((Math.round(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;

const pad = (n) => String(n).padStart(2, '0');

export function createClock({ now = () => new Date() } = {}) {
  let override = null; // minutes since midnight while the debug clock is on

  function read() {
    if (override !== null) {
      return {
        minutes: override,
        seconds: 0,
        source: 'debug',
      };
    }
    const date = now();
    return {
      minutes: wrap(date.getHours() * 60 + date.getMinutes()),
      seconds: date.getSeconds(),
      source: 'real',
    };
  }

  const clock = {
    isOverridden: () => override !== null,

    // Debug: pin the clock. Independent of every other debug switch.
    setOverride(hours, minutes = 0) {
      override = wrap(hours * 60 + minutes);
      return override;
    },

    setOverrideMinutes(minutes) {
      override = wrap(minutes);
      return override;
    },

    clearOverride() {
      override = null;
    },

    // Minutes since midnight, with the seconds folded in so the light can creep.
    totalMinutes() {
      const r = read();
      return r.minutes + r.seconds / 60;
    },

    hours() {
      return Math.floor(this.totalMinutes() / 60) % 24;
    },

    minute() {
      return Math.floor(this.totalMinutes() % 60);
    },

    second() {
      return read().seconds;
    },

    source() {
      return read().source;
    },

    // The device's own UTC offset, e.g. "GMT+2". The HUD prints it next to the time
    // so it is always obvious which clock the village is following.
    zoneLabel() {
      const minutes = -now().getTimezoneOffset();
      const sign = minutes < 0 ? '-' : '+';
      const abs = Math.abs(minutes);
      const h = Math.floor(abs / 60);
      const m = abs % 60;
      return `GMT${sign}${h}${m ? `:${pad(m)}` : ''}`;
    },

    // "8:05 AM" - the HUD reads this straight out.
    label() {
      const h24 = this.hours();
      const suffix = h24 < 12 ? 'AM' : 'PM';
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      return `${h12}:${pad(this.minute())} ${suffix}`;
    },

    // Coarse day phase, used for lighting and by the debug panel.
    phase() {
      const m = this.totalMinutes();
      if (m < 5 * 60) return 'night';
      if (m < 11 * 60) return 'morning';
      if (m < 17 * 60) return 'day';
      if (m < 21 * 60) return 'evening';
      return 'night';
    },

    isDaytime() {
      const m = this.totalMinutes();
      return m >= SLEEP_END && m < SLEEP_START;
    },

    isNight() {
      return !this.isDaytime();
    },

    // 0 at midnight, 1 at the next midnight.
    progress() {
      return this.totalMinutes() / DAY_MINUTES;
    },
  };

  return clock;
}
