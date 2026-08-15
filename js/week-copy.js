(function () {
  "use strict";

  const TC = window.TeacherCalendar = window.TeacherCalendar || {};
  const D = TC.Dates;
  const Recurrence = TC.Recurrence;

  const STATUS_LABELS = {
    scheduled: "Запланировано",
    completed: "Проведено",
    cancelled_student: "Отменено учеником",
    cancelled_teacher: "Отменено преподавателем",
    moved: "Перенесено",
    missed: "Пропущено"
  };
  const FORMAT_LABELS = { online: "Онлайн", offline: "Очно", hybrid: "Смешанный" };
  const WEEKDAYS = ["", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
  const CANCELLED = new Set(["cancelled_student", "cancelled_teacher"]);

  let api = null;
  let ui = {};
  let sourceMonday = "";
  let targetMonday = "";
  let sourceLessons = [];
  let selectedIds = new Set();
  let previewItems = [];
  let isCopying = false;
  let viewingHistoryId = null;

  function byId(id) { return document.getElementById(id); }
  function clone(value) { return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value)); }
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `copy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  function participantById(id) {
    return api.getState().participants.find(function (participant) { return participant.id === id; }) || null;
  }
  function weekLabel(monday) { return D.formatWeekTitle(D.getWeekGrid(monday)); }
  function lessonName(lesson) {
    const participant = participantById(lesson.participantId);
    return participant ? participant.name : "Удалённый участник";
  }
  function isCancelled(status) { return CANCELLED.has(status); }
  function plural(count, one, few, many) {
    const n10 = count % 10;
    const n100 = count % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }
  function formatDateTime(dateKey, time) { return `${D.formatDateLong(dateKey, true)}, ${time}`; }
  function sourceSignature(lesson) { return lesson.instanceId || `${lesson.participantId}:${lesson.startUtc}`; }

  function visibleLessonsForWeek(state, monday) {
    return Recurrence.expand(state, D.getWeekGrid(monday), state.settings.displayOffsetMinutes);
  }

  function targetForLesson(lesson, fromMonday, toMonday, displayOffsetMinutes) {
    const deltaDays = D.diffDays(fromMonday, toMonday);
    const dateKey = D.addDays(lesson.displayDateKey, deltaDays);
    const time = lesson.displayTime;
    return {
      dateKey,
      time,
      startUtc: D.localDateTimeToUtc(dateKey, time, displayOffsetMinutes)
    };
  }

  function overlaps(firstStartUtc, firstDuration, secondStartUtc, secondDuration) {
    const firstStart = Date.parse(firstStartUtc);
    const firstEnd = firstStart + Number(firstDuration || 0) * 60_000;
    const secondStart = Date.parse(secondStartUtc);
    const secondEnd = secondStart + Number(secondDuration || 0) * 60_000;
    return firstStart < secondEnd && firstEnd > secondStart;
  }

  function evaluateTarget(state, source, target, targetWeek) {
    const existing = visibleLessonsForWeek(state, targetWeek);
    const seriesDuplicates = existing.filter(function (lesson) {
      return Boolean(source.recurring && lesson.recurring)
        && lesson.seriesId === source.seriesId
        && lesson.participantId === source.participantId
        && lesson.displayDateKey === target.dateKey
        && lesson.displayTime === target.time
        && Number(lesson.durationMinutes) === Number(source.durationMinutes);
    });
    const conflicts = existing.filter(function (lesson) {
      if (isCancelled(lesson.lessonStatus)) return false;
      return overlaps(target.startUtc, source.durationMinutes, lesson.startUtc, lesson.durationMinutes);
    });
    return {
      issueType: seriesDuplicates.length ? "series" : conflicts.length ? "conflict" : null,
      existing: seriesDuplicates.length ? seriesDuplicates : conflicts,
      seriesDuplicates,
      conflicts
    };
  }

  function copyLessonRecord(source, target, batchId, timestamp, options, displayOffsetMinutes) {
    return {
      id: uuid(),
      participantId: source.participantId,
      startUtc: target.startUtc,
      sourceOffsetMinutes: displayOffsetMinutes,
      durationMinutes: Number(source.durationMinutes || 60),
      course: String(source.course || ""),
      format: source.format || "online",
      formatNote: options.copyFormatNote ? String(source.formatNote || "") : "",
      lessonStatus: "scheduled",
      paymentStatus: "unpaid",
      paymentAmount: source.paymentAmount == null || source.paymentAmount === "" ? null : Number(source.paymentAmount),
      paymentDate: "",
      paymentComment: "",
      homework: options.copyHomework ? String(source.homework || "") : "",
      movedFromUtc: null,
      originalLessonId: null,
      copyBatchId: batchId,
      copiedFromInstanceId: sourceSignature(source),
      copiedFromWeek: options.sourceWeek || sourceMonday,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  function cacheElements() {
    [
      "copyWeekButton", "weekCopyDialog", "weekCopyDialogTitle", "weekCopyClose", "weekCopySelectStep", "weekCopyPreviewStep",
      "copySourcePrev", "copySourceNext", "copyTargetPrev", "copyTargetNext", "copySourceLabel", "copyTargetLabel", "copyWeekError",
      "copyParticipantFilter", "copySelectAll", "copySelectNone", "copyCompletedOnly", "copyScheduledOnly", "copySelectionCount",
      "copyLessonList", "copyHomeworkOption", "copyFormatNoteOption", "copyCancelSelect", "copyPreviewButton",
      "copyConflictNotice", "copyPreviewList", "copySummarySelected", "copySummaryCreate", "copySummarySkip", "copySummaryConflict",
      "copyPreviewBack", "copyCancelPreview", "copyConfirmButton", "copyHistoryCount", "copyHistoryList", "copyHistoryEmpty"
    ].forEach(function (id) { ui[id] = byId(id); });
  }

  function setStep(step) {
    const preview = step === "preview";
    ui.weekCopySelectStep.hidden = preview;
    ui.weekCopyPreviewStep.hidden = !preview;
    ui.weekCopyDialogTitle.textContent = preview ? "Проверьте расписание" : "Копирование расписания";
  }

  function renderParticipantOptions() {
    const current = ui.copyParticipantFilter.value;
    ui.copyParticipantFilter.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "Все ученики и группы";
    ui.copyParticipantFilter.appendChild(all);
    api.getState().participants
      .filter(function (participant) { return !participant.archived || sourceLessons.some(function (lesson) { return lesson.participantId === participant.id; }); })
      .sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); })
      .forEach(function (participant) {
        const option = document.createElement("option");
        option.value = participant.id;
        option.textContent = `${participant.name}${participant.type === "group" ? " · группа" : ""}`;
        ui.copyParticipantFilter.appendChild(option);
      });
    ui.copyParticipantFilter.value = current && Array.from(ui.copyParticipantFilter.options).some(function (option) { return option.value === current; }) ? current : "";
  }

  function lessonsMatchingFilter() {
    const participantId = ui.copyParticipantFilter.value;
    return sourceLessons.filter(function (lesson) { return !participantId || lesson.participantId === participantId; });
  }

  function renderWeekLabels() {
    ui.copySourceLabel.textContent = weekLabel(sourceMonday);
    ui.copyTargetLabel.textContent = weekLabel(targetMonday);
    const sameWeek = sourceMonday === targetMonday;
    ui.copyWeekError.hidden = !sameWeek;
    ui.copyWeekError.textContent = sameWeek ? "Исходная неделя и неделя назначения должны отличаться." : "";
    ui.copyPreviewButton.disabled = sameWeek || selectedIds.size === 0;
  }

  function renderLessonList() {
    ui.copyLessonList.replaceChildren();
    const filterId = ui.copyParticipantFilter.value;
    if (!sourceLessons.length) {
      const empty = document.createElement("p");
      empty.className = "week-copy-empty";
      empty.textContent = "В исходной неделе занятий нет.";
      ui.copyLessonList.appendChild(empty);
    }
    sourceLessons.forEach(function (lesson) {
      const participant = participantById(lesson.participantId);
      const row = document.createElement("label");
      row.className = `week-copy-lesson-row${filterId && lesson.participantId !== filterId ? " is-filtered" : ""}`;
      row.style.setProperty("--participant-color", participant ? participant.color : "#928b82");

      const checkWrap = document.createElement("span");
      checkWrap.className = "week-copy-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedIds.has(sourceSignature(lesson));
      checkbox.addEventListener("change", function () {
        if (checkbox.checked) selectedIds.add(sourceSignature(lesson));
        else selectedIds.delete(sourceSignature(lesson));
        updateSelectionCount();
      });
      checkWrap.appendChild(checkbox);

      const date = document.createElement("span");
      date.className = "week-copy-date";
      const dateStrong = document.createElement("strong");
      dateStrong.textContent = `${WEEKDAYS[D.weekday(lesson.displayDateKey)]}, ${lesson.displayTime}`;
      const dateSmall = document.createElement("span");
      dateSmall.textContent = D.formatDateShort(lesson.displayDateKey);
      date.append(dateStrong, dateSmall);

      const person = document.createElement("span");
      person.className = "week-copy-person";
      const personStrong = document.createElement("strong");
      personStrong.textContent = lessonName(lesson);
      const personSmall = document.createElement("span");
      personSmall.textContent = `${lesson.durationMinutes} мин · ${FORMAT_LABELS[lesson.format] || lesson.format || "—"}`;
      person.append(personStrong, personSmall);

      const details = document.createElement("span");
      details.className = "week-copy-details";
      const detailsStrong = document.createElement("strong");
      detailsStrong.textContent = lesson.course || "Курс не указан";
      const detailsSmall = document.createElement("span");
      detailsSmall.textContent = STATUS_LABELS[lesson.lessonStatus] || "Запланировано";
      details.append(detailsStrong, detailsSmall);

      const recurrence = document.createElement("span");
      recurrence.className = `week-copy-recurring${lesson.recurring ? " is-series" : ""}`;
      recurrence.textContent = lesson.recurring ? "↻ Повторяется" : "Разовый";
      row.append(checkWrap, date, person, details, recurrence);
      ui.copyLessonList.appendChild(row);
    });
    updateSelectionCount();
  }

  function updateSelectionCount() {
    const count = selectedIds.size;
    ui.copySelectionCount.textContent = `${count} ${plural(count, "выбрано", "выбрано", "выбрано")}`;
    renderWeekLabels();
  }

  function loadSourceWeek(resetSelection) {
    sourceLessons = visibleLessonsForWeek(api.getState(), sourceMonday);
    if (resetSelection) selectedIds = new Set(sourceLessons.map(sourceSignature));
    else selectedIds = new Set(sourceLessons.map(sourceSignature).filter(function (id) { return selectedIds.has(id); }));
    renderParticipantOptions();
    renderWeekLabels();
    renderLessonList();
  }

  function adjustWeek(which, amount) {
    if (which === "source") {
      let candidate = D.addDays(sourceMonday, amount * 7);
      if (candidate === targetMonday) candidate = D.addDays(candidate, amount * 7);
      sourceMonday = candidate;
      ui.copyParticipantFilter.value = "";
      loadSourceWeek(true);
    } else {
      let candidate = D.addDays(targetMonday, amount * 7);
      if (candidate === sourceMonday) candidate = D.addDays(candidate, amount * 7);
      targetMonday = candidate;
      renderWeekLabels();
    }
  }

  function setVisibleSelection(predicate) {
    const visible = lessonsMatchingFilter();
    visible.forEach(function (lesson) {
      const id = sourceSignature(lesson);
      if (predicate(lesson)) selectedIds.add(id);
      else selectedIds.delete(id);
    });
    renderLessonList();
  }

  function buildPreview() {
    if (sourceMonday === targetMonday || selectedIds.size === 0) return;
    const state = api.getState();
    const displayOffset = state.settings.displayOffsetMinutes;
    previewItems = sourceLessons
      .filter(function (lesson) { return selectedIds.has(sourceSignature(lesson)); })
      .map(function (source) {
        const target = targetForLesson(source, sourceMonday, targetMonday, displayOffset);
        const evaluation = evaluateTarget(state, source, target, targetMonday);
        return {
          id: sourceSignature(source), source, target,
          issueType: evaluation.issueType,
          existing: evaluation.existing,
          action: evaluation.issueType ? "skip" : "copy"
        };
      });
    setStep("preview");
    renderPreview();
  }

  function describeLesson(lesson, dateKey, time) {
    return {
      title: `${lessonName(lesson)} · ${time}`,
      date: D.formatDateLong(dateKey, true),
      details: `${lesson.durationMinutes} мин · ${lesson.course || "курс не указан"} · ${FORMAT_LABELS[lesson.format] || lesson.format || "формат не указан"}`
    };
  }

  function refreshPreviewItem(item, newTime) {
    if (newTime) {
      item.target.time = newTime;
      item.target.startUtc = D.localDateTimeToUtc(item.target.dateKey, newTime, api.getState().settings.displayOffsetMinutes);
    }
    const evaluation = evaluateTarget(api.getState(), item.source, item.target, targetMonday);
    item.issueType = evaluation.issueType;
    item.existing = evaluation.existing;
    item.action = evaluation.issueType ? (newTime ? "change" : "skip") : "copy";
    renderPreview();
  }

  function renderPreview() {
    ui.copyPreviewList.replaceChildren();
    previewItems.forEach(function (item) {
      const row = document.createElement("article");
      row.className = `copy-preview-row${item.issueType ? " has-conflict" : ""}${item.action === "skip" ? " is-skipped" : ""}`;

      const oldSide = document.createElement("div");
      oldSide.className = "copy-preview-side";
      const oldCaption = document.createElement("small");
      oldCaption.textContent = "Исходная неделя";
      const oldInfo = describeLesson(item.source, item.source.displayDateKey, item.source.displayTime);
      const oldTitle = document.createElement("strong"); oldTitle.textContent = oldInfo.title;
      const oldDate = document.createElement("span"); oldDate.textContent = oldInfo.date;
      const oldDetails = document.createElement("span"); oldDetails.textContent = oldInfo.details;
      oldSide.append(oldCaption, oldTitle, oldDate, oldDetails);

      const arrow = document.createElement("div");
      arrow.className = "copy-preview-arrow";
      arrow.textContent = "→";

      const newSide = document.createElement("div");
      newSide.className = "copy-preview-side";
      const newCaption = document.createElement("small"); newCaption.textContent = "Новая неделя";
      const newInfo = describeLesson(item.source, item.target.dateKey, item.target.time);
      const newTitle = document.createElement("strong"); newTitle.textContent = newInfo.title;
      const newDate = document.createElement("span"); newDate.textContent = newInfo.date;
      const newDetails = document.createElement("span"); newDetails.textContent = `${newInfo.details} · новый статус: Запланировано`;
      newSide.append(newCaption, newTitle, newDate, newDetails);
      row.append(oldSide, arrow, newSide);

      if (item.issueType) {
        const issue = document.createElement("div");
        issue.className = "copy-preview-issue";
        const issueCopy = document.createElement("div");
        issueCopy.className = "copy-preview-issue-copy";
        const issueTitle = document.createElement("strong");
        issueTitle.textContent = item.issueType === "series" ? "Уже существует в повторяющейся серии" : "Найдено пересечение";
        const issueText = document.createElement("span");
        const existing = item.existing[0];
        issueText.textContent = existing
          ? `Существующее: ${lessonName(existing)}, ${formatDateTime(existing.displayDateKey, existing.displayTime)} (${existing.durationMinutes} мин)${item.existing.length > 1 ? `, ещё ${item.existing.length - 1}` : ""}`
          : "Проверьте время занятия.";
        issueCopy.append(issueTitle, issueText);

        const actionWrap = document.createElement("div");
        actionWrap.className = "copy-preview-action";
        const actionLabel = document.createElement("label");
        const actionCaption = document.createElement("span"); actionCaption.textContent = "Действие";
        const select = document.createElement("select");
        const choices = item.issueType === "series"
          ? [["skip", "Пропустить"], ["replace", "Заменить существующее"], ["separate", "Создать отдельное"]]
          : [["skip", "Пропустить конфликт"], ["force", "Всё равно скопировать"], ["change", "Изменить время"]];
        choices.forEach(function (choice) {
          const option = document.createElement("option"); option.value = choice[0]; option.textContent = choice[1]; option.selected = item.action === choice[0]; select.appendChild(option);
        });
        select.addEventListener("change", function () {
          item.action = select.value;
          renderPreview();
        });
        actionLabel.append(actionCaption, select);
        actionWrap.appendChild(actionLabel);
        if (item.action === "change") {
          const timeLabel = document.createElement("label");
          const timeCaption = document.createElement("span"); timeCaption.textContent = "Новое время";
          const timeInput = document.createElement("input"); timeInput.type = "time"; timeInput.step = "300"; timeInput.value = item.target.time;
          timeInput.addEventListener("change", function () { if (timeInput.value) refreshPreviewItem(item, timeInput.value); });
          timeLabel.append(timeCaption, timeInput);
          actionWrap.appendChild(timeLabel);
        }
        issue.append(issueCopy, actionWrap);
        row.appendChild(issue);
      }
      ui.copyPreviewList.appendChild(row);
    });
    renderSummary();
  }

  function itemWillCreate(item) {
    if (!item.issueType) return true;
    if (item.issueType === "series") return item.action === "replace" || item.action === "separate";
    return item.action === "force";
  }

  function renderSummary() {
    const selected = previewItems.length;
    const create = previewItems.filter(itemWillCreate).length;
    const conflicts = previewItems.filter(function (item) { return Boolean(item.issueType); }).length;
    ui.copySummarySelected.textContent = selected;
    ui.copySummaryCreate.textContent = create;
    ui.copySummarySkip.textContent = selected - create;
    ui.copySummaryConflict.textContent = conflicts;
    ui.copyConflictNotice.hidden = conflicts === 0;
    ui.copyConfirmButton.disabled = isCopying || selected === 0;
  }

  function findCopiedDuplicate(state, item) {
    return state.singleLessons.find(function (lesson) {
      return lesson.copiedFromInstanceId === sourceSignature(item.source) && lesson.startUtc === item.target.startUtc;
    }) || null;
  }

  function findException(state, lesson) {
    return state.occurrenceExceptions.find(function (exception) {
      return exception.seriesId === lesson.seriesId && exception.originalStartUtc === lesson.originalStartUtc;
    }) || null;
  }

  function replaceExisting(state, existing, batchId, newLessonId, timestamp) {
    if (!existing) return null;
    if (!existing.recurring) {
      const index = state.singleLessons.findIndex(function (lesson) { return lesson.id === existing.id; });
      if (index < 0) return null;
      const snapshot = clone(state.singleLessons[index]);
      state.singleLessons.splice(index, 1);
      return { type: "single", newLessonId, removedLesson: snapshot, copyBatchId: batchId };
    }
    const previous = findException(state, existing);
    const record = {
      type: "exception",
      newLessonId,
      seriesId: existing.seriesId,
      originalStartUtc: existing.originalStartUtc,
      previousException: previous ? clone(previous) : null,
      copyBatchId: batchId
    };
    if (previous) {
      previous.kind = "deleted";
      previous.overrides = {};
      previous.updatedAt = timestamp;
    } else {
      state.occurrenceExceptions.push({
        id: uuid(), seriesId: existing.seriesId, originalStartUtc: existing.originalStartUtc,
        kind: "deleted", overrides: {}, createdAt: timestamp, updatedAt: timestamp
      });
    }
    return record;
  }

  function restoreReplacement(state, record) {
    if (record.type === "single" && record.removedLesson) {
      if (!state.singleLessons.some(function (lesson) { return lesson.id === record.removedLesson.id; })) state.singleLessons.push(clone(record.removedLesson));
      return;
    }
    if (record.type !== "exception") return;
    state.occurrenceExceptions = state.occurrenceExceptions.filter(function (exception) {
      return !(exception.seriesId === record.seriesId && exception.originalStartUtc === record.originalStartUtc);
    });
    if (record.previousException) state.occurrenceExceptions.push(clone(record.previousException));
  }

  function executeCopyPlan(state, items, config) {
    const batchId = config.batchId || uuid();
    const timestamp = config.timestamp || new Date().toISOString();
    const created = [];
    const versions = {};
    const replacements = [];
    let skipped = 0;

    items.forEach(function (item) {
      if (!itemWillCreate(item)) { skipped += 1; return; }
      if (findCopiedDuplicate(state, item)) { skipped += 1; return; }

      const fresh = evaluateTarget(state, item.source, item.target, config.targetWeek);
      const permitsSeriesDuplicate = item.action === "replace" || item.action === "separate";
      const permitsConflict = item.action === "force";
      if (fresh.issueType === "series" && !permitsSeriesDuplicate) { skipped += 1; return; }
      if (fresh.issueType === "conflict" && !permitsConflict) { skipped += 1; return; }

      const newLesson = copyLessonRecord(item.source, item.target, batchId, timestamp, {
        copyHomework: Boolean(config.copyHomework),
        copyFormatNote: Boolean(config.copyFormatNote),
        sourceWeek: config.sourceWeek
      }, state.settings.displayOffsetMinutes);

      if (item.action === "replace" && fresh.seriesDuplicates.length) {
        const replacement = replaceExisting(state, fresh.seriesDuplicates[0], batchId, newLesson.id, timestamp);
        if (replacement) replacements.push(replacement);
      }
      state.singleLessons.push(newLesson);
      created.push(newLesson);
      versions[newLesson.id] = timestamp;
    });

    const operation = {
      id: batchId,
      sourceWeek: config.sourceWeek,
      targetWeek: config.targetWeek,
      createdAt: timestamp,
      createdLessonIds: created.map(function (lesson) { return lesson.id; }),
      createdLessonVersions: versions,
      createdSnapshots: clone(created),
      replacementRecords: replacements,
      createdCount: created.length,
      skippedCount: skipped,
      undoneAt: null,
      removedCount: 0,
      skippedModifiedCount: 0
    };
    state.copyHistory.unshift(operation);
    state.copyHistory = state.copyHistory.slice(0, 10);
    state.lastCopyOperationId = batchId;
    return { batchId, timestamp, created, skipped, operation };
  }

  function undoCopyPlan(state, operationId, requireLast) {
    const operation = state.copyHistory.find(function (item) { return item.id === operationId; });
    if (!operation || operation.undoneAt) return { ok: false, reason: "missing" };
    if (requireLast && state.lastCopyOperationId !== operationId) return { ok: false, reason: "not-last" };

    const removable = new Set();
    let modified = 0;
    operation.createdLessonIds.forEach(function (id) {
      const lesson = state.singleLessons.find(function (item) { return item.id === id; });
      if (!lesson) return;
      const expectedVersion = operation.createdLessonVersions[id];
      if (lesson.copyBatchId === operation.id && lesson.updatedAt === expectedVersion) removable.add(id);
      else modified += 1;
    });
    state.singleLessons = state.singleLessons.filter(function (lesson) { return !removable.has(lesson.id); });
    (operation.replacementRecords || []).forEach(function (record) {
      if (removable.has(record.newLessonId)) restoreReplacement(state, record);
    });
    operation.undoneAt = new Date().toISOString();
    operation.removedCount = removable.size;
    operation.skippedModifiedCount = modified;
    if (state.lastCopyOperationId === operationId) state.lastCopyOperationId = null;
    return { ok: true, removed: removable.size, modified, operation };
  }

  function performCopy() {
    if (isCopying) return;
    isCopying = true;
    const originalText = ui.copyConfirmButton.textContent;
    ui.copyConfirmButton.disabled = true;
    ui.copyConfirmButton.textContent = "Копирование…";

    try {
      const state = api.getState();
      const before = clone({
        singleLessons: state.singleLessons,
        occurrenceExceptions: state.occurrenceExceptions,
        copyHistory: state.copyHistory,
        lastCopyOperationId: state.lastCopyOperationId
      });
      const result = executeCopyPlan(state, previewItems, {
        sourceWeek: sourceMonday,
        targetWeek: targetMonday,
        copyHomework: ui.copyHomeworkOption.checked,
        copyFormatNote: ui.copyFormatNoteOption.checked
      });

      if (!api.save()) {
        state.singleLessons = before.singleLessons;
        state.occurrenceExceptions = before.occurrenceExceptions;
        state.copyHistory = before.copyHistory;
        state.lastCopyOperationId = before.lastCopyOperationId;
        api.toast("Не удалось сохранить скопированное расписание", true);
        return;
      }

      ui.weekCopyDialog.close();
      api.showCopiedWeek(targetMonday, result.created.map(function (lesson) { return lesson.id; }));
      const message = `Расписание скопировано: создано ${result.created.length} ${plural(result.created.length, "занятие", "занятия", "занятий")}, пропущено ${result.skipped}`;
      api.toastAction(message, "Отменить копирование", function () { undoOperation(result.batchId, true); });
    } finally {
      isCopying = false;
      ui.copyConfirmButton.textContent = originalText;
      renderSummary();
    }
  }

  function undoOperation(operationId, requireLast) {
    const state = api.getState();
    const result = undoCopyPlan(state, operationId, requireLast);
    if (!result.ok && result.reason === "not-last") {
      api.toast("После этой операции уже выполнялось другое копирование. Используйте историю копирования.", true);
      return;
    }
    if (!result.ok) return;
    api.save();
    api.showCopiedWeek(result.operation.targetWeek, []);
    renderHistory();
    api.toast(result.modified
      ? `Копирование отменено: удалено ${result.removed}, изменённых занятий сохранено ${result.modified}`
      : `Копирование отменено: удалено ${result.removed} ${plural(result.removed, "занятие", "занятия", "занятий")}`);
  }

  function renderHistory() {
    if (!ui.copyHistoryList) return;
    const history = api.getState().copyHistory || [];
    ui.copyHistoryList.replaceChildren();
    ui.copyHistoryEmpty.hidden = history.length > 0;
    ui.copyHistoryCount.textContent = `${history.length} ${plural(history.length, "операция", "операции", "операций")}`;
    history.forEach(function (operation) {
      const row = document.createElement("article");
      row.className = `copy-history-row${operation.undoneAt ? " is-undone" : ""}`;
      const copy = document.createElement("div");
      copy.className = "copy-history-copy";
      const title = document.createElement("strong");
      title.textContent = `${weekLabel(operation.sourceWeek)} → ${weekLabel(operation.targetWeek)}`;
      const meta = document.createElement("span");
      const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(operation.createdAt));
      meta.textContent = operation.undoneAt
        ? `${date} · отменено, удалено ${operation.removedCount || 0}`
        : `${date} · создано ${operation.createdLessonIds.length}, пропущено ${operation.skippedCount || 0}`;
      copy.append(title, meta);
      if (viewingHistoryId === operation.id) {
        const view = document.createElement("div");
        view.className = "copy-history-view";
        const snapshots = operation.createdSnapshots || [];
        view.textContent = snapshots.length
          ? snapshots.map(function (lesson) {
              const participant = participantById(lesson.participantId);
              const dateKey = D.dateKeyFromUtc(lesson.startUtc, api.getState().settings.displayOffsetMinutes);
              const time = D.timeFromUtc(lesson.startUtc, api.getState().settings.displayOffsetMinutes);
              return `${D.formatDateShort(dateKey)}, ${time} — ${participant ? participant.name : "Удалённый участник"}`;
            }).join(" · ")
          : "В этой операции новые занятия не создавались.";
        copy.appendChild(view);
      }

      const actions = document.createElement("div");
      actions.className = "copy-history-actions";
      const viewButton = document.createElement("button");
      viewButton.className = "secondary-button";
      viewButton.type = "button";
      viewButton.textContent = viewingHistoryId === operation.id ? "Скрыть" : "Посмотреть";
      viewButton.addEventListener("click", function () { viewingHistoryId = viewingHistoryId === operation.id ? null : operation.id; renderHistory(); });
      actions.appendChild(viewButton);
      const undoButton = document.createElement("button");
      undoButton.className = "secondary-button";
      undoButton.type = "button";
      undoButton.textContent = "Отменить копирование";
      undoButton.disabled = Boolean(operation.undoneAt);
      undoButton.addEventListener("click", function () { undoOperation(operation.id, false); });
      actions.appendChild(undoButton);
      row.append(copy, actions);
      ui.copyHistoryList.appendChild(row);
    });
  }

  function open() {
    sourceMonday = D.mondayOf(api.getSelectedDayKey());
    targetMonday = D.addDays(sourceMonday, 7);
    selectedIds.clear();
    previewItems = [];
    ui.copyParticipantFilter.value = "";
    ui.copyHomeworkOption.checked = false;
    ui.copyFormatNoteOption.checked = true;
    setStep("select");
    loadSourceWeek(true);
    renderHistory();
    ui.weekCopyDialog.showModal();
  }

  function close() {
    if (isCopying) return;
    ui.weekCopyDialog.close();
  }

  function attachEvents() {
    ui.copyWeekButton.addEventListener("click", open);
    ui.weekCopyClose.addEventListener("click", close);
    ui.copyCancelSelect.addEventListener("click", close);
    ui.copyCancelPreview.addEventListener("click", close);
    ui.weekCopyDialog.addEventListener("cancel", function (event) { event.preventDefault(); close(); });
    ui.copySourcePrev.addEventListener("click", function () { adjustWeek("source", -1); });
    ui.copySourceNext.addEventListener("click", function () { adjustWeek("source", 1); });
    ui.copyTargetPrev.addEventListener("click", function () { adjustWeek("target", -1); });
    ui.copyTargetNext.addEventListener("click", function () { adjustWeek("target", 1); });
    ui.copyParticipantFilter.addEventListener("change", function () {
      const filterId = ui.copyParticipantFilter.value;
      if (filterId) selectedIds = new Set(sourceLessons.filter(function (lesson) { return lesson.participantId === filterId; }).map(sourceSignature));
      else selectedIds = new Set(sourceLessons.map(sourceSignature));
      renderLessonList();
    });
    ui.copySelectAll.addEventListener("click", function () { setVisibleSelection(function () { return true; }); });
    ui.copySelectNone.addEventListener("click", function () { setVisibleSelection(function () { return false; }); });
    ui.copyCompletedOnly.addEventListener("click", function () { setVisibleSelection(function (lesson) { return lesson.lessonStatus === "completed"; }); });
    ui.copyScheduledOnly.addEventListener("click", function () { setVisibleSelection(function (lesson) { return lesson.lessonStatus === "scheduled"; }); });
    ui.copyPreviewButton.addEventListener("click", buildPreview);
    ui.copyPreviewBack.addEventListener("click", function () { setStep("select"); renderHistory(); });
    ui.copyConfirmButton.addEventListener("click", performCopy);
  }

  function init(applicationApi) {
    api = applicationApi;
    cacheElements();
    if (!ui.copyWeekButton || !ui.weekCopyDialog) return;
    attachEvents();
    renderHistory();
  }

  TC.WeekCopy = {
    init,
    open,
    refreshHistory: renderHistory,
    test: { targetForLesson, overlaps, evaluateTarget, copyLessonRecord, executeCopyPlan, undoCopyPlan }
  };
})();
