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
      occurrenceExceptions: [],
      reportHistory: [],
      copyHistory: [],
      lastCopyOperationId: null
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

    ["participants", "singleLessons", "series", "occurrenceExceptions", "reportHistory", "copyHistory"].forEach(function (key) {
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
        if (lesson.paymentAmount == null && lesson.price != null) lesson.paymentAmount = lesson.price;
        lesson.paymentAmount = lesson.paymentAmount == null || lesson.paymentAmount === "" ? null : Number(lesson.paymentAmount);
        lesson.paymentStatus = ["paid", "unpaid", "not_required"].includes(lesson.paymentStatus) ? lesson.paymentStatus : "unpaid";
        lesson.paymentDate = /^\d{4}-\d{2}-\d{2}$/.test(lesson.paymentDate || "") ? lesson.paymentDate : "";
        lesson.paymentComment = String(lesson.paymentComment || "");
        lesson.originalLessonId = lesson.originalLessonId ? String(lesson.originalLessonId) : null;
        lesson.copyBatchId = lesson.copyBatchId ? String(lesson.copyBatchId) : null;
        lesson.copiedFromInstanceId = lesson.copiedFromInstanceId ? String(lesson.copiedFromInstanceId) : null;
        lesson.copiedFromWeek = /^\d{4}-\d{2}-\d{2}$/.test(lesson.copiedFromWeek || "") ? lesson.copiedFromWeek : "";
      }
      return valid;
    });
    base.series = base.series.filter(function (item) {
      const valid = item.id && item.participantId && !Number.isNaN(Date.parse(item.anchorStartUtc)) && item.recurrence && typeof item.recurrence === "object";
      if (valid) {
        item.course = String(item.course || "");
        if (item.defaultPaymentAmount == null && item.price != null) item.defaultPaymentAmount = item.price;
        item.defaultPaymentAmount = item.defaultPaymentAmount == null || item.defaultPaymentAmount === "" ? null : Number(item.defaultPaymentAmount);
        item.defaultPaymentStatus = ["paid", "unpaid", "not_required"].includes(item.defaultPaymentStatus) ? item.defaultPaymentStatus : "unpaid";
        item.defaultPaymentDate = /^\d{4}-\d{2}-\d{2}$/.test(item.defaultPaymentDate || "") ? item.defaultPaymentDate : "";
        item.defaultPaymentComment = String(item.defaultPaymentComment || "");
      }
      return valid;
    });
    base.occurrenceExceptions = base.occurrenceExceptions.filter(function (item) {
      const valid = item.id && item.seriesId && !Number.isNaN(Date.parse(item.originalStartUtc)) && ["moved", "cancelled", "deleted", "overridden"].includes(item.kind);
      if (valid) {
        item.overrides = item.overrides && typeof item.overrides === "object" ? item.overrides : {};
        if (item.overrides.paymentAmount == null && item.overrides.price != null) item.overrides.paymentAmount = item.overrides.price;
        if (item.overrides.paymentAmount != null && item.overrides.paymentAmount !== "") item.overrides.paymentAmount = Number(item.overrides.paymentAmount);
        item.overrides.paymentDate = /^\d{4}-\d{2}-\d{2}$/.test(item.overrides.paymentDate || "") ? item.overrides.paymentDate : "";
        item.overrides.paymentComment = String(item.overrides.paymentComment || "");
        if (item.overrides.originalLessonId != null) item.overrides.originalLessonId = String(item.overrides.originalLessonId);
      }
      return valid;
    });

    base.reportHistory = base.reportHistory.filter(function (report) {
      if (!report.id || !report.participantId || !Array.isArray(report.lessonSnapshot)) return false;
      const reportParticipant = base.participants.find(function (participant) { return participant.id === report.participantId; });
      report.participantName = String(report.participantName || (reportParticipant ? reportParticipant.name : "Удалённый участник"));
      report.type = String(report.type || "manual");
      report.month = /^\d{4}-(0[1-9]|1[0-2])$/.test(report.month || "") ? report.month : "";
      report.rangeStartMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(report.rangeStartMonth || "") ? report.rangeStartMonth : "";
      report.rangeEndMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(report.rangeEndMonth || "") ? report.rangeEndMonth : "";
      report.startDate = String(report.startDate || "");
      report.endDate = String(report.endDate || "");
      report.lessonSnapshot = report.lessonSnapshot.filter(function (lesson) { return lesson && typeof lesson === "object" && lesson.participantId === report.participantId; });
      if (!report.lessonSnapshot.length) return false;
      report.lessonIds = report.lessonSnapshot.map(function (lesson) { return String(lesson.instanceId || lesson.id || ""); }).filter(Boolean);
      report.lessonCount = report.lessonSnapshot.length;
      report.accrued = report.lessonSnapshot.reduce(function (sum, lesson) {
        if (lesson.lessonStatus !== "completed" && lesson.lessonStatus !== "missed") return sum;
        const amount = Number(lesson.paymentAmount == null ? lesson.price : lesson.paymentAmount);
        return sum + (Number.isFinite(amount) && amount >= 0 ? amount : 0);
      }, 0);
      report.paid = report.lessonSnapshot.reduce(function (sum, lesson) {
        if ((lesson.lessonStatus !== "completed" && lesson.lessonStatus !== "missed") || lesson.paymentStatus !== "paid") return sum;
        const amount = Number(lesson.paymentAmount == null ? lesson.price : lesson.paymentAmount);
        return sum + (Number.isFinite(amount) && amount >= 0 ? amount : 0);
      }, 0);
      report.due = Math.max(0, report.accrued - report.paid);
      report.createdAt = String(report.createdAt || new Date().toISOString());
      return true;
    });

    base.copyHistory = base.copyHistory.filter(function (operation) {
      if (!operation.id || !/^\d{4}-\d{2}-\d{2}$/.test(operation.sourceWeek || "") || !/^\d{4}-\d{2}-\d{2}$/.test(operation.targetWeek || "")) return false;
      operation.id = String(operation.id);
      operation.createdAt = String(operation.createdAt || new Date().toISOString());
      operation.createdLessonIds = Array.isArray(operation.createdLessonIds) ? operation.createdLessonIds.map(String) : [];
      operation.createdLessonVersions = operation.createdLessonVersions && typeof operation.createdLessonVersions === "object" ? operation.createdLessonVersions : {};
      operation.createdSnapshots = Array.isArray(operation.createdSnapshots) ? operation.createdSnapshots.filter(function (lesson) { return lesson && typeof lesson === "object"; }) : [];
      operation.replacementRecords = Array.isArray(operation.replacementRecords) ? operation.replacementRecords.filter(function (record) { return record && typeof record === "object"; }) : [];
      operation.createdCount = operation.createdLessonIds.length;
      operation.skippedCount = Number(operation.skippedCount || 0);
      operation.undoneAt = operation.undoneAt ? String(operation.undoneAt) : null;
      operation.removedCount = Number(operation.removedCount || 0);
      operation.skippedModifiedCount = Number(operation.skippedModifiedCount || 0);
      return true;
    }).sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); }).slice(0, 10);

    base.lastCopyOperationId = raw.lastCopyOperationId && base.copyHistory.some(function (operation) { return operation.id === raw.lastCopyOperationId; }) ? String(raw.lastCopyOperationId) : null;

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
