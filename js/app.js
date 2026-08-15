(function () {
  "use strict";

  const TC = window.TeacherCalendar;
  const D = TC.Dates;
  const Storage = TC.Storage;
  const Recurrence = TC.Recurrence;

  const STATUS_LABELS = {
    scheduled: "Запланировано",
    completed: "Проведено",
    cancelled_student: "Отменено учеником",
    cancelled_teacher: "Отменено преподавателем",
    moved: "Перенесено",
    missed: "Пропущено"
  };
  const PAYMENT_LABELS = { unpaid: "Не оплачено", paid: "Оплачено", not_required: "Не требуется" };
  const FORMAT_LABELS = { online: "Онлайн", offline: "Очно", hybrid: "Смешанный" };
  const CANCELLED_STATUSES = new Set(["cancelled_student", "cancelled_teacher"]);

  const loaded = Storage.load();
  let state = loaded.state;
  let viewMonth = D.monthFromToday(state.settings.displayOffsetMinutes);
  let selectedDayKey = D.todayKey(state.settings.displayOffsetMinutes);
  let visibleLessons = [];
  let filteredLessons = [];
  let selectedInstanceId = null;
  let lessonFormContext = null;
  let dialogDirty = false;
  let undoSnapshot = null;
  let undoTimer = null;
  let highlightedCopyIds = new Set();
  let copyHighlightTimer = null;

  const el = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      "appShell", "mainView", "sidebar", "sidebarOpen", "paymentSidebarOpen", "sidebarClose", "pageOverlay", "monthTitle", "monthGrid",
      "calendarNavButton", "paymentsNavButton", "calendarTopbar", "calendarPanel", "paymentPanel",
      "monthViewButton", "weekViewButton",
      "todayButton", "prevMonthButton", "nextMonthButton", "weekPicker", "localClock", "moscowClock", "timezoneLabel",
      "timezoneLeft", "timezoneRight", "addLessonButton", "participantFilters", "allParticipantsFilter",
      "typeFilter", "statusFilter", "paymentFilter", "clearFiltersButton", "manageParticipantsButton",
      "lessonDrawer", "lessonDialog", "lessonForm", "lessonDialogTitle", "lessonParticipant", "lessonCourse", "lessonDate",
      "lessonTime", "lessonDuration", "lessonSourceTimezone", "customDurationField", "customDuration", "lessonFormat", "lessonFormatNote",
      "lessonStatus", "lessonPayment", "lessonPaymentAmount", "lessonHomework", "lessonRepeat", "repeatFields", "repeatFrequency",
      "weekdayPicker", "repeatUntil", "editScopeCard", "conflictWarning", "conflictWarningText", "confirmConflict",
      "participantsDialog", "participantSearch", "participantTypeView", "participantCardList", "participantForm",
      "participantFormTitle", "participantEditId", "participantType", "participantName", "participantNameError",
      "participantColor", "participantNote", "participantDefaultCourse", "participantDefaultDuration",
      "participantDefaultFormat", "participantDefaultPaymentAmount", "participantDefaultPayment",
      "participantDefaultHomework", "participantFormReset", "participantSaveAndLesson", "participantSaveOnly",
      "moveDialog", "moveForm", "moveDate",
      "moveTime", "moveScopeCard", "cancelDialog", "cancelForm", "cancelReason", "cancelScopeCard",
      "deleteDialog", "deleteForm", "deleteDialogCopy", "deleteSeriesOption", "dayDialog", "dayDialogTitle",
      "dayLessonList", "addLessonForDay", "exportButton", "importButton", "resetButton", "importFileInput",
      "toastRegion"
    ].forEach(function (id) { el[id] = byId(id); });
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function participantById(id) {
    return state.participants.find(function (item) { return item.id === id; }) || null;
  }

  function seriesById(id) {
    return state.series.find(function (item) { return item.id === id; }) || null;
  }

  function selectedLesson() {
    return visibleLessons.find(function (lesson) { return lesson.instanceId === selectedInstanceId; }) || null;
  }

  function statusClass(status) {
    return `status-${status || "scheduled"}`;
  }

  function isCancelled(status) {
    return CANCELLED_STATUSES.has(status);
  }

  function persist(showError) {
    const result = Storage.save(state);
    if (!result.ok && showError !== false) showToast("Не удалось сохранить данные в localStorage. Сделайте экспорт резервной копии.", { error: true, duration: 7000 });
    return result.ok;
  }

  function mutate(mutator, message) {
    mutator();
    persist();
    renderAll();
    if (message) showToast(message);
  }

  function setUndoPoint() {
    undoSnapshot = Storage.clone(state);
    window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(function () { undoSnapshot = null; }, 6500);
  }

  function showUndoToast(message) {
    showToast(message, {
      duration: 6000,
      actionLabel: "Отменить",
      onAction: function () {
        if (!undoSnapshot) return;
        state = undoSnapshot;
        undoSnapshot = null;
        window.clearTimeout(undoTimer);
        persist();
        renderAll();
        showToast("Удаление отменено");
      }
    });
  }

  function showToast(message, options) {
    options = options || {};
    const toast = document.createElement("div");
    toast.className = `toast${options.error ? " is-error" : ""}`;
    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);
    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      toast.remove();
    }
    if (options.actionLabel && options.onAction) {
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = options.actionLabel;
      action.addEventListener("click", function () { options.onAction(); dismiss(); });
      toast.appendChild(action);
    }
    el.toastRegion.appendChild(toast);
    window.setTimeout(dismiss, options.duration || 3500);
  }

  function optionElement(value, label, selected) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = Boolean(selected);
    return option;
  }

  function setSelectOptions(select, labels, selectedValue) {
    select.replaceChildren();
    Object.keys(labels).forEach(function (value) {
      select.appendChild(optionElement(value, labels[value], value === selectedValue));
    });
  }

  function renderClock() {
    const offset = state.settings.displayOffsetMinutes;
    el.localClock.textContent = D.clockTime(offset);
    el.moscowClock.textContent = D.clockTime(180);
    el.timezoneLabel.textContent = timezoneLabel(offset);
    el.timezoneLeft.disabled = offset <= -720;
    el.timezoneRight.disabled = offset >= 840;
  }

  function timezoneLabel(offsetMinutes) {
    const offset = Number(offsetMinutes || 0);
    if (offset === 300) return `Екатеринбург · ${D.offsetLabel(offset)}`;
    if (offset === 180) return `Москва · ${D.offsetLabel(offset)}`;
    return D.offsetLabel(offset);
  }

  function setLessonSourceTimezone(offsetMinutes) {
    const offset = Number(offsetMinutes);
    const normalizedOffset = Number.isFinite(offset) ? offset : 300;
    el.lessonSourceTimezone.querySelectorAll("option[data-legacy]").forEach(function (option) { option.remove(); });
    if (![180, 300].includes(normalizedOffset)) {
      const legacy = optionElement(String(normalizedOffset), `${D.offsetLabel(normalizedOffset)} · сохранённый пояс`, true);
      legacy.dataset.legacy = "true";
      el.lessonSourceTimezone.appendChild(legacy);
    }
    el.lessonSourceTimezone.value = String(normalizedOffset);
  }

  function shiftTimezone(amount) {
    const previousToday = D.todayKey(state.settings.displayOffsetMinutes);
    const next = Math.max(-720, Math.min(840, state.settings.displayOffsetMinutes + amount));
    if (next === state.settings.displayOffsetMinutes) return;
    state.settings.displayOffsetMinutes = next;
    if (selectedDayKey === previousToday) {
      selectedDayKey = D.todayKey(next);
      const todayParts = D.parseDateKey(selectedDayKey);
      viewMonth = { year: todayParts.year, monthIndex: todayParts.monthIndex };
    }
    persist();
    renderAll();
  }

  function activeParticipantIds() {
    return state.participants.filter(function (item) { return !item.archived; }).map(function (item) { return item.id; });
  }

  function renderFilters() {
    const filters = state.settings.filters;
    const selected = filters.participantIds;
    el.allParticipantsFilter.checked = selected.length === 0;
    el.participantFilters.replaceChildren();

    const sorted = state.participants.slice().sort(function (a, b) {
      return Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, "ru");
    });
    if (!sorted.length) {
      const empty = document.createElement("p");
      empty.className = "empty-filter-note";
      empty.textContent = "Пока никого нет";
      el.participantFilters.appendChild(empty);
    }
    sorted.forEach(function (participant) {
      const label = document.createElement("label");
      label.className = "check-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = participant.id;
      input.checked = selected.length === 0 || selected.includes(participant.id);
      input.addEventListener("change", function () { toggleParticipantFilter(participant.id, input.checked); });
      const check = document.createElement("span");
      check.className = "custom-check";
      check.setAttribute("aria-hidden", "true");
      const dot = document.createElement("span");
      dot.className = "participant-filter-dot";
      dot.style.backgroundColor = participant.color;
      const name = document.createElement("span");
      name.className = "participant-filter-name";
      name.textContent = participant.archived ? `${participant.name} · архив` : participant.name;
      label.append(input, check, dot, name);
      el.participantFilters.appendChild(label);
    });

    el.typeFilter.value = filters.participantTypes[0] || "";
    el.statusFilter.value = filters.lessonStatuses[0] || "";
    el.paymentFilter.value = filters.paymentStatuses[0] || "";
  }

  function toggleParticipantFilter(id, checked) {
    const allIds = state.participants.map(function (participant) { return participant.id; });
    let selected = state.settings.filters.participantIds.slice();
    if (selected.length === 0) selected = allIds.slice();
    else selected = selected.filter(function (item) { return allIds.includes(item); });
    if (checked && !selected.includes(id)) selected.push(id);
    if (!checked) selected = selected.filter(function (item) { return item !== id; });
    state.settings.filters.participantIds = selected.length === allIds.length ? [] : (selected.length ? selected : ["__none__"]);
    persist(false);
    renderAll();
  }

  function clearFilters() {
    state.settings.filters = { participantIds: [], participantTypes: [], lessonStatuses: [], paymentStatuses: [] };
    persist(false);
    renderAll();
  }

  function lessonPassesFilters(lesson) {
    const filters = state.settings.filters;
    const participant = participantById(lesson.participantId);
    if (filters.participantIds.length && !filters.participantIds.includes(lesson.participantId)) return false;
    if (filters.participantTypes.length && (!participant || !filters.participantTypes.includes(participant.type))) return false;
    if (filters.lessonStatuses.length && !filters.lessonStatuses.includes(lesson.lessonStatus)) return false;
    if (filters.paymentStatuses.length && !filters.paymentStatuses.includes(lesson.paymentStatus)) return false;
    return true;
  }

  function renderCalendar() {
    const isWeekView = state.settings.calendarView === "week";
    const grid = isWeekView ? D.getWeekGrid(selectedDayKey) : D.getMonthGrid(viewMonth.year, viewMonth.monthIndex);
    el.monthTitle.textContent = isWeekView ? D.formatWeekTitle(grid) : D.formatMonthTitle(viewMonth.year, viewMonth.monthIndex);
    el.weekPicker.value = D.weekInputValue(selectedDayKey);
    el.calendarPanel.setAttribute("aria-label", isWeekView ? "Недельный календарь" : "Месячный календарь");
    el.monthGrid.classList.toggle("is-week-view", isWeekView);
    el.monthViewButton.classList.toggle("is-active", !isWeekView);
    el.weekViewButton.classList.toggle("is-active", isWeekView);
    el.monthViewButton.setAttribute("aria-pressed", String(!isWeekView));
    el.weekViewButton.setAttribute("aria-pressed", String(isWeekView));
    el.prevMonthButton.setAttribute("aria-label", isWeekView ? "Предыдущая неделя" : "Предыдущий месяц");
    el.nextMonthButton.setAttribute("aria-label", isWeekView ? "Следующая неделя" : "Следующий месяц");
    visibleLessons = Recurrence.expand(state, grid, state.settings.displayOffsetMinutes);
    filteredLessons = visibleLessons.filter(lessonPassesFilters);
    const grouped = new Map();
    filteredLessons.forEach(function (lesson) {
      if (!grouped.has(lesson.displayDateKey)) grouped.set(lesson.displayDateKey, []);
      grouped.get(lesson.displayDateKey).push(lesson);
    });

    el.monthGrid.replaceChildren();
    const today = D.todayKey(state.settings.displayOffsetMinutes);
    const maxVisible = isWeekView ? 14 : 7;

    grid.forEach(function (cell) {
      const day = document.createElement("div");
      day.className = "day-cell";
      if (!cell.inMonth) day.classList.add("is-outside");
      if (cell.weekday >= 6) day.classList.add("is-weekend");
      if (cell.key === today) day.classList.add("is-today");
      if (cell.key === selectedDayKey) day.classList.add("is-selected");
      day.dataset.date = cell.key;
      day.setAttribute("role", "gridcell");
      day.setAttribute("tabindex", "0");
      day.setAttribute("aria-label", D.formatDateLong(cell.key, true));

      const header = document.createElement("div");
      header.className = "day-header";
      const number = document.createElement("span");
      number.className = "day-number";
      number.textContent = String(cell.day);
      header.appendChild(number);

      const dayLessons = grouped.get(cell.key) || [];
      if (!isWeekView && dayLessons.length >= 3) day.classList.add("is-compact");
      if (!isWeekView && dayLessons.length >= 4) day.classList.add("is-crowded");
      if (dayLessons.length) {
        day.setAttribute("aria-label", `${D.formatDateLong(cell.key, true)}. Уроков: ${dayLessons.length}`);
        const summary = document.createElement("span");
        summary.className = "day-summary";
        summary.textContent = String(dayLessons.length);
        summary.title = `Всего уроков: ${dayLessons.length}`;
        header.appendChild(summary);
      }
      day.appendChild(header);

      const eventList = document.createElement("div");
      eventList.className = "day-events";
      dayLessons.slice(0, maxVisible).forEach(function (lesson) { eventList.appendChild(createLessonChip(lesson)); });
      if (dayLessons.length > maxVisible) {
        const more = document.createElement("button");
        more.className = "more-lessons";
        more.type = "button";
        more.textContent = `+ ещё ${dayLessons.length - maxVisible}`;
        more.addEventListener("click", function (event) { event.stopPropagation(); openDayDialog(cell.key); });
        eventList.appendChild(more);
      }
      day.appendChild(eventList);

      const dots = document.createElement("div");
      dots.className = "mobile-dots";
      dayLessons.slice(0, 2).forEach(function (lesson) {
        const dot = document.createElement("i");
        dot.className = "mobile-dot";
        dot.style.setProperty("--status-color", statusColor(lesson.lessonStatus));
        const mobileParticipant = participantById(lesson.participantId);
        dot.style.setProperty("--participant-color", mobileParticipant ? mobileParticipant.color : "#928b82");
        dots.appendChild(dot);
      });
      if (dayLessons.length > 2) {
        const count = document.createElement("small");
        count.className = "mobile-count";
        count.textContent = `+${dayLessons.length - 2}`;
        dots.appendChild(count);
      }
      day.appendChild(dots);

      day.addEventListener("click", function () { handleDayClick(cell); });
      day.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handleDayClick(cell); }
      });
      el.monthGrid.appendChild(day);
    });

    const existingEmpty = document.querySelector(".empty-calendar-message");
    if (existingEmpty) existingEmpty.remove();
    if (!state.participants.length && !visibleLessons.length) {
      const empty = document.createElement("div");
      empty.className = "empty-calendar-message";
      const copy = document.createElement("p");
      copy.textContent = "Добавьте ученика или группу, чтобы создать первое занятие.";
      const button = document.createElement("button");
      button.className = "primary-button";
      button.type = "button";
      button.textContent = "Добавить первую карточку";
      button.addEventListener("click", openParticipantsDialog);
      empty.append(copy, button);
      document.querySelector(".calendar-panel").appendChild(empty);
    }
  }

  function statusColor(status) {
    if (status === "completed") return "var(--completed)";
    if (isCancelled(status)) return "var(--cancelled)";
    if (status === "moved") return "var(--moved)";
    if (status === "missed") return "var(--missed)";
    return "var(--scheduled)";
  }

  function createLessonChip(lesson) {
    const participant = participantById(lesson.participantId);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `lesson-chip ${statusClass(lesson.lessonStatus)}${lesson.instanceId === selectedInstanceId ? " is-selected" : ""}${highlightedCopyIds.has(lesson.id) ? " is-copy-highlight" : ""}`;
    button.dataset.instanceId = lesson.instanceId;
    button.style.setProperty("--participant-color", participant ? participant.color : "#928b82");
    button.setAttribute("aria-label", `${lesson.displayTime}, ${participant ? participant.name : "Неизвестный участник"}, ${STATUS_LABELS[lesson.lessonStatus] || "урок"}`);
    const time = document.createElement("span");
    time.className = "lesson-chip-time";
    time.textContent = lesson.displayTime;
    const copy = document.createElement("span");
    copy.className = "lesson-chip-copy";
    const participantDot = document.createElement("i");
    participantDot.className = "lesson-chip-participant-dot";
    participantDot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "lesson-chip-name";
    name.textContent = participant ? participant.name : "Удалённый участник";
    copy.appendChild(name);
    const status = document.createElement("small");
    status.className = "lesson-chip-status";
    status.textContent = STATUS_LABELS[lesson.lessonStatus] || "Запланировано";
    copy.appendChild(status);
    const icons = document.createElement("span");
    icons.className = "lesson-chip-icons";
    if (lesson.recurring) icons.textContent += "↻";
    if (lesson.lessonStatus === "completed") icons.textContent += " ✓";
    if (lesson.lessonStatus === "moved") icons.textContent += " ↗";
    if (lesson.lessonStatus === "missed") icons.textContent += " !";
    if (isCancelled(lesson.lessonStatus)) icons.textContent += " ×";
    button.append(time, participantDot, copy, icons);
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      selectLesson(lesson.instanceId);
    });
    return button;
  }

  function handleDayClick(cell) {
    selectedDayKey = cell.key;
    if (!cell.inMonth) {
      viewMonth = { year: cell.year, monthIndex: cell.monthIndex };
      renderAll();
      return;
    }
    if (window.matchMedia("(max-width: 767px)").matches) openDayDialog(cell.key);
    else openNewLessonDialog(cell.key);
  }

  function selectLesson(instanceId) {
    selectedInstanceId = instanceId;
    renderCalendar();
    renderDrawer();
    syncOverlay();
  }

  function closeDrawer() {
    selectedInstanceId = null;
    el.appShell.classList.remove("has-detail");
    el.lessonDrawer.setAttribute("aria-hidden", "true");
    renderCalendar();
    syncOverlay();
  }

  function showCalendarSection() {
    el.mainView.classList.remove("is-payment-view");
    el.calendarTopbar.hidden = false;
    el.calendarPanel.hidden = false;
    el.paymentPanel.hidden = true;
    el.calendarNavButton.classList.add("is-active");
    el.paymentsNavButton.classList.remove("is-active");
    closeSidebar();
  }

  function showPaymentsSection() {
    closeDrawer();
    el.calendarTopbar.hidden = true;
    el.calendarPanel.hidden = true;
    el.paymentPanel.hidden = false;
    el.mainView.classList.add("is-payment-view");
    el.calendarNavButton.classList.remove("is-active");
    el.paymentsNavButton.classList.add("is-active");
    closeSidebar();
    if (TC.Payments) TC.Payments.open();
  }

  function openLessonFromPayments(lesson) {
    if (!lesson || !lesson.displayDateKey) return;
    showCalendarSection();
    selectedDayKey = lesson.displayDateKey;
    const parts = D.parseDateKey(selectedDayKey);
    if (parts) viewMonth = { year: parts.year, monthIndex: parts.monthIndex };
    renderAll();
    const visible = visibleLessons.find(function (item) { return item.instanceId === lesson.instanceId; });
    if (visible) selectLesson(visible.instanceId);
    else showToast("Урок не найден в текущем расписании", { error: true });
  }

  function makeDrawerSelect(labels, selected, field) {
    const wrapper = document.createElement("label");
    wrapper.className = "drawer-select-field";
    const caption = document.createElement("span");
    caption.textContent = field === "lessonStatus" ? "Статус" : "Статус оплаты";
    const select = document.createElement("select");
    select.setAttribute("aria-label", field === "lessonStatus" ? "Статус занятия" : "Статус оплаты");
    Object.keys(labels).forEach(function (value) { select.appendChild(optionElement(value, labels[value], value === selected)); });
    select.addEventListener("change", function () { updateSelectedField(field, select.value); });
    wrapper.append(caption, select);
    return wrapper;
  }

  function formatPaymentAmount(value) {
    if (value == null || value === "" || !Number.isFinite(Number(value))) return "Сумма не указана";
    return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number(value))} ₽`;
  }

  function renderDrawer() {
    let lesson = selectedLesson();
    if (lesson && !filteredLessons.some(function (item) { return item.instanceId === lesson.instanceId; })) lesson = null;
    if (!lesson) {
      selectedInstanceId = null;
      el.appShell.classList.remove("has-detail");
      el.lessonDrawer.setAttribute("aria-hidden", "true");
      return;
    }
    const participant = participantById(lesson.participantId);
    const endUtc = D.endUtc(lesson.startUtc, lesson.durationMinutes);
    el.appShell.classList.add("has-detail");
    el.lessonDrawer.setAttribute("aria-hidden", "false");
    el.lessonDrawer.replaceChildren();

    const root = document.createElement("div");
    root.className = "drawer-content";
    const head = document.createElement("div");
    head.className = "drawer-head";
    const headCopy = document.createElement("div");
    const type = document.createElement("div");
    type.className = "drawer-participant";
    const dot = document.createElement("i");
    dot.className = "drawer-participant-dot";
    dot.style.backgroundColor = participant ? participant.color : "#817b72";
    const typeText = document.createElement("span");
    typeText.textContent = participant ? (participant.type === "group" ? "Группа" : "Ученик") : "Участник";
    type.append(dot, typeText);
    const title = document.createElement("h2");
    title.textContent = `${participant ? participant.name : "Удалённый участник"}${lesson.course ? ` · ${lesson.course}` : ""}`;
    const subtitle = document.createElement("p");
    subtitle.className = "drawer-subtitle";
    subtitle.textContent = `${D.formatDateLong(lesson.displayDateKey, false)} · ${D.timeFromUtc(lesson.startUtc, state.settings.displayOffsetMinutes)}–${D.timeFromUtc(endUtc, state.settings.displayOffsetMinutes)}`;
    headCopy.append(type, title, subtitle);
    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.setAttribute("aria-label", "Закрыть карточку");
    close.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.addEventListener("click", closeDrawer);
    head.append(headCopy, close);
    root.appendChild(head);

    const metaSection = document.createElement("section");
    metaSection.className = "drawer-section";
    const metaTitle = document.createElement("h3");
    metaTitle.textContent = "Урок";
    const meta = document.createElement("div");
    meta.className = "drawer-meta";
    addMeta(meta, "Время", `${D.timeFromUtc(lesson.startUtc, state.settings.displayOffsetMinutes)}–${D.timeFromUtc(endUtc, state.settings.displayOffsetMinutes)}`);
    addMeta(meta, "Продолжительность", `${lesson.durationMinutes} минут`);
    addMeta(meta, "Курс / предмет", lesson.course || "Не указан");
    addMeta(meta, "Формат", FORMAT_LABELS[lesson.format] || lesson.format || "—");
    addMeta(meta, "Исходный пояс", timezoneLabel(lesson.sourceOffsetMinutes == null ? 300 : Number(lesson.sourceOffsetMinutes)));
    if (lesson.formatNote) addMeta(meta, "Ссылка / заметка", lesson.formatNote);
    metaSection.append(metaTitle, meta);
    root.appendChild(metaSection);

    if (lesson.movedFromUtc || lesson.exceptionKind === "moved") {
      const movedSection = document.createElement("section");
      movedSection.className = "drawer-section";
      const movedTitle = document.createElement("h3");
      movedTitle.textContent = "Перенос";
      const moved = document.createElement("p");
      moved.className = "moved-copy";
      const original = lesson.movedFromUtc || lesson.originalStartUtc;
      moved.textContent = `Было: ${D.formatDateShort(D.dateKeyFromUtc(original, state.settings.displayOffsetMinutes))}, ${D.timeFromUtc(original, state.settings.displayOffsetMinutes)}. Стало: ${D.formatDateShort(lesson.displayDateKey)}, ${lesson.displayTime}.`;
      movedSection.append(movedTitle, moved);
      root.appendChild(movedSection);
    }

    const statusSection = document.createElement("section");
    statusSection.className = "drawer-section status-selects";
    const statusTitle = document.createElement("h3");
    statusTitle.textContent = "Статус занятия";
    const lessonStatusBadge = document.createElement("div");
    lessonStatusBadge.className = `lesson-status-badge ${statusClass(lesson.lessonStatus)}`;
    lessonStatusBadge.style.setProperty("--status-color", statusColor(lesson.lessonStatus));
    const lessonStatusDot = document.createElement("i");
    lessonStatusDot.setAttribute("aria-hidden", "true");
    const lessonStatusText = document.createElement("strong");
    lessonStatusText.textContent = STATUS_LABELS[lesson.lessonStatus] || "Запланировано";
    lessonStatusBadge.append(lessonStatusDot, lessonStatusText);
    statusSection.append(statusTitle, lessonStatusBadge, makeDrawerSelect(STATUS_LABELS, lesson.lessonStatus, "lessonStatus"));
    root.appendChild(statusSection);

    const homeworkSection = document.createElement("section");
    homeworkSection.className = "drawer-section";
    const homeworkTitle = document.createElement("h3");
    homeworkTitle.textContent = "Домашнее задание";
    const homework = document.createElement("p");
    homework.className = `homework-copy${lesson.homework ? "" : " is-empty"}`;
    homework.textContent = lesson.homework || "Не задано";
    homeworkSection.append(homeworkTitle, homework);
    root.appendChild(homeworkSection);

    const paymentSection = document.createElement("section");
    paymentSection.className = "drawer-section payment-section";
    const paymentTitle = document.createElement("h3");
    paymentTitle.textContent = "Оплата";
    const paymentSummary = document.createElement("div");
    paymentSummary.className = "payment-summary";
    const paymentAmount = document.createElement("strong");
    paymentAmount.textContent = formatPaymentAmount(lesson.paymentAmount);
    const paymentBadge = document.createElement("span");
    paymentBadge.className = `payment-badge payment-${lesson.paymentStatus || "unpaid"}`;
    paymentBadge.textContent = PAYMENT_LABELS[lesson.paymentStatus] || "Не оплачено";
    paymentSummary.append(paymentAmount, paymentBadge);
    paymentSection.append(paymentTitle, paymentSummary, makeDrawerSelect(PAYMENT_LABELS, lesson.paymentStatus, "paymentStatus"));
    if (lesson.paymentDate || lesson.paymentComment) {
      const paymentExtra = document.createElement("p");
      paymentExtra.className = "payment-extra";
      const paymentDate = lesson.paymentDate ? `Дата оплаты: ${D.formatDateShort(lesson.paymentDate)}` : "Дата оплаты не указана";
      paymentExtra.textContent = lesson.paymentComment ? `${paymentDate}. ${lesson.paymentComment}` : paymentDate;
      paymentSection.appendChild(paymentExtra);
    }
    root.appendChild(paymentSection);

    if (lesson.recurring) {
      const recurrenceSection = document.createElement("section");
      recurrenceSection.className = "drawer-section";
      const recurrenceTitle = document.createElement("h3");
      recurrenceTitle.textContent = "Повторение";
      const recurrenceCopy = document.createElement("p");
      recurrenceCopy.className = "recurrence-copy";
      recurrenceCopy.textContent = Recurrence.describe(seriesById(lesson.seriesId));
      recurrenceSection.append(recurrenceTitle, recurrenceCopy);
      root.appendChild(recurrenceSection);
    }

    const actions = document.createElement("div");
    actions.className = "drawer-actions";
    const edit = actionButton("Редактировать", "secondary-button", openEditLessonDialog);
    const move = actionButton("Перенести", "secondary-button", openMoveDialog);
    const cancel = actionButton("Отменить", "danger-button", openCancelDialog);
    const remove = actionButton(lesson.recurring ? "Удалить…" : "Удалить урок", "danger-button wide", openDeleteDialog);
    actions.append(edit, move, cancel, remove);
    root.appendChild(actions);
    el.lessonDrawer.appendChild(root);
  }

  function addMeta(container, label, value) {
    const item = document.createElement("div");
    const caption = document.createElement("span");
    caption.textContent = label;
    const copy = document.createElement("strong");
    copy.textContent = value;
    item.append(caption, copy);
    container.appendChild(item);
  }

  function actionButton(label, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function updateSelectedField(field, value) {
    const lesson = selectedLesson();
    if (!lesson) return;
    if (lesson.recurring) {
      const kind = field === "lessonStatus" && isCancelled(value) ? "cancelled" : "overridden";
      upsertException(lesson, kind, { [field]: value });
    } else {
      const stored = state.singleLessons.find(function (item) { return item.id === lesson.id; });
      if (stored) { stored[field] = value; stored.updatedAt = nowIso(); }
    }
    persist();
    renderAll();
    showToast(field === "lessonStatus" ? "Статус занятия обновлён" : "Статус оплаты обновлён");
  }

  function upsertException(lesson, kind, overrides) {
    let exception = state.occurrenceExceptions.find(function (item) {
      return item.seriesId === lesson.seriesId && item.originalStartUtc === lesson.originalStartUtc;
    });
    if (!exception) {
      exception = { id: uuid(), seriesId: lesson.seriesId, originalStartUtc: lesson.originalStartUtc, kind, overrides: {}, createdAt: nowIso(), updatedAt: nowIso() };
      state.occurrenceExceptions.push(exception);
    }
    exception.kind = kind;
    exception.overrides = Object.assign({}, exception.overrides || {}, overrides || {});
    exception.updatedAt = nowIso();
    return exception;
  }

  function populateParticipantSelect(selectedId) {
    el.lessonParticipant.replaceChildren();
    el.lessonParticipant.appendChild(optionElement("", "Выберите ученика или группу", !selectedId));
    state.participants
      .filter(function (item) { return !item.archived || item.id === selectedId; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); })
      .forEach(function (participant) {
        const suffix = participant.type === "group" ? " · группа" : "";
        el.lessonParticipant.appendChild(optionElement(participant.id, participant.name + suffix, participant.id === selectedId));
      });
  }

  function nextRoundedTime(offsetMinutes) {
    const parts = D.partsFromUtc(Date.now(), Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : state.settings.displayOffsetMinutes);
    let minutes = Math.ceil((parts.minute + 1) / 30) * 30;
    let hour = parts.hour;
    if (minutes >= 60) { minutes = 0; hour = (hour + 1) % 24; }
    return `${D.pad(hour)}:${D.pad(minutes)}`;
  }

  function resetLessonForm() {
    el.lessonForm.reset();
    el.lessonRepeat.disabled = false;
    el.customDurationField.hidden = true;
    el.repeatFields.hidden = true;
    el.weekdayPicker.hidden = true;
    el.editScopeCard.hidden = true;
    el.conflictWarning.hidden = true;
    el.confirmConflict.checked = false;
    document.querySelectorAll(".field-error").forEach(function (node) { node.textContent = ""; });
    document.querySelectorAll(".field.has-error").forEach(function (node) { node.classList.remove("has-error"); });
  }

  function applyParticipantDefaults(participantId) {
    const participant = participantById(participantId);
    if (!participant) return;
    el.lessonCourse.value = participant.defaultCourse || "";
    setDurationInForm(Number(participant.defaultDurationMinutes || 60));
    el.lessonFormat.value = participant.defaultFormat || "online";
    el.lessonPayment.value = participant.defaultPaymentStatus || "unpaid";
    el.lessonPaymentAmount.value = participant.defaultPaymentAmount == null ? "" : String(participant.defaultPaymentAmount);
    el.lessonHomework.value = participant.defaultHomework || "";
  }

  function openNewLessonDialog(dateKey, participantId) {
    if (!activeParticipantIds().length) {
      showToast("Сначала добавьте ученика или группу");
      openParticipantsDialog();
      return;
    }
    resetLessonForm();
    lessonFormContext = { mode: "new", lesson: null };
    el.lessonDialogTitle.textContent = "Новый урок";
    populateParticipantSelect(participantId || "");
    const defaultSourceOffset = [180, 300].includes(state.settings.displayOffsetMinutes) ? state.settings.displayOffsetMinutes : 300;
    setLessonSourceTimezone(defaultSourceOffset);
    el.lessonDate.value = dateKey || selectedDayKey || D.todayKey(defaultSourceOffset);
    el.lessonTime.value = el.lessonDate.value === D.todayKey(defaultSourceOffset) ? nextRoundedTime(defaultSourceOffset) : "17:00";
    el.lessonDuration.value = "60";
    el.lessonFormat.value = "online";
    el.lessonStatus.value = "scheduled";
    el.lessonPayment.value = "unpaid";
    el.lessonCourse.value = "";
    el.lessonPaymentAmount.value = "";
    if (participantId) {
      el.lessonParticipant.value = participantId;
      applyParticipantDefaults(participantId);
    }
    setDefaultWeekday(el.lessonDate.value);
    dialogDirty = false;
    el.lessonDialog.showModal();
  }

  function openEditLessonDialog() {
    const lesson = selectedLesson();
    if (!lesson) return;
    resetLessonForm();
    lessonFormContext = { mode: "edit", lesson: Storage.clone(lesson) };
    el.lessonDialogTitle.textContent = "Редактировать урок";
    populateParticipantSelect(lesson.participantId);
    el.lessonParticipant.value = lesson.participantId;
    el.lessonCourse.value = lesson.course || "";
    const sourceOffset = Number.isFinite(Number(lesson.sourceOffsetMinutes)) ? Number(lesson.sourceOffsetMinutes) : 300;
    setLessonSourceTimezone(sourceOffset);
    el.lessonDate.value = D.dateKeyFromUtc(lesson.startUtc, sourceOffset);
    el.lessonTime.value = D.timeFromUtc(lesson.startUtc, sourceOffset);
    setDurationInForm(lesson.durationMinutes);
    el.lessonFormat.value = lesson.format || "online";
    el.lessonFormatNote.value = lesson.formatNote || "";
    el.lessonStatus.value = lesson.lessonStatus || "scheduled";
    el.lessonPayment.value = lesson.paymentStatus || "unpaid";
    el.lessonPaymentAmount.value = lesson.paymentAmount == null ? "" : String(lesson.paymentAmount);
    el.lessonHomework.value = lesson.homework || "";
    if (lesson.recurring) {
      const series = seriesById(lesson.seriesId);
      el.lessonRepeat.checked = true;
      el.lessonRepeat.disabled = true;
      el.repeatFields.hidden = false;
      el.editScopeCard.hidden = false;
      fillRecurrenceForm(series, el.lessonDate.value);
    }
    dialogDirty = false;
    el.lessonDialog.showModal();
  }

  function setDurationInForm(minutes) {
    const standard = [30, 45, 60, 90, 120];
    if (standard.includes(Number(minutes))) {
      el.lessonDuration.value = String(minutes);
      el.customDurationField.hidden = true;
    } else {
      el.lessonDuration.value = "custom";
      el.customDuration.value = String(minutes);
      el.customDurationField.hidden = false;
    }
  }

  function setDefaultWeekday(key) {
    el.weekdayPicker.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
      input.checked = Number(input.value) === D.weekday(key);
    });
  }

  function fillRecurrenceForm(series, fallbackDate) {
    if (!series || !series.recurrence) { setDefaultWeekday(fallbackDate); return; }
    const recurrence = series.recurrence;
    if (recurrence.frequency === "monthly") el.repeatFrequency.value = "monthly";
    else if (recurrence.interval === 2) el.repeatFrequency.value = "biweekly";
    else if ((recurrence.weekdays || []).length > 1) el.repeatFrequency.value = "weekdays";
    else el.repeatFrequency.value = "weekly";
    const showWeekdays = el.repeatFrequency.value === "weekdays";
    el.weekdayPicker.hidden = !showWeekdays;
    const selectedDays = (recurrence.weekdays || []).map(Number);
    el.weekdayPicker.querySelectorAll('input[type="checkbox"]').forEach(function (input) { input.checked = selectedDays.includes(Number(input.value)); });
    if (recurrence.untilLocalDate) {
      el.lessonForm.querySelector('input[name="repeatEnd"][value="date"]').checked = true;
      el.repeatUntil.disabled = false;
      el.repeatUntil.value = recurrence.untilLocalDate;
    }
  }

  function recurrenceFromForm(dateKey) {
    const choice = el.repeatFrequency.value;
    const dateWeekday = D.weekday(dateKey);
    let frequency = "weekly";
    let interval = 1;
    let weekdays = [dateWeekday];
    if (choice === "biweekly") interval = 2;
    if (choice === "monthly") { frequency = "monthly"; weekdays = []; }
    if (choice === "weekdays") {
      weekdays = Array.from(el.weekdayPicker.querySelectorAll('input[type="checkbox"]:checked')).map(function (input) { return Number(input.value); });
      if (!weekdays.length) weekdays = [dateWeekday];
      weekdays.sort(function (a, b) { return a - b; });
    }
    const endChoice = el.lessonForm.querySelector('input[name="repeatEnd"]:checked');
    const untilLocalDate = endChoice && endChoice.value === "date" ? el.repeatUntil.value || null : null;
    return { frequency, interval, weekdays, untilLocalDate };
  }

  function readLessonForm() {
    const duration = el.lessonDuration.value === "custom" ? Number(el.customDuration.value) : Number(el.lessonDuration.value);
    const sourceOffsetMinutes = Number(el.lessonSourceTimezone.value);
    return {
      participantId: el.lessonParticipant.value,
      course: el.lessonCourse.value.trim(),
      date: el.lessonDate.value,
      time: el.lessonTime.value,
      startUtc: D.localDateTimeToUtc(el.lessonDate.value, el.lessonTime.value, sourceOffsetMinutes),
      sourceOffsetMinutes,
      durationMinutes: duration,
      format: el.lessonFormat.value,
      formatNote: el.lessonFormatNote.value.trim(),
      lessonStatus: el.lessonStatus.value,
      paymentStatus: el.lessonPayment.value,
      paymentAmount: el.lessonPaymentAmount.value.trim() === "" ? null : Number(el.lessonPaymentAmount.value),
      homework: el.lessonHomework.value.trim(),
      repeat: el.lessonRepeat.checked,
      recurrence: recurrenceFromForm(el.lessonDate.value)
    };
  }

  function showFieldError(name, message) {
    const error = el.lessonForm.querySelector(`[data-error-for="${name}"]`);
    if (error) {
      error.textContent = message;
      const field = error.closest(".field");
      if (field) field.classList.add("has-error");
    }
  }

  function validateLessonForm(data) {
    let valid = true;
    el.lessonForm.querySelectorAll(".field-error").forEach(function (node) { node.textContent = ""; });
    el.lessonForm.querySelectorAll(".field.has-error").forEach(function (node) { node.classList.remove("has-error"); });
    if (!data.participantId) { showFieldError("participantId", "Выберите ученика или группу"); valid = false; }
    if (!data.course) { showFieldError("course", "Укажите курс или предмет"); valid = false; }
    if (!D.parseDateKey(data.date)) { showFieldError("date", "Укажите корректную дату"); valid = false; }
    if (!data.startUtc) { showFieldError("time", "Укажите корректное время"); valid = false; }
    if (!Number.isFinite(data.durationMinutes) || data.durationMinutes < 15 || data.durationMinutes > 480) { showFieldError("duration", "Введите от 15 до 480 минут"); valid = false; }
    if (data.paymentAmount != null && (!Number.isFinite(data.paymentAmount) || data.paymentAmount < 0 || data.paymentAmount > 1000000)) { showFieldError("paymentAmount", "Введите сумму от 0 до 1 000 000 ₽"); valid = false; }
    if (data.repeat && data.recurrence.untilLocalDate && data.recurrence.untilLocalDate < data.date) {
      showToast("Дата окончания серии не может быть раньше первого урока", { error: true });
      valid = false;
    }
    return valid;
  }

  function findConflicts(candidate) {
    if (!candidate.startUtc || isCancelled(candidate.lessonStatus)) return [];
    const candidateDisplayDate = D.dateKeyFromUtc(candidate.startUtc, state.settings.displayOffsetMinutes);
    const parts = D.parseDateKey(candidateDisplayDate);
    const grid = D.getMonthGrid(parts.year, parts.monthIndex);
    const existing = Recurrence.expand(state, grid, state.settings.displayOffsetMinutes);
    const candidateStart = Date.parse(candidate.startUtc);
    const candidateEnd = candidateStart + candidate.durationMinutes * 60_000;
    const editing = lessonFormContext && lessonFormContext.lesson;
    return existing.filter(function (lesson) {
      if (isCancelled(lesson.lessonStatus)) return false;
      if (editing && lesson.instanceId === editing.instanceId) return false;
      const start = Date.parse(lesson.startUtc);
      const end = start + Number(lesson.durationMinutes || 0) * 60_000;
      return candidateStart < end && candidateEnd > start;
    });
  }

  function saveLesson(event) {
    event.preventDefault();
    const data = readLessonForm();
    if (!validateLessonForm(data)) return;
    const conflicts = findConflicts(data);
    if (conflicts.length && !el.confirmConflict.checked) {
      const names = conflicts.slice(0, 3).map(function (lesson) {
        const participant = participantById(lesson.participantId);
        return participant ? participant.name : "другой урок";
      });
      el.conflictWarningText.textContent = `Пересечение: ${names.join(", ")}${conflicts.length > 3 ? ` и ещё ${conflicts.length - 3}` : ""}.`;
      el.conflictWarning.hidden = false;
      el.conflictWarning.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const timestamp = nowIso();
    const wasNewLesson = lessonFormContext.mode === "new";
    if (wasNewLesson) {
      if (data.repeat) {
        state.series.push(makeSeriesFromData(data, timestamp));
      } else {
        state.singleLessons.push(makeSingleFromData(data, timestamp));
      }
    } else {
      applyLessonEdit(data, timestamp);
    }

    const savedDisplayDate = D.dateKeyFromUtc(data.startUtc, state.settings.displayOffsetMinutes);
    const savedDate = D.parseDateKey(savedDisplayDate);
    if (savedDate) {
      selectedDayKey = savedDisplayDate;
      viewMonth = { year: savedDate.year, monthIndex: savedDate.monthIndex };
    }
    revealLessonThroughFilters(data);

    persist();
    dialogDirty = false;
    closeDialog("lessonDialog", true);
    selectedInstanceId = null;
    renderAll();
    if (wasNewLesson) {
      const createdLesson = visibleLessons.find(function (lesson) {
        return lesson.participantId === data.participantId && lesson.startUtc === data.startUtc;
      });
      if (createdLesson) selectLesson(createdLesson.instanceId);
    }
    showToast(wasNewLesson ? "Урок создан и показан в календаре" : "Изменения сохранены");
  }

  function revealLessonThroughFilters(data) {
    const filters = state.settings.filters;
    const participant = participantById(data.participantId);
    if (filters.participantIds.length && !filters.participantIds.includes(data.participantId)) {
      filters.participantIds = filters.participantIds.filter(function (id) { return id !== "__none__"; });
      filters.participantIds.push(data.participantId);
    }
    const allParticipantIds = state.participants.map(function (item) { return item.id; });
    if (filters.participantIds.length && allParticipantIds.every(function (id) { return filters.participantIds.includes(id); })) filters.participantIds = [];
    if (participant && filters.participantTypes.length && !filters.participantTypes.includes(participant.type)) filters.participantTypes = [];
    if (filters.lessonStatuses.length && !filters.lessonStatuses.includes(data.lessonStatus)) filters.lessonStatuses = [];
    if (filters.paymentStatuses.length && !filters.paymentStatuses.includes(data.paymentStatus)) filters.paymentStatuses = [];
  }

  function makeSingleFromData(data, timestamp) {
    return {
      id: uuid(), participantId: data.participantId, startUtc: data.startUtc,
      sourceOffsetMinutes: data.sourceOffsetMinutes, durationMinutes: data.durationMinutes,
      course: data.course, format: data.format, formatNote: data.formatNote, lessonStatus: data.lessonStatus,
      paymentStatus: data.paymentStatus, paymentAmount: data.paymentAmount, paymentDate: data.paymentDate || "",
      paymentComment: data.paymentComment || "", homework: data.homework, movedFromUtc: null, originalLessonId: data.originalLessonId || null,
      createdAt: timestamp, updatedAt: timestamp
    };
  }

  function makeSeriesFromData(data, timestamp, id) {
    return {
      id: id || uuid(), participantId: data.participantId, anchorStartUtc: data.startUtc,
      sourceOffsetMinutes: data.sourceOffsetMinutes, durationMinutes: data.durationMinutes,
      course: data.course, format: data.format, formatNote: data.formatNote, defaultLessonStatus: data.lessonStatus,
      defaultPaymentStatus: data.paymentStatus, defaultPaymentAmount: data.paymentAmount,
      defaultPaymentDate: data.paymentDate || "", defaultPaymentComment: data.paymentComment || "", defaultHomework: data.homework,
      recurrence: data.recurrence, createdAt: timestamp, updatedAt: timestamp
    };
  }

  function applyLessonEdit(data, timestamp) {
    const lesson = lessonFormContext.lesson;
    if (!lesson.recurring) {
      const index = state.singleLessons.findIndex(function (item) { return item.id === lesson.id; });
      if (index < 0) return;
      const previous = state.singleLessons[index];
      if (data.repeat) {
        state.singleLessons.splice(index, 1);
        state.series.push(makeSeriesFromData(Object.assign({}, data, {
          paymentDate: previous.paymentDate || "",
          paymentComment: previous.paymentComment || ""
        }), timestamp));
      } else {
        const createdAt = previous.createdAt;
        state.singleLessons[index] = Object.assign(makeSingleFromData(Object.assign({}, data, {
          paymentDate: previous.paymentDate || "",
          paymentComment: previous.paymentComment || "",
          originalLessonId: previous.originalLessonId || null
        }), timestamp), { id: lesson.id, createdAt, movedFromUtc: previous.movedFromUtc || null });
      }
      return;
    }

    const scope = el.lessonForm.querySelector('input[name="editScope"]:checked').value;
    if (scope === "series") {
      const index = state.series.findIndex(function (item) { return item.id === lesson.seriesId; });
      if (index < 0) return;
      const existingSeries = state.series[index];
      const createdAt = existingSeries.createdAt;
      const scheduleDelta = Date.parse(data.startUtc) - Date.parse(lesson.startUtc);
      const seriesData = Object.assign({}, data, {
        startUtc: new Date(Date.parse(existingSeries.anchorStartUtc) + scheduleDelta).toISOString(),
        sourceOffsetMinutes: scheduleDelta === 0 ? existingSeries.sourceOffsetMinutes : data.sourceOffsetMinutes,
        paymentDate: existingSeries.defaultPaymentDate || "",
        paymentComment: existingSeries.defaultPaymentComment || ""
      });
      state.series[index] = Object.assign(makeSeriesFromData(seriesData, timestamp, lesson.seriesId), { createdAt });
    } else {
      let kind = "overridden";
      if (data.startUtc !== lesson.startUtc) kind = "moved";
      if (isCancelled(data.lessonStatus)) kind = "cancelled";
      upsertException(lesson, kind, {
        participantId: data.participantId, startUtc: data.startUtc, sourceOffsetMinutes: data.sourceOffsetMinutes,
        durationMinutes: data.durationMinutes, course: data.course, format: data.format, formatNote: data.formatNote,
        lessonStatus: data.lessonStatus, paymentStatus: data.paymentStatus, paymentAmount: data.paymentAmount, homework: data.homework,
        movedFromUtc: data.startUtc !== lesson.originalStartUtc ? lesson.originalStartUtc : lesson.movedFromUtc,
        originalLessonId: data.startUtc !== lesson.originalStartUtc ? (lesson.originalLessonId || lesson.instanceId) : lesson.originalLessonId
      });
    }
  }

  function openMoveDialog() {
    const lesson = selectedLesson();
    if (!lesson) return;
    el.moveDate.value = lesson.displayDateKey;
    el.moveTime.value = D.timeFromUtc(lesson.startUtc, state.settings.displayOffsetMinutes);
    el.moveScopeCard.hidden = !lesson.recurring;
    el.moveForm.querySelector('input[name="moveScope"][value="one"]').checked = true;
    el.moveDialog.showModal();
  }

  function moveLesson(event) {
    event.preventDefault();
    const lesson = selectedLesson();
    if (!lesson) return;
    const newStartUtc = D.localDateTimeToUtc(el.moveDate.value, el.moveTime.value, state.settings.displayOffsetMinutes);
    if (!newStartUtc) { showToast("Укажите корректные дату и время", { error: true }); return; }
    if (!lesson.recurring) {
      const stored = state.singleLessons.find(function (item) { return item.id === lesson.id; });
      if (stored) {
        stored.movedFromUtc = stored.movedFromUtc || stored.startUtc;
        stored.originalLessonId = stored.originalLessonId || stored.id;
        stored.startUtc = newStartUtc;
        stored.sourceOffsetMinutes = Number.isFinite(Number(lesson.sourceOffsetMinutes)) ? Number(lesson.sourceOffsetMinutes) : 300;
        stored.lessonStatus = "moved";
        stored.updatedAt = nowIso();
      }
    } else {
      const scope = el.moveForm.querySelector('input[name="moveScope"]:checked').value;
      if (scope === "series") {
        const series = seriesById(lesson.seriesId);
        if (series) {
          const scheduleDelta = Date.parse(newStartUtc) - Date.parse(lesson.startUtc);
          series.anchorStartUtc = new Date(Date.parse(series.anchorStartUtc) + scheduleDelta).toISOString();
          series.sourceOffsetMinutes = Number.isFinite(Number(series.sourceOffsetMinutes)) ? Number(series.sourceOffsetMinutes) : 300;
          series.defaultLessonStatus = "moved";
          if (series.recurrence.frequency === "weekly" && (series.recurrence.weekdays || []).length <= 1) series.recurrence.weekdays = [D.weekday(el.moveDate.value)];
          series.updatedAt = nowIso();
        }
      } else {
        upsertException(lesson, "moved", { startUtc: newStartUtc, sourceOffsetMinutes: Number.isFinite(Number(lesson.sourceOffsetMinutes)) ? Number(lesson.sourceOffsetMinutes) : 300, lessonStatus: "moved", movedFromUtc: lesson.originalStartUtc, originalLessonId: lesson.instanceId });
      }
    }
    persist();
    closeDialog("moveDialog", true);
    selectedInstanceId = null;
    renderAll();
    showToast("Урок перенесён");
  }

  function openCancelDialog() {
    const lesson = selectedLesson();
    if (!lesson) return;
    el.cancelReason.value = isCancelled(lesson.lessonStatus) ? lesson.lessonStatus : "cancelled_student";
    el.cancelScopeCard.hidden = !lesson.recurring;
    el.cancelForm.querySelector('input[name="cancelScope"][value="one"]').checked = true;
    el.cancelDialog.showModal();
  }

  function cancelLesson(event) {
    event.preventDefault();
    const lesson = selectedLesson();
    if (!lesson) return;
    const reason = el.cancelReason.value;
    if (!lesson.recurring) {
      const stored = state.singleLessons.find(function (item) { return item.id === lesson.id; });
      if (stored) { stored.lessonStatus = reason; stored.updatedAt = nowIso(); }
    } else {
      const scope = el.cancelForm.querySelector('input[name="cancelScope"]:checked').value;
      if (scope === "series") {
        const series = seriesById(lesson.seriesId);
        if (series) { series.defaultLessonStatus = reason; series.updatedAt = nowIso(); }
      } else {
        upsertException(lesson, "cancelled", { lessonStatus: reason });
      }
    }
    persist();
    closeDialog("cancelDialog", true);
    renderAll();
    showToast("Урок отмечен как отменённый");
  }

  function openDeleteDialog() {
    const lesson = selectedLesson();
    if (!lesson) return;
    const participant = participantById(lesson.participantId);
    el.deleteDialogCopy.textContent = `Будет удалено занятие «${participant ? participant.name : "Без участника"}» ${D.formatDateShort(lesson.displayDateKey)} в ${lesson.displayTime}.`;
    el.deleteSeriesOption.hidden = !lesson.recurring;
    el.deleteForm.querySelector('input[name="deleteScope"][value="one"]').checked = true;
    el.deleteDialog.showModal();
  }

  function deleteLesson(event) {
    event.preventDefault();
    const lesson = selectedLesson();
    if (!lesson) return;
    const scope = el.deleteForm.querySelector('input[name="deleteScope"]:checked').value;
    setUndoPoint();
    if (lesson.recurring && scope === "series") {
      state.series = state.series.filter(function (item) { return item.id !== lesson.seriesId; });
      state.occurrenceExceptions = state.occurrenceExceptions.filter(function (item) { return item.seriesId !== lesson.seriesId; });
    } else if (lesson.recurring) {
      upsertException(lesson, "deleted", {});
    } else {
      state.singleLessons = state.singleLessons.filter(function (item) { return item.id !== lesson.id; });
    }
    persist();
    closeDialog("deleteDialog", true);
    closeDrawer();
    renderAll();
    showUndoToast(lesson.recurring && scope === "series" ? "Вся серия удалена" : "Урок удалён");
  }

  function openDayDialog(dateKey) {
    selectedDayKey = dateKey;
    el.dayDialog.dataset.date = dateKey;
    el.dayDialogTitle.textContent = D.formatDateLong(dateKey, true);
    el.dayLessonList.replaceChildren();
    const lessons = filteredLessons.filter(function (lesson) { return lesson.displayDateKey === dateKey; });
    if (!lessons.length) {
      const empty = document.createElement("p");
      empty.className = "empty-list";
      empty.textContent = "На этот день занятий нет.";
      el.dayLessonList.appendChild(empty);
    }
    lessons.forEach(function (lesson) {
      const participant = participantById(lesson.participantId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "day-list-button";
      button.style.setProperty("--status-color", statusColor(lesson.lessonStatus));
      button.style.setProperty("--participant-color", participant ? participant.color : "#928b82");
      const time = document.createElement("time");
      time.textContent = lesson.displayTime;
      const name = document.createElement("span");
      name.textContent = `${participant ? participant.name : "Удалённый участник"}${lesson.course ? ` · ${lesson.course}` : ""}`;
      const status = document.createElement("small");
      status.className = "day-lesson-status";
      status.textContent = STATUS_LABELS[lesson.lessonStatus] || "";
      button.append(time, name, status);
      button.addEventListener("click", function () { closeDialog("dayDialog", true); selectLesson(lesson.instanceId); });
      el.dayLessonList.appendChild(button);
    });
    el.dayDialog.showModal();
  }

  function openParticipantsDialog() {
    resetParticipantForm();
    renderParticipantCards();
    dialogDirty = false;
    el.participantsDialog.showModal();
  }

  function resetParticipantForm() {
    el.participantForm.reset();
    el.participantEditId.value = "";
    el.participantType.value = "student";
    el.participantColor.value = "#f5a20a";
    el.participantDefaultDuration.value = "60";
    el.participantDefaultFormat.value = "online";
    el.participantDefaultPayment.value = "unpaid";
    el.participantFormTitle.textContent = "Новая карточка ученика или группы";
    el.participantNameError.textContent = "";
    dialogDirty = false;
  }

  function renderParticipantCards() {
    const search = el.participantSearch.value.trim().toLocaleLowerCase("ru");
    const typeView = el.participantTypeView.value;
    const list = state.participants.filter(function (participant) {
      if (search && !participant.name.toLocaleLowerCase("ru").includes(search)) return false;
      if (typeView === "archived") return participant.archived;
      if (typeView && participant.type !== typeView) return false;
      return !participant.archived;
    }).sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); });

    el.participantCardList.replaceChildren();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = typeView === "archived" ? "Архив пуст" : "Карточек пока нет";
      el.participantCardList.appendChild(empty);
      return;
    }
    list.forEach(function (participant) {
      const card = document.createElement("article");
      card.className = `participant-card${participant.archived ? " is-archived" : ""}`;
      const color = document.createElement("i");
      color.className = "participant-color";
      color.style.backgroundColor = participant.color;
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = participant.name;
      const meta = document.createElement("small");
      const participantMeta = [participant.type === "group" ? "Группа" : "Ученик"];
      if (participant.defaultCourse) participantMeta.push(participant.defaultCourse);
      if (participant.defaultPaymentAmount != null) participantMeta.push(formatPaymentAmount(participant.defaultPaymentAmount));
      if (participant.archived) participantMeta.push("в архиве");
      meta.textContent = participantMeta.join(" · ");
      copy.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "participant-card-actions";
      const addLesson = iconAction("Создать урок", '<svg viewBox="0 0 24 24"><path d="M6 3v3M18 3v3M4 9h16M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM12 12v6M9 15h6"/></svg>', function () { closeDialog("participantsDialog", true); openNewLessonDialog(selectedDayKey, participant.id); });
      const edit = iconAction("Редактировать", '<svg viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20ZM13.5 7.5l3 3"/></svg>', function () { editParticipant(participant.id); });
      const archive = iconAction(participant.archived ? "Восстановить" : "Архивировать", participant.archived ? '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/></svg>', function () { toggleArchive(participant.id); });
      if (!participant.archived) actions.appendChild(addLesson);
      actions.append(edit, archive);
      card.append(color, copy, actions);
      el.participantCardList.appendChild(card);
    });
  }

  function iconAction(label, markup, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = markup;
    button.addEventListener("click", handler);
    return button;
  }

  function editParticipant(id) {
    const participant = participantById(id);
    if (!participant) return;
    el.participantEditId.value = participant.id;
    el.participantType.value = participant.type;
    el.participantName.value = participant.name;
    el.participantColor.value = participant.color;
    el.participantNote.value = participant.note || "";
    el.participantDefaultCourse.value = participant.defaultCourse || "";
    el.participantDefaultDuration.value = String(participant.defaultDurationMinutes || 60);
    el.participantDefaultFormat.value = participant.defaultFormat || "online";
    el.participantDefaultPaymentAmount.value = participant.defaultPaymentAmount == null ? "" : String(participant.defaultPaymentAmount);
    el.participantDefaultPayment.value = participant.defaultPaymentStatus || "unpaid";
    el.participantDefaultHomework.value = participant.defaultHomework || "";
    el.participantFormTitle.textContent = "Редактирование карточки";
    el.participantName.focus();
    dialogDirty = false;
  }

  function saveParticipant(event) {
    event.preventDefault();
    const name = el.participantName.value.trim();
    if (!name) { el.participantNameError.textContent = "Введите имя или название"; return; }
    const timestamp = nowIso();
    const paymentAmount = el.participantDefaultPaymentAmount.value.trim() === "" ? null : Number(el.participantDefaultPaymentAmount.value);
    if (paymentAmount != null && (!Number.isFinite(paymentAmount) || paymentAmount < 0 || paymentAmount > 1000000)) {
      showToast("Стоимость должна быть от 0 до 1 000 000 ₽", { error: true });
      return;
    }
    const id = el.participantEditId.value;
    let savedId = id;
    if (id) {
      const participant = participantById(id);
      if (participant) {
        participant.type = el.participantType.value;
        participant.name = name;
        participant.color = el.participantColor.value;
        participant.note = el.participantNote.value.trim();
        participant.defaultCourse = el.participantDefaultCourse.value.trim();
        participant.defaultDurationMinutes = Number(el.participantDefaultDuration.value || 60);
        participant.defaultFormat = el.participantDefaultFormat.value;
        participant.defaultPaymentAmount = paymentAmount;
        participant.defaultPaymentStatus = el.participantDefaultPayment.value;
        participant.defaultHomework = el.participantDefaultHomework.value.trim();
        participant.updatedAt = timestamp;
      }
    } else {
      savedId = uuid();
      state.participants.push({
        id: savedId, type: el.participantType.value, name, color: el.participantColor.value,
        note: el.participantNote.value.trim(), defaultCourse: el.participantDefaultCourse.value.trim(),
        defaultDurationMinutes: Number(el.participantDefaultDuration.value || 60),
        defaultFormat: el.participantDefaultFormat.value, defaultPaymentAmount: paymentAmount,
        defaultPaymentStatus: el.participantDefaultPayment.value,
        defaultHomework: el.participantDefaultHomework.value.trim(), archived: false,
        createdAt: timestamp, updatedAt: timestamp
      });
    }
    const continueToLesson = !event.submitter || event.submitter.id !== "participantSaveOnly";
    persist();
    resetParticipantForm();
    renderParticipantCards();
    renderFilters();
    renderCalendar();
    if (continueToLesson) {
      closeDialog("participantsDialog", true);
      openNewLessonDialog(selectedDayKey, savedId);
      showToast("Карточка сохранена. Теперь назначьте дату и время урока.");
    } else {
      showToast("Карточка сохранена, но урок ещё не назначен.", {
        duration: 6500,
        actionLabel: "Создать урок",
        onAction: function () {
          closeDialog("participantsDialog", true);
          openNewLessonDialog(selectedDayKey, savedId);
        }
      });
    }
  }

  function toggleArchive(id) {
    const participant = participantById(id);
    if (!participant) return;
    participant.archived = !participant.archived;
    participant.updatedAt = nowIso();
    persist();
    renderParticipantCards();
    renderFilters();
    renderCalendar();
    showToast(participant.archived ? "Карточка перемещена в архив" : "Карточка восстановлена");
  }

  function closeDialog(id, force) {
    const dialog = byId(id);
    if (!dialog || !dialog.open) return;
    if (!force && dialogDirty && (id === "lessonDialog" || id === "participantsDialog")) {
      if (!window.confirm("Есть несохранённые изменения. Закрыть окно?")) return;
    }
    dialogDirty = false;
    dialog.close();
  }

  function exportState(prefix) {
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${prefix || "teacher-calendar"}-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const imported = Storage.normalize(JSON.parse(reader.result));
        const lessonCount = imported.singleLessons.length + imported.series.length;
        const summary = `В файле: ${imported.participants.length} учеников/групп, ${lessonCount} одиночных уроков и серий, ${imported.reportHistory.length} отчётов, ${imported.copyHistory.length} операций копирования. Заменить текущие данные?`;
        if (!window.confirm(summary)) return;
        exportState("teacher-calendar-before-import");
        state = imported;
        selectedInstanceId = null;
        selectedDayKey = D.todayKey(state.settings.displayOffsetMinutes);
        viewMonth = D.monthFromToday(state.settings.displayOffsetMinutes);
        persist();
        renderAll();
        showToast("Данные импортированы");
      } catch (error) {
        showToast(`Не удалось импортировать файл: ${error.message}`, { error: true, duration: 7000 });
      }
    };
    reader.onerror = function () { showToast("Не удалось прочитать файл", { error: true }); };
    reader.readAsText(file, "utf-8");
  }

  function resetAllData() {
    if (!window.confirm("Сбросить все уроки, серии, карточки, оплаты, отчёты, историю копирования и настройки? Сначала рекомендуется сделать экспорт.")) return;
    if (!window.confirm("Это второе подтверждение. Удалить все локальные данные без возможности восстановления?")) return;
    exportState("teacher-calendar-before-reset");
    Storage.clear();
    state = Storage.defaultState();
    persist();
    selectedInstanceId = null;
    selectedDayKey = D.todayKey(state.settings.displayOffsetMinutes);
    viewMonth = D.monthFromToday(state.settings.displayOffsetMinutes);
    renderAll();
    showToast("Все данные сброшены");
  }

  function changeMonth(amount) {
    if (state.settings.calendarView === "week") {
      selectedDayKey = D.addDays(selectedDayKey, amount * 7);
      const selectedParts = D.parseDateKey(selectedDayKey);
      viewMonth = { year: selectedParts.year, monthIndex: selectedParts.monthIndex };
      closeDrawer();
      renderAll();
      return;
    }
    const date = new Date(Date.UTC(viewMonth.year, viewMonth.monthIndex + amount, 1));
    viewMonth = { year: date.getUTCFullYear(), monthIndex: date.getUTCMonth() };
    selectedDayKey = D.dateKey(viewMonth.year, viewMonth.monthIndex, 1);
    closeDrawer();
    renderAll();
  }

  function goToday() {
    viewMonth = D.monthFromToday(state.settings.displayOffsetMinutes);
    selectedDayKey = D.todayKey(state.settings.displayOffsetMinutes);
    renderAll();
  }

  function setCalendarView(calendarView) {
    state.settings.calendarView = calendarView === "week" ? "week" : "month";
    const selectedParts = D.parseDateKey(selectedDayKey);
    if (selectedParts) viewMonth = { year: selectedParts.year, monthIndex: selectedParts.monthIndex };
    persist(false);
    renderAll();
  }

  function openSelectedWeek() {
    const monday = D.mondayFromWeekInput(el.weekPicker.value);
    if (!monday) {
      showToast("Выберите корректную неделю", { error: true });
      el.weekPicker.value = D.weekInputValue(selectedDayKey);
      return;
    }
    selectedDayKey = monday;
    const parts = D.parseDateKey(monday);
    viewMonth = { year: parts.year, monthIndex: parts.monthIndex };
    state.settings.calendarView = "week";
    selectedInstanceId = null;
    persist(false);
    renderAll();
  }

  function showCopiedWeek(targetMonday, createdLessonIds) {
    selectedDayKey = targetMonday;
    const targetParts = D.parseDateKey(targetMonday);
    if (targetParts) viewMonth = { year: targetParts.year, monthIndex: targetParts.monthIndex };
    highlightedCopyIds = new Set(createdLessonIds || []);
    if (highlightedCopyIds.size) {
      state.settings.filters.participantIds = [];
      state.settings.filters.participantTypes = [];
      state.settings.filters.lessonStatuses = [];
      state.settings.filters.paymentStatuses = [];
      persist(false);
    }
    selectedInstanceId = null;
    renderAll();
    window.clearTimeout(copyHighlightTimer);
    if (highlightedCopyIds.size) {
      copyHighlightTimer = window.setTimeout(function () {
        highlightedCopyIds.clear();
        renderCalendar();
      }, 3600);
    }
  }

  function openSidebar() {
    el.sidebar.classList.add("is-open");
    syncOverlay();
  }

  function closeSidebar() {
    el.sidebar.classList.remove("is-open");
    syncOverlay();
  }

  function syncOverlay() {
    const sidebarOverlay = el.sidebar.classList.contains("is-open") && window.innerWidth < 768;
    const drawerOverlay = el.appShell.classList.contains("has-detail") && window.innerWidth <= 1439;
    el.pageOverlay.hidden = !(sidebarOverlay || drawerOverlay);
  }

  function renderAll() {
    renderFilters();
    renderClock();
    renderCalendar();
    renderDrawer();
    if (el.participantsDialog.open) renderParticipantCards();
    if (TC.Payments) TC.Payments.refresh();
    if (TC.WeekCopy) TC.WeekCopy.refreshHistory();
    syncOverlay();
  }

  function attachEvents() {
    el.prevMonthButton.addEventListener("click", function () { changeMonth(-1); });
    el.nextMonthButton.addEventListener("click", function () { changeMonth(1); });
    el.monthViewButton.addEventListener("click", function () { setCalendarView("month"); });
    el.weekViewButton.addEventListener("click", function () { setCalendarView("week"); });
    el.todayButton.addEventListener("click", goToday);
    el.weekPicker.addEventListener("change", openSelectedWeek);
    el.timezoneLeft.addEventListener("click", function () { shiftTimezone(-60); });
    el.timezoneRight.addEventListener("click", function () { shiftTimezone(60); });
    el.addLessonButton.addEventListener("click", function () { openNewLessonDialog(selectedDayKey); });
    el.calendarNavButton.addEventListener("click", showCalendarSection);
    el.paymentsNavButton.addEventListener("click", showPaymentsSection);
    el.manageParticipantsButton.addEventListener("click", function () { closeSidebar(); openParticipantsDialog(); });
    el.sidebarOpen.addEventListener("click", openSidebar);
    el.paymentSidebarOpen.addEventListener("click", openSidebar);
    el.sidebarClose.addEventListener("click", closeSidebar);
    el.pageOverlay.addEventListener("click", function () { closeSidebar(); closeDrawer(); });
    window.addEventListener("resize", syncOverlay);

    el.clearFiltersButton.addEventListener("click", clearFilters);
    el.allParticipantsFilter.addEventListener("change", function () { state.settings.filters.participantIds = el.allParticipantsFilter.checked ? [] : ["__none__"]; persist(false); renderAll(); });
    el.typeFilter.addEventListener("change", function () { state.settings.filters.participantTypes = el.typeFilter.value ? [el.typeFilter.value] : []; persist(false); renderAll(); });
    el.statusFilter.addEventListener("change", function () { state.settings.filters.lessonStatuses = el.statusFilter.value ? [el.statusFilter.value] : []; persist(false); renderAll(); });
    el.paymentFilter.addEventListener("change", function () { state.settings.filters.paymentStatuses = el.paymentFilter.value ? [el.paymentFilter.value] : []; persist(false); renderAll(); });

    document.querySelectorAll("[data-close-dialog]").forEach(function (button) {
      button.addEventListener("click", function () { closeDialog(button.dataset.closeDialog, false); });
    });
    [el.lessonDialog, el.participantsDialog].forEach(function (dialog) {
      dialog.addEventListener("cancel", function (event) { event.preventDefault(); closeDialog(dialog.id, false); });
    });

    el.lessonForm.addEventListener("submit", saveLesson);
    el.lessonForm.addEventListener("input", function () { dialogDirty = true; el.conflictWarning.hidden = true; el.confirmConflict.checked = false; });
    el.lessonParticipant.addEventListener("change", function () {
      if (lessonFormContext && lessonFormContext.mode === "new") applyParticipantDefaults(el.lessonParticipant.value);
    });
    el.lessonDuration.addEventListener("change", function () { el.customDurationField.hidden = el.lessonDuration.value !== "custom"; });
    el.lessonRepeat.addEventListener("change", function () { el.repeatFields.hidden = !el.lessonRepeat.checked; if (el.lessonRepeat.checked) setDefaultWeekday(el.lessonDate.value); });
    el.repeatFrequency.addEventListener("change", function () { el.weekdayPicker.hidden = el.repeatFrequency.value !== "weekdays"; });
    el.lessonDate.addEventListener("change", function () { if (el.repeatFrequency.value !== "weekdays") setDefaultWeekday(el.lessonDate.value); });
    el.lessonForm.querySelectorAll('input[name="repeatEnd"]').forEach(function (radio) {
      radio.addEventListener("change", function () { el.repeatUntil.disabled = radio.value !== "date" || !radio.checked; });
    });

    el.participantForm.addEventListener("submit", saveParticipant);
    el.participantForm.addEventListener("input", function () { dialogDirty = true; el.participantNameError.textContent = ""; });
    el.participantFormReset.addEventListener("click", resetParticipantForm);
    el.participantSearch.addEventListener("input", renderParticipantCards);
    el.participantTypeView.addEventListener("change", renderParticipantCards);

    el.moveForm.addEventListener("submit", moveLesson);
    el.cancelForm.addEventListener("submit", cancelLesson);
    el.deleteForm.addEventListener("submit", deleteLesson);
    el.addLessonForDay.addEventListener("click", function () { const date = el.dayDialog.dataset.date; closeDialog("dayDialog", true); openNewLessonDialog(date); });

    el.exportButton.addEventListener("click", function () { exportState("teacher-calendar"); showToast("Резервная копия подготовлена"); });
    el.importButton.addEventListener("click", function () { el.importFileInput.click(); });
    el.importFileInput.addEventListener("change", importFile);
    el.resetButton.addEventListener("click", resetAllData);

    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        openNewLessonDialog(selectedDayKey);
      }
    });
  }

  function init() {
    cacheElements();
    if (TC.Payments) {
      TC.Payments.init({
        getState: function () { return state; },
        save: function () { persist(); renderFilters(); renderCalendar(); renderDrawer(); },
        toast: function (message, isError) { showToast(message, { error: Boolean(isError) }); },
        openLesson: openLessonFromPayments
      });
    }
    if (TC.WeekCopy) {
      TC.WeekCopy.init({
        getState: function () { return state; },
        save: function () { const saved = persist(); renderAll(); return saved; },
        toast: function (message, isError) { showToast(message, { error: Boolean(isError) }); },
        toastAction: function (message, actionLabel, onAction) { showToast(message, { actionLabel, onAction, duration: 7000 }); },
        getSelectedDayKey: function () { return selectedDayKey; },
        showCopiedWeek
      });
    }
    attachEvents();
    renderAll();
    window.setInterval(renderClock, 1000);
    if (loaded.error) showToast("Локальное хранилище недоступно или повреждено. Приложение открыто с пустыми данными.", { error: true, duration: 9000 });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
