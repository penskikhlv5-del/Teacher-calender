(function () {
  "use strict";

  const TC = window.TeacherCalendar = window.TeacherCalendar || {};
  const STORAGE_KEY = "teacherCalendar.state.v1";

  function defaultState() {
    return {
      version: 1,
      settings: {
        displayOffsetMinutes: 300,
        calendarView: "month",
        locale: "ru-RU",
        filters: {
          participantIds: [],
          participantTypes: [],
          lessonStatuses: [],
          paymentStatuses: []
        }
      },
      participants: [],
      singleLessons: [],
      series: [],
      occurrenceExceptions: []
    };
  }

  function clone(value) {
    return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Корневой объект данных имеет неверный формат");
    if (raw.version != null && Number(raw.version) !== 1) throw new Error(`Версия данных ${raw.version} пока не поддерживается`);

    const base = defaultState();
    const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    const filters = settings.filters && typeof settings.filters === "object" ? settings.filters : {};
    const offset = Number(settings.displayOffsetMinutes);

    base.settings.displayOffsetMinutes = Number.isFinite(offset) ? Math.max(-720, Math.min(840, Math.round(offset / 60) * 60)) : 300;
    base.settings.calendarView = settings.calendarView === "week" ? "week" : "month";
    base.settings.filters.participantIds = Array.isArray(filters.participantIds) ? filters.participantIds.filter(String) : [];
    base.settings.filters.participantTypes = Array.isArray(filters.participantTypes) ? filters.participantTypes.filter(function (item) { return item === "student" || item === "group"; }) : [];
    base.settings.filters.lessonStatuses = Array.isArray(filters.lessonStatuses) ? filters.lessonStatuses.filter(String) : [];
    base.settings.filters.paymentStatuses = Array.isArray(filters.paymentStatuses) ? filters.paymentStatuses.filter(String) : [];

    ["participants", "singleLessons", "series", "occurrenceExceptions"].forEach(function (key) {
      if (raw[key] != null && !Array.isArray(raw[key])) throw new Error(`Поле ${key} должно быть массивом`);
      base[key] = Array.isArray(raw[key]) ? raw[key].filter(function (item) { return item && typeof item === "object"; }) : [];
    });

    const participantIds = new Set();
    base.participants = base.participants.filter(function (participant) {
      if (!participant.id || !participant.name || participantIds.has(participant.id)) return false;
      participantIds.add(participant.id);
      participant.type = participant.type === "group" ? "group" : "student";
      participant.color = /^#[0-9a-f]{6}$/i.test(participant.color || "") ? participant.color : "#f5a20a";
      participant.archived = Boolean(participant.archived);
      participant.note = String(participant.note || "");
      participant.defaultCourse = String(participant.defaultCourse || "");
      participant.defaultDurationMinutes = Number(participant.defaultDurationMinutes || 60);
      participant.defaultFormat = ["online", "offline", "hybrid"].includes(participant.defaultFormat) ? participant.defaultFormat : "online";
      participant.defaultPaymentAmount = participant.defaultPaymentAmount == null || participant.defaultPaymentAmount === "" ? null : Number(participant.defaultPaymentAmount);
      participant.defaultPaymentStatus = ["unpaid", "paid", "not_required"].includes(participant.defaultPaymentStatus) ? participant.defaultPaymentStatus : "unpaid";
      participant.defaultHomework = String(participant.defaultHomework || "");
      return true;
    });

    base.singleLessons = base.singleLessons.filter(function (lesson) {
      const valid = lesson.id && lesson.participantId && !Number.isNaN(Date.parse(lesson.startUtc)) && Number(lesson.durationMinutes) > 0;
      if (valid) {
        lesson.course = String(lesson.course || "");
        lesson.paymentAmount = lesson.paymentAmount == null || lesson.paymentAmount === "" ? null : Number(lesson.paymentAmount);
      }
      return valid;
    });
    base.series = base.series.filter(function (item) {
      const valid = item.id && item.participantId && !Number.isNaN(Date.parse(item.anchorStartUtc)) && item.recurrence && typeof item.recurrence === "object";
      if (valid) {
        item.course = String(item.course || "");
        item.defaultPaymentAmount = item.defaultPaymentAmount == null || item.defaultPaymentAmount === "" ? null : Number(item.defaultPaymentAmount);
      }
      return valid;
    });
    base.occurrenceExceptions = base.occurrenceExceptions.filter(function (item) {
      return item.id && item.seriesId && !Number.isNaN(Date.parse(item.originalStartUtc)) && ["moved", "cancelled", "deleted", "overridden"].includes(item.kind);
    });

    return base;
  }

  function load() {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (!text) {
        const fresh = defaultState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        return { state: fresh, storageAvailable: true, error: null };
      }
      return { state: normalize(JSON.parse(text)), storageAvailable: true, error: null };
    } catch (error) {
      try {
        const corrupt = localStorage.getItem(STORAGE_KEY);
        if (corrupt) localStorage.setItem(`${STORAGE_KEY}.corrupt.${Date.now()}`, corrupt);
      } catch (_) {
        // Хранилище может быть полностью недоступно.
      }
      return { state: defaultState(), storageAvailable: false, error };
    }
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch (_) {
      return false;
    }
  }

  TC.Storage = { STORAGE_KEY, defaultState, clone, normalize, load, save, clear };
})();
