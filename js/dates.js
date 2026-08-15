(function () {
  "use strict";

  const TC = window.TeacherCalendar = window.TeacherCalendar || {};
  const DAY_MS = 86_400_000;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function parseDateKey(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    return { year, month, monthIndex: month - 1, day };
  }

  function dateKey(year, monthIndex, day) {
    const date = new Date(Date.UTC(year, monthIndex, day));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function addDays(key, amount) {
    const parts = parseDateKey(key);
    if (!parts) return "";
    return dateKey(parts.year, parts.monthIndex, parts.day + amount);
  }

  function diffDays(fromKey, toKey) {
    const from = parseDateKey(fromKey);
    const to = parseDateKey(toKey);
    if (!from || !to) return NaN;
    return Math.round((Date.UTC(to.year, to.monthIndex, to.day) - Date.UTC(from.year, from.monthIndex, from.day)) / DAY_MS);
  }

  function weekday(key) {
    const parts = parseDateKey(key);
    if (!parts) return 1;
    return new Date(Date.UTC(parts.year, parts.monthIndex, parts.day)).getUTCDay() || 7;
  }

  function mondayOf(key) {
    return addDays(key, 1 - weekday(key));
  }

  function getMonthGrid(year, monthIndex) {
    const firstKey = dateKey(year, monthIndex, 1);
    const startKey = addDays(firstKey, 1 - weekday(firstKey));
    return Array.from({ length: 42 }, function (_, index) {
      const key = addDays(startKey, index);
      const parts = parseDateKey(key);
      return {
        key,
        year: parts.year,
        monthIndex: parts.monthIndex,
        day: parts.day,
        weekday: weekday(key),
        inMonth: parts.year === year && parts.monthIndex === monthIndex
      };
    });
  }

  function getWeekGrid(key) {
    const startKey = mondayOf(key);
    return Array.from({ length: 7 }, function (_, index) {
      const currentKey = addDays(startKey, index);
      const parts = parseDateKey(currentKey);
      return {
        key: currentKey,
        year: parts.year,
        monthIndex: parts.monthIndex,
        day: parts.day,
        weekday: weekday(currentKey),
        inMonth: true
      };
    });
  }

  function weekInputValue(key) {
    const monday = mondayOf(key);
    const thursday = addDays(monday, 3);
    const thursdayParts = parseDateKey(thursday);
    if (!thursdayParts) return "";
    const weekYear = thursdayParts.year;
    const firstMonday = mondayOf(`${weekYear}-01-04`);
    const weekNumber = Math.floor(diffDays(firstMonday, monday) / 7) + 1;
    return `${weekYear}-W${pad(weekNumber)}`;
  }

  function mondayFromWeekInput(value) {
    const match = /^(\d{4})-W(\d{2})$/.exec(String(value || ""));
    if (!match) return "";
    const weekYear = Number(match[1]);
    const weekNumber = Number(match[2]);
    if (weekNumber < 1 || weekNumber > 53) return "";
    const monday = addDays(mondayOf(`${weekYear}-01-04`), (weekNumber - 1) * 7);
    return weekInputValue(monday) === value ? monday : "";
  }

  function partsFromUtc(isoOrMs, offsetMinutes) {
    const sourceMs = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
    const shifted = new Date(sourceMs + Number(offsetMinutes || 0) * 60_000);
    return {
      year: shifted.getUTCFullYear(),
      monthIndex: shifted.getUTCMonth(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds()
    };
  }

  function dateKeyFromUtc(isoOrMs, offsetMinutes) {
    const parts = partsFromUtc(isoOrMs, offsetMinutes);
    return dateKey(parts.year, parts.monthIndex, parts.day);
  }

  function timeFromUtc(isoOrMs, offsetMinutes) {
    const parts = partsFromUtc(isoOrMs, offsetMinutes);
    return `${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function localDateTimeToUtc(dateValue, timeValue, offsetMinutes) {
    const dateParts = parseDateKey(dateValue);
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeValue || ""));
    if (!dateParts || !timeMatch) return null;
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (hour > 23 || minute > 59) return null;
    const utcMs = Date.UTC(dateParts.year, dateParts.monthIndex, dateParts.day, hour, minute) - Number(offsetMinutes || 0) * 60_000;
    return new Date(utcMs).toISOString();
  }

  function todayKey(offsetMinutes) {
    return dateKeyFromUtc(Date.now(), offsetMinutes);
  }

  function monthFromToday(offsetMinutes) {
    const parts = partsFromUtc(Date.now(), offsetMinutes);
    return { year: parts.year, monthIndex: parts.monthIndex };
  }

  function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
  }

  function formatMonthTitle(year, monthIndex) {
    const value = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, monthIndex, 1)));
    return capitalize(value.replace(" г.", ""));
  }

  function formatWeekTitle(grid) {
    if (!grid || !grid.length) return "";
    const first = grid[0].key;
    const last = grid[grid.length - 1].key;
    return `${formatDateShort(first)} — ${formatDateShort(last)}`;
  }

  function formatDateLong(key, includeYear) {
    const parts = parseDateKey(key);
    if (!parts) return "";
    const options = { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" };
    if (includeYear) options.year = "numeric";
    return capitalize(new Intl.DateTimeFormat("ru-RU", options).format(new Date(Date.UTC(parts.year, parts.monthIndex, parts.day))));
  }

  function formatDateShort(key) {
    const parts = parseDateKey(key);
    if (!parts) return "";
    return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(parts.year, parts.monthIndex, parts.day)))
      .replace(" г.", "");
  }

  function offsetLabel(offsetMinutes) {
    const total = Number(offsetMinutes || 0);
    const sign = total >= 0 ? "+" : "−";
    const absolute = Math.abs(total);
    const hours = Math.floor(absolute / 60);
    const minutes = absolute % 60;
    return `UTC${sign}${hours}${minutes ? `:${pad(minutes)}` : ""}`;
  }

  function clockTime(offsetMinutes) {
    return timeFromUtc(Date.now(), offsetMinutes);
  }

  function endUtc(startUtc, durationMinutes) {
    return new Date(Date.parse(startUtc) + Number(durationMinutes || 0) * 60_000).toISOString();
  }

  function monthDifference(fromKey, toKey) {
    const from = parseDateKey(fromKey);
    const to = parseDateKey(toKey);
    if (!from || !to) return NaN;
    return (to.year - from.year) * 12 + (to.monthIndex - from.monthIndex);
  }

  TC.Dates = {
    DAY_MS,
    pad,
    parseDateKey,
    dateKey,
    addDays,
    diffDays,
    weekday,
    mondayOf,
    getMonthGrid,
    getWeekGrid,
    weekInputValue,
    mondayFromWeekInput,
    partsFromUtc,
    dateKeyFromUtc,
    timeFromUtc,
    localDateTimeToUtc,
    todayKey,
    monthFromToday,
    formatMonthTitle,
    formatWeekTitle,
    formatDateLong,
    formatDateShort,
    offsetLabel,
    clockTime,
    endUtc,
    monthDifference
  };
})();
