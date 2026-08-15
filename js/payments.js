(function () {
  "use strict";

  const TC = window.TeacherCalendar = window.TeacherCalendar || {};
  const D = TC.Dates;
  const Recurrence = TC.Recurrence;

  const LESSON_LABELS = {
    scheduled: "Запланировано",
    completed: "Проведено",
    cancelled_student: "Отменено учеником",
    cancelled_teacher: "Отменено преподавателем",
    moved: "Перенесено",
    missed: "Пропущено"
  };
  const PAYMENT_LABELS = { paid: "Оплачено", unpaid: "Не оплачено", not_required: "Не требуется" };
  const REPORT_LABELS = { month: "За месяц", package4: "Пакет из 4 занятий", package10: "Пакет из 10 занятий", manual: "Выбранные занятия" };
  const MONTHS_NOMINATIVE = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const MONTHS_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  let api = null;
  let el = {};
  let reportCandidates = [];
  let reportSelectedIds = new Set();
  let reportDraft = null;
  let allowShortPackage = false;
  let previewFromHistory = false;

  function byId(id) { return document.getElementById(id); }
  function state() { return api.getState(); }
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `report_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }
  function isCancelled(status) { return status === "cancelled_student" || status === "cancelled_teacher"; }
  function paymentAmount(lesson) {
    const value = lesson.paymentAmount == null ? lesson.price : lesson.paymentAmount;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : 0;
  }
  function money(value) { return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number(value || 0))} ₽`; }
  function participantById(id) { return state().participants.find(function (item) { return item.id === id; }) || null; }
  function participantName(id) { const participant = participantById(id); return participant ? participant.name : "Удалённый участник"; }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char];
    });
  }
  function safeFilePart(value) { return String(value || "Отчёт").trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_"); }
  function statusColor(status) {
    if (status === "completed") return "var(--completed)";
    if (isCancelled(status)) return "var(--cancelled)";
    if (status === "moved") return "var(--moved)";
    if (status === "missed") return "var(--missed)";
    return "var(--scheduled)";
  }
  function lessonStatusLabel(lesson) {
    const base = LESSON_LABELS[lesson.lessonStatus] || lesson.lessonStatus;
    return (lesson.movedFromUtc || lesson.originalLessonId) && lesson.lessonStatus !== "moved" ? `${base} · после переноса` : base;
  }
  function todayKey() { return D.todayKey(state().settings.displayOffsetMinutes); }
  function currentMonthValue() { return todayKey().slice(0, 7); }
  function monthBounds(value) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return { year, monthIndex, start: D.dateKey(year, monthIndex, 1), end: D.dateKey(year, monthIndex, lastDay) };
  }
  function dateFile(key) {
    const parts = D.parseDateKey(key);
    return parts ? `${D.pad(parts.day)}.${D.pad(parts.monthIndex + 1)}.${parts.year}` : "";
  }
  function reportDate(key) {
    const parts = D.parseDateKey(key);
    if (!parts) return "—";
    return `${parts.day} ${MONTHS_GENITIVE[parts.monthIndex]} ${parts.year} года`;
  }
  function reportPeriod(start, end) {
    const first = D.parseDateKey(start);
    const last = D.parseDateKey(end);
    if (!first || !last) return "Период не указан";
    if (start === end) return reportDate(start);
    if (first.year === last.year) return `${first.day} ${MONTHS_GENITIVE[first.monthIndex]} — ${last.day} ${MONTHS_GENITIVE[last.monthIndex]} ${last.year} года`;
    return `${first.day} ${MONTHS_GENITIVE[first.monthIndex]} ${first.year} года — ${last.day} ${MONTHS_GENITIVE[last.monthIndex]} ${last.year} года`;
  }
  function lessonSort(a, b) { return Date.parse(a.startUtc) - Date.parse(b.startUtc) || String(a.instanceId).localeCompare(String(b.instanceId)); }
  function uniqueLessons(lessons) {
    const map = new Map();
    lessons.forEach(function (lesson) {
      const key = lesson.originalLessonId || lesson.instanceId;
      const existing = map.get(key);
      if (!existing || Date.parse(lesson.startUtc) >= Date.parse(existing.startUtc)) map.set(key, lesson);
    });
    return Array.from(map.values()).sort(lessonSort);
  }

  function lessonsForRange(data, start, end, offsetMinutes) {
    if (!D.parseDateKey(start) || !D.parseDateKey(end) || start > end) return [];
    const first = D.parseDateKey(start);
    const last = D.parseDateKey(end);
    let year = first.year;
    let monthIndex = first.monthIndex;
    const collected = [];
    let safety = 0;
    while ((year < last.year || (year === last.year && monthIndex <= last.monthIndex)) && safety < 240) {
      const grid = D.getMonthGrid(year, monthIndex);
      Recurrence.expand(data, grid, offsetMinutes).forEach(function (lesson) {
        if (lesson.displayDateKey >= start && lesson.displayDateKey <= end) collected.push(lesson);
      });
      monthIndex += 1;
      if (monthIndex > 11) { monthIndex = 0; year += 1; }
      safety += 1;
    }
    return uniqueLessons(collected);
  }

  function calculateTotals(lessons) {
    return lessons.reduce(function (totals, lesson) {
      const amount = paymentAmount(lesson);
      if (lesson.lessonStatus === "moved" || lesson.movedFromUtc || lesson.originalLessonId) totals.moved += 1;
      if (lesson.lessonStatus === "completed") {
        totals.accrued += amount;
        totals.completed += 1;
        if (lesson.paymentStatus === "paid") totals.paid += amount;
      } else if (isCancelled(lesson.lessonStatus)) totals.cancelled += 1;
      else if (lesson.lessonStatus === "scheduled") totals.planned += 1;
      return totals;
    }, { accrued: 0, paid: 0, due: 0, completed: 0, cancelled: 0, moved: 0, planned: 0 });
  }

  function finalizeTotals(totals) {
    totals.due = Math.max(0, totals.accrued - totals.paid);
    return totals;
  }

  function selectPackage(lessons, startDate, size, today) {
    return uniqueLessons(lessons).filter(function (lesson) {
      return lesson.participantId && lesson.displayDateKey >= startDate && lesson.displayDateKey <= today && lesson.lessonStatus === "completed";
    }).slice(0, size);
  }

  function snapshotLesson(lesson) {
    return {
      instanceId: lesson.instanceId,
      id: lesson.id || null,
      seriesId: lesson.seriesId || null,
      originalStartUtc: lesson.originalStartUtc || lesson.startUtc,
      participantId: lesson.participantId,
      participantName: participantName(lesson.participantId),
      startUtc: lesson.startUtc,
      displayDateKey: lesson.displayDateKey,
      displayTime: lesson.displayTime,
      durationMinutes: Number(lesson.durationMinutes || 0),
      lessonStatus: lesson.lessonStatus || "scheduled",
      paymentStatus: lesson.paymentStatus || "unpaid",
      paymentAmount: paymentAmount(lesson),
      paymentDate: lesson.paymentDate || "",
      paymentComment: lesson.paymentComment || "",
      course: lesson.course || "",
      movedFromUtc: lesson.movedFromUtc || null,
      originalLessonId: lesson.originalLessonId || null
    };
  }

  function cacheElements() {
    [
      "paymentPanel", "paymentParticipantFilter", "paymentMonthFilter", "paymentAccrued", "paymentPaid", "paymentDue", "paymentPlannedNote",
      "paymentTableCaption", "paymentLessonCount", "paymentTableBody", "paymentEmpty", "createReportButton", "exportPaymentsButton",
      "reportHistoryCount", "reportHistoryList", "reportHistoryEmpty", "reportDialog", "reportForm", "reportDialogClose", "reportParticipant",
      "reportType", "reportMonthField", "reportMonth", "reportStartField", "reportStartDate", "manualReportControls", "manualStartDate",
      "manualEndDate", "manualLessonStatus", "manualPaymentStatus", "manualSelectAll", "manualSelectNone", "manualCompletedOnly",
      "reportShortage", "reportShortageText", "changeReportStart", "useAvailableLessons", "cancelShortReport", "reportSelectionCount",
      "reportSelectionList", "reportCancel", "reportPreviewButton", "reportPreviewDialog", "reportPreviewClose", "reportPreviewContent",
      "reportPreviewBack", "printReportButton", "csvDialog", "csvForm", "csvDialogClose", "csvMonthField", "csvMonth", "csvStartField",
      "csvStartDate", "csvEndField", "csvEndDate", "csvCancel"
    ].forEach(function (id) { el[id] = byId(id); });
  }

  function populateParticipants() {
    const filterValue = el.paymentParticipantFilter.value;
    const reportValue = el.reportParticipant.value;
    const participants = state().participants.slice().sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); });
    el.paymentParticipantFilter.replaceChildren(new Option("Все ученики и группы", ""));
    el.reportParticipant.replaceChildren(new Option("Выберите ученика или группу", ""));
    participants.forEach(function (participant) {
      const suffix = participant.type === "group" ? " · группа" : "";
      el.paymentParticipantFilter.appendChild(new Option(participant.name + suffix, participant.id));
      el.reportParticipant.appendChild(new Option(participant.name + suffix, participant.id));
    });
    if (participants.some(function (item) { return item.id === filterValue; })) el.paymentParticipantFilter.value = filterValue;
    if (participants.some(function (item) { return item.id === reportValue; })) el.reportParticipant.value = reportValue;
    el.createReportButton.disabled = !participants.length;
  }

  function currentPaymentLessons() {
    const bounds = monthBounds(el.paymentMonthFilter.value);
    if (!bounds) return [];
    const participantId = el.paymentParticipantFilter.value;
    return lessonsForRange(state(), bounds.start, bounds.end, state().settings.displayOffsetMinutes).filter(function (lesson) {
      return !participantId || lesson.participantId === participantId;
    });
  }

  function renderPayments() {
    populateParticipants();
    const bounds = monthBounds(el.paymentMonthFilter.value);
    const lessons = currentPaymentLessons();
    const totals = finalizeTotals(calculateTotals(lessons));
    const futurePlanned = lessons.filter(function (lesson) { return lesson.lessonStatus === "scheduled" && lesson.displayDateKey >= todayKey(); }).length;
    el.paymentAccrued.textContent = money(totals.accrued);
    el.paymentPaid.textContent = money(totals.paid);
    el.paymentDue.textContent = money(totals.due);
    el.paymentPlannedNote.textContent = futurePlanned ? `${futurePlanned} будущих занятий не включено` : "Будущие уроки не включены";
    el.paymentLessonCount.textContent = `${lessons.length} ${lessonWord(lessons.length)}`;
    el.paymentTableCaption.textContent = bounds ? `${MONTHS_NOMINATIVE[bounds.monthIndex]} ${bounds.year} · начисляются только проведённые занятия` : "Выберите месяц";
    el.paymentTableBody.replaceChildren();
    el.paymentEmpty.hidden = Boolean(lessons.length);
    lessons.forEach(function (lesson) { el.paymentTableBody.appendChild(paymentRow(lesson)); });
    renderHistory();
  }

  function lessonWord(count) {
    const tail = count % 100;
    const last = count % 10;
    if (tail >= 11 && tail <= 14) return "занятий";
    if (last === 1) return "занятие";
    if (last >= 2 && last <= 4) return "занятия";
    return "занятий";
  }

  function paymentRow(lesson) {
    const participant = participantById(lesson.participantId);
    const row = document.createElement("tr");
    const person = document.createElement("td");
    person.innerHTML = `<span class="payment-person" style="--participant-color:${escapeHtml(participant ? participant.color : "#928b82")}"><i></i>${escapeHtml(participant ? participant.name : "Удалённый участник")}</span>`;
    const date = document.createElement("td"); date.textContent = D.formatDateShort(lesson.displayDateKey);
    const time = document.createElement("td"); time.textContent = lesson.displayTime;
    const duration = document.createElement("td"); duration.textContent = String(lesson.durationMinutes || 0);
    const status = document.createElement("td"); status.innerHTML = `<span class="payment-status" style="--status-color:${statusColor(lesson.lessonStatus)}">${escapeHtml(lessonStatusLabel(lesson))}</span>`;
    const priceCell = document.createElement("td");
    const price = document.createElement("input"); price.type = "number"; price.min = "0"; price.max = "1000000"; price.step = "50"; price.className = "payment-price-input"; price.value = lesson.paymentAmount == null ? "" : String(lesson.paymentAmount); price.setAttribute("aria-label", "Стоимость урока"); priceCell.appendChild(price);
    const paymentCell = document.createElement("td");
    const payment = document.createElement("select"); payment.setAttribute("aria-label", "Статус оплаты");
    [["unpaid", "Не оплачено"], ["paid", "Оплачено"], ["not_required", "Не требуется"]].forEach(function (item) { payment.appendChild(new Option(item[1], item[0], false, lesson.paymentStatus === item[0])); });
    paymentCell.appendChild(payment);
    const paymentDateCell = document.createElement("td");
    const paymentDate = document.createElement("input"); paymentDate.type = "date"; paymentDate.className = "payment-date-input"; paymentDate.value = lesson.paymentDate || ""; paymentDate.setAttribute("aria-label", "Дата оплаты"); paymentDateCell.appendChild(paymentDate);
    const commentCell = document.createElement("td");
    const comment = document.createElement("input"); comment.type = "text"; comment.maxLength = 500; comment.className = "payment-comment-input"; comment.value = lesson.paymentComment || ""; comment.placeholder = "Комментарий"; comment.setAttribute("aria-label", "Комментарий к оплате"); commentCell.appendChild(comment);
    const actionCell = document.createElement("td");
    const actions = document.createElement("div"); actions.className = "payment-row-actions";
    const open = document.createElement("button"); open.type = "button"; open.className = "secondary-button"; open.textContent = "Открыть"; open.addEventListener("click", function () { api.openLesson(lesson); });
    const saved = document.createElement("span"); saved.className = "payment-save-mark"; saved.textContent = "Сохранено";
    actions.append(open, saved); actionCell.appendChild(actions);

    function saveChanges() {
      const amount = price.value.trim() === "" ? null : Number(price.value);
      if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 1000000)) { api.toast("Стоимость должна быть от 0 до 1 000 000 ₽", true); return; }
      let paidDate = paymentDate.value;
      if (payment.value === "paid" && !paidDate) paidDate = todayKey();
      if (payment.value !== "paid") paidDate = "";
      updateLessonPayment(lesson, { paymentAmount: amount, price: amount, paymentStatus: payment.value, paymentDate: paidDate, paymentComment: comment.value.trim() });
      saved.classList.add("is-visible");
      window.setTimeout(function () { saved.classList.remove("is-visible"); }, 1200);
      renderPayments();
    }
    [price, payment, paymentDate, comment].forEach(function (input) { input.addEventListener("change", saveChanges); });
    row.append(person, date, time, duration, status, priceCell, paymentCell, paymentDateCell, commentCell, actionCell);
    return row;
  }

  function updateLessonPayment(lesson, changes) {
    const data = state();
    const timestamp = new Date().toISOString();
    applyPaymentUpdate(data, lesson, changes, uuid, timestamp);
    api.save();
  }

  function applyPaymentUpdate(data, lesson, changes, idFactory, timestamp) {
    const updatedAt = timestamp || new Date().toISOString();
    if (!lesson.recurring) {
      const stored = data.singleLessons.find(function (item) { return item.id === lesson.id; });
      if (stored) {
        Object.assign(stored, changes, { updatedAt });
        return stored;
      }
    } else {
      let exception = data.occurrenceExceptions.find(function (item) { return item.seriesId === lesson.seriesId && item.originalStartUtc === lesson.originalStartUtc; });
      if (!exception) {
        exception = { id: (idFactory || uuid)(), seriesId: lesson.seriesId, originalStartUtc: lesson.originalStartUtc, kind: "overridden", overrides: {}, createdAt: updatedAt, updatedAt };
        data.occurrenceExceptions.push(exception);
      }
      exception.overrides = Object.assign({}, exception.overrides || {}, changes);
      exception.updatedAt = updatedAt;
      return exception;
    }
    return null;
  }

  function openReportDialog() {
    populateParticipants();
    if (!state().participants.length) { api.toast("Сначала добавьте ученика или группу", true); return; }
    const preferred = el.paymentParticipantFilter.value;
    el.reportParticipant.value = preferred || state().participants[0].id;
    el.reportType.value = "month";
    el.reportMonth.value = el.paymentMonthFilter.value || currentMonthValue();
    const bounds = monthBounds(el.reportMonth.value);
    el.reportStartDate.value = bounds ? bounds.start : todayKey();
    el.manualStartDate.value = bounds ? bounds.start : todayKey();
    el.manualEndDate.value = bounds ? bounds.end : todayKey();
    el.manualLessonStatus.value = "";
    el.manualPaymentStatus.value = "";
    allowShortPackage = false;
    syncReportType(true);
    el.reportDialog.showModal();
  }

  function syncReportType(resetSelection) {
    const type = el.reportType.value;
    el.reportMonthField.hidden = type !== "month";
    el.reportStartField.hidden = type !== "package4" && type !== "package10";
    el.manualReportControls.hidden = type !== "manual";
    el.reportShortage.hidden = true;
    allowShortPackage = false;
    buildReportCandidates(resetSelection !== false);
  }

  function buildReportCandidates(resetSelection) {
    const participantId = el.reportParticipant.value;
    const type = el.reportType.value;
    let candidates = [];
    let initiallySelected = [];
    if (!participantId) {
      reportCandidates = [];
      reportSelectedIds.clear();
      renderReportSelection();
      return;
    }
    if (type === "month") {
      const bounds = monthBounds(el.reportMonth.value);
      if (bounds) candidates = lessonsForRange(state(), bounds.start, bounds.end, state().settings.displayOffsetMinutes).filter(function (lesson) { return lesson.participantId === participantId; });
      initiallySelected = candidates;
    } else if (type === "package4" || type === "package10") {
      const start = el.reportStartDate.value || todayKey();
      const all = lessonsForRange(state(), start, todayKey(), state().settings.displayOffsetMinutes).filter(function (lesson) { return lesson.participantId === participantId && lesson.lessonStatus === "completed"; });
      const size = type === "package4" ? 4 : 10;
      candidates = all;
      initiallySelected = selectPackage(all, start, size, todayKey());
      if (initiallySelected.length < size) showShortage(initiallySelected.length, size);
    } else {
      const start = el.manualStartDate.value;
      const end = el.manualEndDate.value;
      candidates = lessonsForRange(state(), start, end, state().settings.displayOffsetMinutes).filter(function (lesson) {
        if (lesson.participantId !== participantId) return false;
        const status = el.manualLessonStatus.value;
        if (status === "cancelled" && !isCancelled(lesson.lessonStatus)) return false;
        if (status && status !== "cancelled" && lesson.lessonStatus !== status) return false;
        const payment = el.manualPaymentStatus.value;
        if (payment && lesson.paymentStatus !== payment) return false;
        return true;
      });
      initiallySelected = [];
    }
    reportCandidates = uniqueLessons(candidates);
    if (resetSelection) reportSelectedIds = new Set(initiallySelected.map(function (lesson) { return lesson.instanceId; }));
    else reportSelectedIds = new Set(Array.from(reportSelectedIds).filter(function (id) { return reportCandidates.some(function (lesson) { return lesson.instanceId === id; }); }));
    renderReportSelection();
  }

  function showShortage(found, required) {
    el.reportShortage.hidden = false;
    el.reportShortageText.textContent = `Для выбранного периода найдено только ${found} из ${required} проведённых занятий. Выберите другую дату начала или сформируйте отчёт по доступным занятиям.`;
  }

  function renderReportSelection() {
    el.reportSelectionList.replaceChildren();
    if (!reportCandidates.length) {
      const empty = document.createElement("p"); empty.className = "report-selection-empty"; empty.textContent = "Подходящих занятий не найдено."; el.reportSelectionList.appendChild(empty);
    }
    reportCandidates.forEach(function (lesson) {
      const label = document.createElement("label"); label.className = "report-lesson-option";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = reportSelectedIds.has(lesson.instanceId);
      check.addEventListener("change", function () { if (check.checked) reportSelectedIds.add(lesson.instanceId); else reportSelectedIds.delete(lesson.instanceId); updateReportSelectionCount(); });
      const date = document.createElement("time"); date.textContent = D.formatDateShort(lesson.displayDateKey);
      const name = document.createElement("span"); name.className = "report-option-name"; name.textContent = `${lesson.displayTime} · ${lesson.course || participantName(lesson.participantId)}`;
      const status = document.createElement("span"); status.textContent = lessonStatusLabel(lesson);
      const payment = document.createElement("span"); payment.className = "payment-status-label"; payment.textContent = `${money(paymentAmount(lesson))} · ${PAYMENT_LABELS[lesson.paymentStatus] || "Не оплачено"}`;
      label.append(check, date, name, status, payment); el.reportSelectionList.appendChild(label);
    });
    updateReportSelectionCount();
  }

  function updateReportSelectionCount() { el.reportSelectionCount.textContent = `${reportSelectedIds.size} выбрано`; }

  function selectedReportLessons() {
    return reportCandidates.filter(function (lesson) { return reportSelectedIds.has(lesson.instanceId); }).sort(lessonSort);
  }

  function createDraftFromSelection() {
    const lessons = selectedReportLessons();
    if (!lessons.length) { api.toast("Выберите хотя бы одно занятие", true); return null; }
    const type = el.reportType.value;
    const required = type === "package4" ? 4 : type === "package10" ? 10 : 0;
    if (required && lessons.length < required && !allowShortPackage) { showShortage(lessons.length, required); return null; }
    const snapshots = lessons.map(snapshotLesson);
    const totals = finalizeTotals(calculateTotals(snapshots));
    return {
      id: null,
      participantId: el.reportParticipant.value,
      participantName: participantName(el.reportParticipant.value),
      type,
      month: type === "month" ? el.reportMonth.value : "",
      startDate: snapshots[0].displayDateKey,
      endDate: snapshots[snapshots.length - 1].displayDateKey,
      lessonIds: snapshots.map(function (lesson) { return lesson.instanceId; }),
      lessonSnapshot: snapshots,
      lessonCount: snapshots.length,
      accrued: totals.accrued,
      paid: totals.paid,
      due: totals.due,
      createdAt: new Date().toISOString()
    };
  }

  function openPreview(draft, fromHistory) {
    reportDraft = draft;
    previewFromHistory = Boolean(fromHistory);
    renderPreview();
    if (el.reportDialog.open) el.reportDialog.close();
    el.reportPreviewDialog.showModal();
  }

  function renderPreview() {
    const draft = reportDraft;
    if (!draft) return;
    const totals = finalizeTotals(calculateTotals(draft.lessonSnapshot));
    draft.lessonCount = draft.lessonSnapshot.length;
    draft.lessonIds = draft.lessonSnapshot.map(function (lesson) { return lesson.instanceId; });
    draft.startDate = draft.lessonSnapshot.length ? draft.lessonSnapshot[0].displayDateKey : "";
    draft.endDate = draft.lessonSnapshot.length ? draft.lessonSnapshot[draft.lessonSnapshot.length - 1].displayDateKey : "";
    Object.assign(draft, { accrued: totals.accrued, paid: totals.paid, due: totals.due });
    el.reportPreviewContent.innerHTML = `
      <div class="preview-meta">
        <div><span>Ученик / группа</span><strong>${escapeHtml(draft.participantName)}</strong></div>
        <div><span>Тип отчёта</span><strong>${escapeHtml(REPORT_LABELS[draft.type] || draft.type)}</strong></div>
        <div><span>Период</span><strong>${escapeHtml(reportPeriod(draft.startDate, draft.endDate))}</strong></div>
        <div><span>Количество</span><strong>${draft.lessonCount} ${lessonWord(draft.lessonCount)}</strong></div>
      </div>
      <div class="preview-finance"><div><span>Начислено</span><strong>${money(totals.accrued)}</strong></div><div><span>Оплачено</span><strong>${money(totals.paid)}</strong></div><div><span>К оплате</span><strong>${money(totals.due)}</strong></div></div>
      <div class="preview-lesson-list">${draft.lessonSnapshot.map(function (lesson) { return `<div class="preview-lesson-row" data-instance-id="${escapeHtml(lesson.instanceId)}"><time>${escapeHtml(D.formatDateShort(lesson.displayDateKey))} · ${escapeHtml(lesson.displayTime)}</time><span>${escapeHtml(lesson.course || draft.participantName)}</span><span>${escapeHtml(lessonStatusLabel(lesson))}</span><span>${money(paymentAmount(lesson))} · ${escapeHtml(PAYMENT_LABELS[lesson.paymentStatus] || "Не оплачено")}</span><button type="button" aria-label="Исключить занятие">×</button></div>`; }).join("")}</div>`;
    el.reportPreviewContent.querySelectorAll(".preview-lesson-row button").forEach(function (button) {
      button.addEventListener("click", function () {
        const row = button.closest(".preview-lesson-row");
        if (reportDraft.lessonSnapshot.length <= 1) { api.toast("В отчёте должно остаться хотя бы одно занятие", true); return; }
        reportDraft.lessonSnapshot = reportDraft.lessonSnapshot.filter(function (lesson) { return lesson.instanceId !== row.dataset.instanceId; });
        renderPreview();
      });
    });
  }

  function reportHeading(draft) {
    if (draft.type === "month" && draft.month) {
      const bounds = monthBounds(draft.month);
      return bounds ? `Отчёт по занятиям и оплате за ${MONTHS_NOMINATIVE[bounds.monthIndex].toLowerCase()} ${bounds.year} года` : "Отчёт по занятиям и оплате";
    }
    if (draft.type === "package4") return "Отчёт по пакету из 4 занятий";
    if (draft.type === "package10") return "Отчёт по пакету из 10 занятий";
    return "Отчёт по выбранным занятиям";
  }

  function reportFileName(draft) {
    const person = safeFilePart(draft.participantName);
    if (draft.type === "month" && draft.month) {
      const bounds = monthBounds(draft.month);
      return `Отчет_${person}_${MONTHS_NOMINATIVE[bounds.monthIndex]}_${bounds.year}.pdf`;
    }
    if (draft.type === "package4" || draft.type === "package10") {
      const amount = draft.type === "package4" ? 4 : 10;
      const unit = amount === 4 ? "занятия" : "занятий";
      return `Отчет_${person}_${amount}_${unit}_${dateFile(draft.startDate).slice(0,5)}-${dateFile(draft.endDate)}.pdf`;
    }
    return `Отчет_${person}_выбранные_занятия.pdf`;
  }

  function printableHtml(draft) {
    const totals = finalizeTotals(calculateTotals(draft.lessonSnapshot));
    const created = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date(draft.createdAt || Date.now()));
    const heading = reportHeading(draft);
    const period = draft.type === "month" ? heading.replace("Отчёт по занятиям и оплате ", "") : `Период: ${reportPeriod(draft.startDate, draft.endDate)}`;
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(reportFileName(draft))}</title><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box}body{margin:0;background:#f7f1e8;color:#29251f;font-family:"Segoe UI",Arial,sans-serif;font-size:11px;line-height:1.45}.report{max-width:180mm;margin:0 auto;background:#fffefa}.brand{display:flex;align-items:center;gap:9px;color:#a45f00;font-size:13px;font-weight:800;letter-spacing:.02em}.brand i{display:grid;width:30px;height:30px;place-items:center;border-radius:9px;background:#f5a20a;color:#332006;font-style:normal}h1{margin:18px 0 4px;font-size:25px;line-height:1.15;letter-spacing:-.03em}.subtitle{margin:0;color:#70685e}.identity{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:17px 0}.identity div,.metric{padding:11px;border:1px solid #e8dfd2;border-radius:10px;background:#fff}.identity span,.metric span{display:block;color:#8f867a;font-size:9px;text-transform:uppercase;letter-spacing:.06em}.identity strong,.metric strong{display:block;margin-top:4px;font-size:13px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}.metric.accent{background:#fff3d9;border-color:#f0d093}.metric strong{font-size:17px}table{width:100%;border-collapse:collapse;margin-top:15px;font-size:9px}thead{display:table-header-group}tr{break-inside:avoid}th{padding:8px 6px;background:#f3ece2;color:#6d655b;text-align:left;text-transform:uppercase;letter-spacing:.04em}td{padding:8px 6px;border-bottom:1px solid #ebe3d7;vertical-align:top}.paid{color:#438136;font-weight:700}.unpaid{color:#c04039;font-weight:700}.totals{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}.totals div{padding:11px;border-radius:9px;background:#f5efe6}.totals div:last-child{background:#ffedc7}.totals span,.totals strong{display:block}.totals span{color:#81786d;font-size:9px}.totals strong{margin-top:3px;font-size:15px}.footer{margin-top:19px;padding-top:12px;border-top:1px solid #e5dccf;color:#70685e}.thanks{margin-top:8px;color:#4f4941}.print-actions{position:fixed;right:20px;bottom:20px;display:flex;gap:8px}.print-actions button{padding:10px 16px;border:0;border-radius:9px;background:#f5a20a;color:#2e1d04;font-weight:700;box-shadow:0 8px 18px rgba(180,106,0,.25)}@media print{body{background:#fff}.report{max-width:none}.print-actions{display:none}thead{display:table-header-group}}
    </style></head><body><main class="report"><div class="brand"><i>TC</i>Teacher Calendar</div><h1>${escapeHtml(heading)}</h1><p class="subtitle">${escapeHtml(period)}</p><section class="identity"><div><span>Ученик / группа</span><strong>${escapeHtml(draft.participantName)}</strong></div><div><span>Преподаватель</span><strong>Lilia Penskikh</strong></div></section><section class="metrics"><div class="metric"><span>Количество занятий</span><strong>${draft.lessonSnapshot.length}</strong></div><div class="metric"><span>Проведено</span><strong>${totals.completed}</strong></div><div class="metric"><span>Отменено</span><strong>${totals.cancelled}</strong></div><div class="metric accent"><span>Начислено</span><strong>${money(totals.accrued)}</strong></div><div class="metric"><span>Оплачено</span><strong>${money(totals.paid)}</strong></div><div class="metric accent"><span>Осталось оплатить</span><strong>${money(totals.due)}</strong></div></section><table><thead><tr><th>Дата</th><th>Время</th><th>Мин.</th><th>Статус занятия</th><th>Стоимость</th><th>Оплата</th><th>Дата оплаты</th></tr></thead><tbody>${draft.lessonSnapshot.map(function (lesson) { return `<tr><td>${escapeHtml(D.formatDateShort(lesson.displayDateKey))}</td><td>${escapeHtml(lesson.displayTime)}</td><td>${Number(lesson.durationMinutes || 0)}</td><td>${escapeHtml(lessonStatusLabel(lesson))}</td><td>${money(paymentAmount(lesson))}</td><td class="${lesson.paymentStatus === "paid" ? "paid" : "unpaid"}">${escapeHtml(PAYMENT_LABELS[lesson.paymentStatus] || "Не оплачено")}</td><td>${escapeHtml(lesson.paymentDate ? D.formatDateShort(lesson.paymentDate) : "—")}</td></tr>`; }).join("")}</tbody></table><section class="totals"><div><span>Итого начислено</span><strong>${money(totals.accrued)}</strong></div><div><span>Оплачено</span><strong>${money(totals.paid)}</strong></div><div><span>К оплате</span><strong>${money(totals.due)}</strong></div></section><footer class="footer"><div>Дата формирования: ${escapeHtml(created)}</div><div class="thanks">Спасибо! Если у вас возникли вопросы по отчёту, пожалуйста, свяжитесь с преподавателем.</div></footer></main><div class="print-actions"><button type="button" onclick="window.print()">Печать / Сохранить как PDF</button></div></body></html>`;
  }

  function openPrintWindow(draft) {
    const popup = window.open("", "_blank");
    if (!popup) { api.toast("Браузер заблокировал окно отчёта. Разрешите всплывающие окна для этого файла.", true); return false; }
    popup.document.open(); popup.document.write(printableHtml(draft)); popup.document.close(); popup.focus();
    window.setTimeout(function () { popup.print(); }, 250);
    return true;
  }

  function saveDraftToHistory(draft) {
    const stored = Object.assign({}, draft, { id: uuid(), createdAt: new Date().toISOString(), lessonSnapshot: draft.lessonSnapshot.map(function (lesson) { return Object.assign({}, lesson); }) });
    state().reportHistory.unshift(stored);
    api.save();
    reportDraft = stored;
    renderHistory();
    return stored;
  }

  function renderHistory() {
    const history = state().reportHistory || [];
    el.reportHistoryList.replaceChildren();
    el.reportHistoryEmpty.hidden = Boolean(history.length);
    el.reportHistoryCount.textContent = `${history.length} отчётов`;
    history.forEach(function (report) {
      const item = document.createElement("article"); item.className = "report-history-item";
      const copy = document.createElement("div"); copy.innerHTML = `<strong>${escapeHtml(report.participantName || participantName(report.participantId))} · ${escapeHtml(REPORT_LABELS[report.type] || report.type)}</strong><small>${escapeHtml(reportPeriod(report.startDate, report.endDate))} · ${report.lessonCount} ${lessonWord(report.lessonCount)}</small>`;
      const finance = document.createElement("div"); finance.className = "report-history-money"; finance.innerHTML = `<b>${money(report.accrued)}</b>Создан ${escapeHtml(new Intl.DateTimeFormat("ru-RU").format(new Date(report.createdAt)))}`;
      const actions = document.createElement("div"); actions.className = "report-history-actions";
      const repeat = document.createElement("button"); repeat.type = "button"; repeat.className = "primary-button"; repeat.textContent = "Сформировать повторно"; repeat.addEventListener("click", function () { openPrintWindow(report); });
      const view = document.createElement("button"); view.type = "button"; view.className = "secondary-button"; view.textContent = "Просмотреть"; view.addEventListener("click", function () { openPreview(JSON.parse(JSON.stringify(report)), true); });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button"; remove.textContent = "Удалить"; remove.addEventListener("click", function () { if (!window.confirm("Удалить отчёт из истории? Сами уроки и оплаты останутся.")) return; state().reportHistory = state().reportHistory.filter(function (item) { return item.id !== report.id; }); api.save(); renderHistory(); });
      actions.append(repeat, view, remove); item.append(copy, finance, actions); el.reportHistoryList.appendChild(item);
    });
  }

  function csvEscape(value) {
    let text = String(value == null ? "" : value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  function buildCsv(lessons, nameResolver) {
    const resolveName = typeof nameResolver === "function" ? nameResolver : participantName;
    const rows = [["Ученик", "Дата", "Время", "Продолжительность", "Статус занятия", "Стоимость", "Статус оплаты", "Дата оплаты", "Комментарий"]];
    lessons.forEach(function (lesson) {
      rows.push([resolveName(lesson.participantId), D.formatDateShort(lesson.displayDateKey), lesson.displayTime, lesson.durationMinutes, lessonStatusLabel(lesson), paymentAmount(lesson), PAYMENT_LABELS[lesson.paymentStatus] || "Не оплачено", lesson.paymentDate ? D.formatDateShort(lesson.paymentDate) : "", lesson.paymentComment || ""]);
    });
    return "\ufeff" + rows.map(function (row) { return row.map(csvEscape).join(";"); }).join("\r\n");
  }

  function downloadCsv(start, end, filename) {
    const lessons = lessonsForRange(state(), start, end, state().settings.displayOffsetMinutes);
    const blob = new Blob([buildCsv(lessons)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    api.toast(`Экспортировано занятий: ${lessons.length}`);
  }

  function openCsvDialog() {
    el.csvMonth.value = el.paymentMonthFilter.value || currentMonthValue();
    const bounds = monthBounds(el.csvMonth.value);
    el.csvStartDate.value = bounds ? bounds.start : todayKey();
    el.csvEndDate.value = bounds ? bounds.end : todayKey();
    el.csvForm.querySelector('input[name="csvScope"][value="month"]').checked = true;
    syncCsvScope(); el.csvDialog.showModal();
  }
  function syncCsvScope() {
    const scope = el.csvForm.querySelector('input[name="csvScope"]:checked').value;
    el.csvMonthField.hidden = scope !== "month";
    el.csvStartField.hidden = scope !== "range";
    el.csvEndField.hidden = scope !== "range";
  }

  function attachEvents() {
    el.paymentParticipantFilter.addEventListener("change", renderPayments);
    el.paymentMonthFilter.addEventListener("change", renderPayments);
    el.createReportButton.addEventListener("click", openReportDialog);
    el.exportPaymentsButton.addEventListener("click", openCsvDialog);
    el.reportDialogClose.addEventListener("click", function () { el.reportDialog.close(); });
    el.reportCancel.addEventListener("click", function () { el.reportDialog.close(); });
    el.reportType.addEventListener("change", function () { syncReportType(true); });
    [el.reportParticipant, el.reportMonth, el.reportStartDate, el.manualStartDate, el.manualEndDate, el.manualLessonStatus, el.manualPaymentStatus].forEach(function (input) { input.addEventListener("change", function () { allowShortPackage = false; buildReportCandidates(true); }); });
    el.manualSelectAll.addEventListener("click", function () { reportSelectedIds = new Set(reportCandidates.map(function (lesson) { return lesson.instanceId; })); renderReportSelection(); });
    el.manualSelectNone.addEventListener("click", function () { reportSelectedIds.clear(); renderReportSelection(); });
    el.manualCompletedOnly.addEventListener("click", function () { reportSelectedIds = new Set(reportCandidates.filter(function (lesson) { return lesson.lessonStatus === "completed"; }).map(function (lesson) { return lesson.instanceId; })); renderReportSelection(); });
    el.changeReportStart.addEventListener("click", function () { el.reportShortage.hidden = true; el.reportStartDate.focus(); });
    el.useAvailableLessons.addEventListener("click", function () { allowShortPackage = true; const draft = createDraftFromSelection(); if (draft) openPreview(draft, false); });
    el.cancelShortReport.addEventListener("click", function () { el.reportShortage.hidden = true; });
    el.reportForm.addEventListener("submit", function (event) { event.preventDefault(); const draft = createDraftFromSelection(); if (draft) openPreview(draft, false); });
    el.reportPreviewClose.addEventListener("click", function () { el.reportPreviewDialog.close(); });
    el.reportPreviewBack.addEventListener("click", function () { el.reportPreviewDialog.close(); if (!previewFromHistory) el.reportDialog.showModal(); });
    el.printReportButton.addEventListener("click", function () {
      if (!reportDraft || !reportDraft.lessonSnapshot.length) return;
      if (openPrintWindow(reportDraft)) {
        if (!previewFromHistory) saveDraftToHistory(reportDraft);
        api.toast("Открылось окно печати. Выберите «Сохранить как PDF».");
        previewFromHistory = true;
      }
    });
    el.csvDialogClose.addEventListener("click", function () { el.csvDialog.close(); });
    el.csvCancel.addEventListener("click", function () { el.csvDialog.close(); });
    el.csvForm.querySelectorAll('input[name="csvScope"]').forEach(function (radio) { radio.addEventListener("change", syncCsvScope); });
    el.csvForm.addEventListener("submit", function (event) {
      event.preventDefault();
      const scope = el.csvForm.querySelector('input[name="csvScope"]:checked').value;
      if (scope === "month") {
        const bounds = monthBounds(el.csvMonth.value);
        if (!bounds) { api.toast("Выберите месяц", true); return; }
        downloadCsv(bounds.start, bounds.end, `Оплаты_${MONTHS_NOMINATIVE[bounds.monthIndex]}_${bounds.year}.csv`);
      } else {
        const start = el.csvStartDate.value; const end = el.csvEndDate.value;
        if (!D.parseDateKey(start) || !D.parseDateKey(end) || start > end) { api.toast("Укажите корректный период", true); return; }
        const startParts = D.parseDateKey(start); const endParts = D.parseDateKey(end);
        const startLabel = startParts.year === endParts.year ? dateFile(start).slice(0, 5) : dateFile(start);
        downloadCsv(start, end, `Оплаты_${startLabel}-${dateFile(end)}.csv`);
      }
      el.csvDialog.close();
    });
  }

  function init(appApi) {
    api = appApi;
    cacheElements();
    el.paymentMonthFilter.value = currentMonthValue();
    el.reportMonth.value = currentMonthValue();
    el.csvMonth.value = currentMonthValue();
    attachEvents();
  }

  function open() { renderPayments(); }
  function refresh() { if (el.paymentPanel && !el.paymentPanel.hidden) renderPayments(); }

  TC.Payments = { init, open, refresh, lessonsForRange, calculateTotals: function (lessons) { return finalizeTotals(calculateTotals(lessons)); }, selectPackage, buildCsv, uniqueLessons, printableHtml, reportFileName, applyPaymentUpdate };
})();
