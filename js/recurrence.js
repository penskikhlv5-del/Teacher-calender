(function () {
  "use strict";

  const TC = window.TeacherCalendar = window.TeacherCalendar || {};
  const D = TC.Dates;

  function exceptionKey(seriesId, originalStartUtc) {
    return `${seriesId}|${originalStartUtc}`;
  }

  function seriesBaseLesson(series, originalStartUtc) {
    return {
      instanceId: `occurrence:${series.id}:${originalStartUtc}`,
      id: null,
      seriesId: series.id,
      participantId: series.participantId,
      startUtc: originalStartUtc,
      originalStartUtc,
      sourceOffsetMinutes: Number(series.sourceOffsetMinutes || 0),
      durationMinutes: Number(series.durationMinutes || 60),
      course: series.course || "",
      format: series.format || "online",
      formatNote: series.formatNote || "",
      lessonStatus: series.defaultLessonStatus || "scheduled",
      paymentStatus: series.defaultPaymentStatus || "unpaid",
      paymentAmount: series.defaultPaymentAmount == null || series.defaultPaymentAmount === "" ? null : Number(series.defaultPaymentAmount),
      homework: series.defaultHomework || "",
      movedFromUtc: null,
      recurring: true,
      recurrence: series.recurrence
    };
  }

  function materializeOccurrence(series, originalStartUtc, exception) {
    if (exception && exception.kind === "deleted") return null;
    const lesson = seriesBaseLesson(series, originalStartUtc);
    if (exception && exception.overrides && typeof exception.overrides === "object") {
      Object.keys(exception.overrides).forEach(function (key) {
        if (exception.overrides[key] !== undefined) lesson[key] = exception.overrides[key];
      });
      lesson.exceptionId = exception.id;
      lesson.exceptionKind = exception.kind;
    }
    if (exception && exception.kind === "moved") {
      lesson.movedFromUtc = originalStartUtc;
      if (!exception.overrides || !exception.overrides.lessonStatus) lesson.lessonStatus = "moved";
    }
    return lesson;
  }

  function isScheduledOnDate(series, sourceDateKey, anchorDateKey) {
    const recurrence = series.recurrence || {};
    if (sourceDateKey < anchorDateKey) return false;
    if (recurrence.untilLocalDate && sourceDateKey > recurrence.untilLocalDate) return false;

    if (recurrence.frequency === "monthly") {
      const anchor = D.parseDateKey(anchorDateKey);
      const current = D.parseDateKey(sourceDateKey);
      const interval = Math.max(1, Number(recurrence.interval || 1));
      const monthDiff = D.monthDifference(anchorDateKey, sourceDateKey);
      return monthDiff >= 0 && monthDiff % interval === 0 && current.day === anchor.day;
    }

    const weekdays = Array.isArray(recurrence.weekdays) && recurrence.weekdays.length
      ? recurrence.weekdays.map(Number)
      : [D.weekday(anchorDateKey)];
    if (!weekdays.includes(D.weekday(sourceDateKey))) return false;

    const interval = Math.max(1, Number(recurrence.interval || 1));
    const anchorMonday = D.mondayOf(anchorDateKey);
    const currentMonday = D.mondayOf(sourceDateKey);
    const weekDiff = Math.floor(D.diffDays(anchorMonday, currentMonday) / 7);
    return weekDiff >= 0 && weekDiff % interval === 0;
  }

  function visibleSingleLesson(lesson, visibleKeys, displayOffsetMinutes) {
    const key = D.dateKeyFromUtc(lesson.startUtc, displayOffsetMinutes);
    if (!visibleKeys.has(key)) return null;
    return Object.assign({}, lesson, {
      instanceId: `single:${lesson.id}`,
      originalStartUtc: lesson.startUtc,
      recurring: false,
      displayDateKey: key,
      displayTime: D.timeFromUtc(lesson.startUtc, displayOffsetMinutes)
    });
  }

  function expand(state, grid, displayOffsetMinutes) {
    if (!grid || !grid.length) return [];
    const visibleKeys = new Set(grid.map(function (cell) { return cell.key; }));
    const firstSourceDate = D.addDays(grid[0].key, -3);
    const lastSourceDate = D.addDays(grid[grid.length - 1].key, 3);
    const exceptions = new Map();
    (state.occurrenceExceptions || []).forEach(function (item) {
      exceptions.set(exceptionKey(item.seriesId, item.originalStartUtc), item);
    });

    const lessons = [];
    (state.singleLessons || []).forEach(function (lesson) {
      const visible = visibleSingleLesson(lesson, visibleKeys, displayOffsetMinutes);
      if (visible) lessons.push(visible);
    });

    (state.series || []).forEach(function (series) {
      const anchorParts = D.partsFromUtc(series.anchorStartUtc, Number(series.sourceOffsetMinutes || 0));
      const anchorDateKey = D.dateKey(anchorParts.year, anchorParts.monthIndex, anchorParts.day);
      const anchorTime = `${D.pad(anchorParts.hour)}:${D.pad(anchorParts.minute)}`;
      const generatedOriginals = new Set();

      let sourceKey = firstSourceDate;
      let safety = 0;
      while (sourceKey <= lastSourceDate && safety < 60) {
        if (isScheduledOnDate(series, sourceKey, anchorDateKey)) {
          const originalStartUtc = D.localDateTimeToUtc(sourceKey, anchorTime, Number(series.sourceOffsetMinutes || 0));
          if (originalStartUtc && Date.parse(originalStartUtc) >= Date.parse(series.anchorStartUtc)) {
            generatedOriginals.add(originalStartUtc);
            const exception = exceptions.get(exceptionKey(series.id, originalStartUtc));
            const occurrence = materializeOccurrence(series, originalStartUtc, exception);
            if (occurrence) {
              occurrence.displayDateKey = D.dateKeyFromUtc(occurrence.startUtc, displayOffsetMinutes);
              occurrence.displayTime = D.timeFromUtc(occurrence.startUtc, displayOffsetMinutes);
              if (visibleKeys.has(occurrence.displayDateKey)) lessons.push(occurrence);
            }
          }
        }
        sourceKey = D.addDays(sourceKey, 1);
        safety += 1;
      }

      (state.occurrenceExceptions || []).forEach(function (exception) {
        if (exception.seriesId !== series.id || exception.kind === "deleted" || generatedOriginals.has(exception.originalStartUtc)) return;
        if (!exception.overrides || !exception.overrides.startUtc) return;
        const displayKey = D.dateKeyFromUtc(exception.overrides.startUtc, displayOffsetMinutes);
        if (!visibleKeys.has(displayKey)) return;
        const occurrence = materializeOccurrence(series, exception.originalStartUtc, exception);
        if (!occurrence) return;
        occurrence.displayDateKey = displayKey;
        occurrence.displayTime = D.timeFromUtc(occurrence.startUtc, displayOffsetMinutes);
        lessons.push(occurrence);
      });
    });

    lessons.sort(function (a, b) {
      return a.displayDateKey.localeCompare(b.displayDateKey)
        || Date.parse(a.startUtc) - Date.parse(b.startUtc)
        || String(a.participantId).localeCompare(String(b.participantId));
    });
    return lessons;
  }

  function describe(series) {
    if (!series || !series.recurrence) return "Не повторяется";
    const recurrence = series.recurrence;
    const anchor = D.partsFromUtc(series.anchorStartUtc, Number(series.sourceOffsetMinutes || 0));
    const time = `${D.pad(anchor.hour)}:${D.pad(anchor.minute)}`;
    const weekdayNames = ["", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
    const weekdayShort = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
    let base;

    if (recurrence.frequency === "monthly") {
      base = `Каждый месяц, ${anchor.day}-го числа, ${time}`;
    } else {
      const days = (recurrence.weekdays || [D.weekday(D.dateKey(anchor.year, anchor.monthIndex, anchor.day))]).map(Number);
      if (days.length === 1) {
        base = recurrence.interval === 2
          ? `Раз в две недели, ${weekdayNames[days[0]]}, ${time}`
          : `Каждый ${weekdayNames[days[0]]}, ${time}`;
      } else {
        base = `По дням: ${days.map(function (day) { return weekdayShort[day]; }).join(", ")}, ${time}`;
      }
    }

    const anchorKey = D.dateKey(anchor.year, anchor.monthIndex, anchor.day);
    const ending = recurrence.untilLocalDate ? `до ${D.formatDateShort(recurrence.untilLocalDate)}` : "без даты окончания";
    return `${base}, с ${D.formatDateShort(anchorKey)}, ${ending}`;
  }

  TC.Recurrence = { exceptionKey, expand, describe, materializeOccurrence };
})();
